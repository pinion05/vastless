#!/usr/bin/env node
// vastless installer — `npx vastless init`
// 원샷: 사전요구 검사 → 볼륨/GPU 오퍼 탐색·생성 → llama.cpp 빌드 + 모델 다운로드
//       → config.sh 생성 → 게이트웨이 기동 → 스모크
import { execSync, spawn } from "child_process";
import { createInterface } from "readline/promises";
import fs from "fs";
import path from "path";
import os from "os";

const c = { g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[36m", r: "\x1b[31m", x: "\x1b[0m", bold: "\x1b[1m" };
const log = (m) => console.log(m);
const ok = (m) => console.log(`${c.g}✓${c.x} ${m}`);
const warn = (m) => console.log(`${c.y}!${c.x} ${m}`);
const die = (m) => { console.error(`${c.r}✗ ${m}${c.x}`); process.exit(1); };
const banner = () => console.log(`\n${c.bold}${c.b}vastless${c.x} — serverless OpenAI LLM on vast.ai spot GPUs\n`);

const VASTLESS_DIR = path.join(os.homedir(), ".vastless");
const CTL = path.join(import.meta.dirname, "..", "vastless-ctl");
const SETUP = path.join(import.meta.dirname, "..", "setup-volume.sh");

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", opts.stderr ? "inherit" : "pipe"], ...opts }).toString().trim();
const run = async (cmd, args, { silent = false } = {}) => new Promise((res) => {
  const p = spawn(cmd, args, { stdio: silent ? "pipe" : "inherit" });
  p.on("exit", (code) => res(code ?? 1));
});

// ── 1. prereqs ──
async function checkPrereqs(rl) {
  log(`\n${c.bold}[1/7] 사전요구 검사${c.x}`);
  let vastai = "vastai";
  try { sh("command -v vastai"); } catch {
    try { vastai = path.join(os.homedir(), ".local/bin/vastai"); sh(`${vastai} --version`); }
    catch { warn("vastai CLI 없음 — pipx install vastai 시도");
      await run("pipx", ["install", "vastai"]);
      vastai = path.join(os.homedir(), ".local/bin/vastai");
    }
  }
  const ver = sh(`${vastai} --version`).catch?.() ?? sh(`${vastai} --version`);
  ok(`vastai CLI (${ver})`);
  try { sh(`${vastai} show user --raw | head -c1`); ok("API 키 등록됨"); }
  catch { die("vast.ai API 키 없음. 먼저: vastai set-api-key <KEY>"); }
  try { sh("node --version"); ok(`node ${sh("node --version")}`); }
  catch { die("Node.js 18+ 필요"); }
  return vastai;
}

// ── 2. GPU + 볼륨 오퍼 탐색 ──
async function findOffers(vastai, rl) {
  log(`\n${c.bold}[2/7] 볼륨+GPU 조합 탐색 (볼륨은 같은 머신의 인스턴스에만 붙음)${c.x}`);
  const vols = JSON.parse(sh(`${vastai} search volumes --raw`));
  const byMachine = {};
  for (const v of vols) (byMachine[v.machine_id] ||= []).push(v);
  // 검색 API는 페이지 상한이 있어 볼륨 머신을 놓친다 — 머신 단위 개별 조회가 정확
  const combos = [];
  const mids = Object.keys(byMachine);
  log(`  볼륨 제공 머신 ${mids.length}대 조회 중...`);
  for (const mid of mids) {
    try {
      // vast 검색 쿼리는 복합 조건을 무시하는 경우가 있음 — machine_id만 조회 후 JS 필터 (실증)
      const offers = JSON.parse(sh(`${vastai} search offers 'machine_id=${mid}' --raw`));
      for (const o of offers) {
        if (o.dph_total > 0 && o.num_gpus === 1 && o.gpu_ram > 19000 && (o.reliability ?? 0) > 0.98)
          combos.push({ offer: o, volume: byMachine[mid][0] });
      }
    } catch { /* 해당 머신 GPU 오퍼 없음 */ }
  }
  combos.sort((a, b) => a.offer.dph_total - b.offer.dph_total);
  if (!combos.length) die("볼륨+GPU 조합이 하나도 없음 — 나중에 재시도하거나 수동 구성(README 참고)");
  log("  후보 (저가순):");
  combos.slice(0, 8).forEach((cm, i) => {
    const o = cm.offer;
    log(`  [${i}] ${o.gpu_name.padEnd(20)} $${o.dph_total.toFixed(3)}/hr  VRAM=${(o.gpu_ram/1024)|0}GB  rel=${(o.reliability??0).toFixed(2)}  ${o.geolocation||"?"}  (volume $${(cm.volume.storage_total_cost*1000).toFixed(3)}/GB·mo)`);
  });
  const pick = await rl.question(`  선택 [0-${Math.min(7, combos.length-1)}, 기본 0]: `);
  const idx = pick.trim() === "" ? 0 : parseInt(pick);
  return combos[idx] ?? combos[0];
}

// ── 3. 볼륨 생성 ──
async function createVolume(vastai, combo, rl) {
  const o = combo.offer, v = combo.volume;
  log(`\n${c.bold}[3/7] 볼륨 생성${c.x}`);
  const existing = JSON.parse(sh(`${vastai} show volumes --raw`));
  const mine = existing.find((e) => e.machine_id === o.machine_id);
  if (mine) { ok(`기존 볼륨 재사용: ${mine.id} (${mine.label || ""})`); return mine.id; }
  const name = `vastless_${Date.now().toString(36)}`;
  let id = null;
  try {
    const out = sh(`${vastai} create volume ${v.id} -s 100 -n ${name} --raw`);
    const d = JSON.parse(out);
    id = d.id ?? d.new_volume ?? d.volume_id ?? null;
  } catch { /* 아래 역추적으로 */ }
  if (!id) {
    // 생성은 됐지만 응답 스키마가 다른 경우: 라벨로 역추적
    await new Promise((r) => setTimeout(r, 3000));
    const list = JSON.parse(sh(`${vastai} show volumes --raw`));
    const found = list.find((e) => e.label === name);
    if (!found) die("볼륨 생성 확인 실패 — vastai show volumes에서 확인 후 재실행");
    id = found.id;
  }
  ok(`볼륨 ${id} (${name}, 100GB) 생성 — 월 ~$3`);
  return id;
}

// ── 4. 모델 선택 ──
async function askModel(rl) {
  log(`\n${c.bold}[4/7] 모델 선택${c.x}`);
  log("  [0] Nex-N2.5-mini-Uncensored 35B MoE IQ4_XS (18.7GB) — 269 t/s 실측, gated(HF 승인 필요)");
  log("  [1] 커스텀 GGUF URL 직접 입력");
  const pick = await rl.question(`  선택 [0/1, 기본 0]: `);
  if (pick.trim() === "1") {
    const url = await rl.question("  GGUF URL (https://huggingface.co/.../*.gguf): ");
    return url.trim();
  }
  return "https://huggingface.co/orcarouter/Nex-N2.5-mini-Uncensored-GGUF/resolve/main/Nex-N2.5-mini-Uncensored-IQ4_XS.gguf";
}

// ── 5. 시딩 인스턴스 + 빌드 ──
async function seedVolume(vastai, combo, volId, modelUrl, rl) {
  const o = combo.offer;
  log(`\n${c.bold}[5/7] 시딩 인스턴스 — llama.cpp 빌드 + 모델 다운로드 (10~20분)${c.x}`);
  const token = await rl.question("  HF 토큰 (gated 모델용, 생략 가능): ");
  // 아키텍처 감지: compute_cap 필드 활용
  const cc = o.compute_cap || 120;
  const arch = cc >= 120 ? 120 : cc >= 89 ? 89 : cc >= 80 ? 80 : 70;
  const img = cc >= 120 ? "nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04" : "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04";
  log(`  GPU ${o.gpu_name} (cc ${cc}) → CUDA arch ${arch}, 이미지 ${img}`);
  const out = sh(`${vastai} create instance ${o.id} --image ${img} --disk 10 --ssh --link-volume ${volId} --mount-path /root/models --raw`);
  const iid = JSON.parse(out).new_contract ?? JSON.parse(out).instance;
  ok(`인스턴스 ${iid} 생성 — running 대기`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const st = JSON.parse(sh(`${vastai} show instance ${iid} --raw`)).actual_status;
    if (st === "running") break;
    if (i % 4 === 3) log(`  ... ${st}`);
  }
  // SSH 접속정보
  const inst = JSON.parse(sh(`${vastai} show instance ${iid} --raw`));
  const sshCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_vastai -p ${inst.ssh_port} root@${inst.ssh_host}`;
  log(`  SSH 대기 + 셋업 전송...`);
  for (let i = 0; i < 30; i++) {
    try { sh(`${sshCmd} true`, { stdio: "pipe" }); break; }
    catch { await new Promise((r) => setTimeout(r, 10000)); }
  }
  sh(`${sshCmd} 'mkdir -p /root' `);
  execSync(`${sshCmd} 'cat > /root/setup.sh' < ${SETUP}`, { stdio: "inherit" });
  log(`  빌드+다운로드 실행 (로그는 인스턴스 /root/setup.log)...`);
  const env = token.trim() ? `HF_TOKEN=${token.trim()}` : "";
  sh(`${sshCmd} '${env} nohup bash /root/setup.sh ${modelUrl} ${arch} > /root/nohup.log 2>&1 &'`);
  log(`  ${c.y}진행 확인: ${sshCmd} 'tail -f /root/setup.log'${c.x}`);
  // 완료 대기 (SETUP-ALL-DONE / VOLUME-SETUP-DONE 마커)
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 20000));
    try {
      const tail = sh(`${sshCmd} 'tail -3 /root/setup.log'`, { stdio: "pipe" });
      if (/VOLUME-SETUP-DONE|error/i.test(tail)) {
        if (/error/i.test(tail) && !/VOLUME-SETUP-DONE/.test(tail)) die(`셋업 실패:\n${tail}`);
        break;
      }
      if (i % 6 === 5) log(`  ... ${tail.split("\n").pop().slice(0, 90)}`);
    } catch { /* ssh 재시도 */ }
  }
  ok("볼륨 시딩 완료");
  sh(`${vastai} destroy instance ${iid} -y`);
  ok(`시딩 인스턴스 ${iid} 파기 (볼륨은 유지)`);
}

// ── 6. config 생성 ──
async function writeConfig(combo, volId, modelUrl) {
  log(`\n${c.bold}[6/7] config.sh 생성${c.x}`);
  fs.mkdirSync(VASTLESS_DIR, { recursive: true });
  const fname = path.basename(new URL(modelUrl).pathname);
  const cfg = `# vastless config (generated ${new Date().toISOString()})
OFFER_ID=${combo.offer.id}
VOLUME_ID=${volId}
MOUNT_PATH=/root/models
IMAGE=${combo.offer.compute_cap >= 120 ? "nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04" : "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04"}
DISK_GB=10
LLAMA_PORT=8080
MODEL_PATH=/root/models/llm/${fname}
ONSTART="nohup /root/models/llm/llama.cpp/build/bin/llama-server -m /root/models/llm/${fname} -ngl 99 -c 262144 -fa on --host 0.0.0.0 --port 8080 > /root/server.log 2>&1 &"
STATE="${path.join(VASTLESS_DIR, "state.json")}"
VASTAI="${path.join(os.homedir(), ".local/bin/vastai")}"
`;
  const cfgPath = path.join(import.meta.dirname, "..", "config.sh");
  fs.writeFileSync(cfgPath, cfg);
  ok(`${cfgPath}`);
}

// ── 7. 기동 + 스모크 ──
async function startAndSmoke() {
  log(`\n${c.bold}[7/7] 게이트웨이 기동 + 스모크${c.x}`);
  const port = 8790;
  log(`  npm install...`);
  await run("npm", ["install", "--silent"], { silent: true });
  log(`  게이트웨이 백그라운드 기동 (:${port})...`);
  const gw = spawn("node", ["--experimental-strip-types", "gateway.ts"], {
    cwd: import.meta.dirname + "/..",
    env: { ...process.env, VASTLESS_PORT: String(port) },
    detached: true, stdio: "ignore",
  });
  gw.unref();
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const models = JSON.parse(sh(`curl -s -m 5 http://127.0.0.1:${port}/v1/models`));
    ok(`/v1/models → ${models.data[0].id} (ctx ${models.data[0].context_length})`);
  } catch { warn("게이트웨이 헬스체크 실패 — 수동 확인: npm start"); }
  log(`\n${c.g}${c.bold}완료!${c.x}`);
  log(`  대시보드:   http://localhost:${port}`);
  log(`  API:        http://localhost:${port}/v1  (OpenAI 호환, model: nex)`);
  log(`  첫 호출 시 GPU 자동 런치 (~40초), 10분 유휴 시 자동 파기`);
  log(`  systemd 등록: systemctl --user enable --now ~/.config/systemd/user/… (README 참고)\n`);
}

// ── main ──
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  banner();
  try {
    const vastai = await checkPrereqs(rl);
    const combo = await findOffers(vastai, rl);
    const volId = await createVolume(vastai, combo, rl);
    const modelUrl = await askModel(rl);
    await seedVolume(vastai, combo, volId, modelUrl, rl);
    await writeConfig(combo, volId, modelUrl);
    await startAndSmoke();
  } finally { rl.close(); }
}
main().catch((e) => die(e?.stack || String(e)));
