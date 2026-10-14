// provision.ts — vastless state machine v2
// 예산 내 오퍼 자동검색 → 랭킹 체인 → 런치 (스톨 가드) → 같은머신 폴백 → (옵션) 타머신 재시딩 폴백
import { execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import http from "http";
import os from "os";
import path from "path";

// ── config ──
export const P = {
  port: parseInt(process.env.VASTLESS_PORT || "8790", 10),
  statePath: process.env.VASTLESS_STATE || path.join(os.homedir(), ".vastless", "state.json"),
  maxUsdHr: parseFloat(process.env.VASTLESS_MAX_USD_HR || "0.80"),
  minVramGb: parseInt(process.env.VASTLESS_MIN_VRAM_GB || "24", 10),
  reseed: (process.env.VASTLESS_RESEED ?? "1") === "1",
  loadingTimeoutMs: parseInt(process.env.VASTLESS_LOADING_TIMEOUT_MIN || "8", 10) * 60_000,
  llamaPort: parseInt(process.env.VASTLESS_LLAMA_PORT || "8080", 10),
  ctxLen: parseInt(process.env.VASTLESS_CTX || "262144", 10),
  modelId: process.env.VASTLESS_MODEL_ID || "nex",
  repoDir: process.env.VASTLESS_REPO || import.meta.dirname,
};

// config.sh 파싱 (KEY=VALUE, 따옴표 옵션) — ctl과 단일 소스
const CFG: Record<string, string> = {};
try {
  const cfgPath = path.join(P.repoDir, "config.sh");
  if (existsSync(cfgPath)) {
    for (const m of readFileSync(cfgPath, "utf8").matchAll(/^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^\n]*))$/gm))
      CFG[m[1]] = m[2] ?? m[3] ?? (m[4] ?? "").trim();
  }
} catch { /* no config — tier1 비활성 */ }
const cfg = (k: string, d = "") => CFG[k] ?? d;

// ── types & state ──
export type Offer = {
  offer_id: number; machine_id: number; gpu: string; vram_gb: number; usd_hr: number;
  reliability: number; geo: string; compute_cap: number; same_machine: boolean; needs_reseed: boolean;
  volume_offer_id?: number;
};
export type State = {
  v: 2;
  phase: "idle" | "launching" | "seeding" | "ready" | "failed";
  volume: { id: number | null; machine_id: number | null; size_gb: number; seeded_model: string | null };
  chain: Offer[];
  chain_idx: number;
  pinned_offer: number | null;
  instance: { iid: number; ip: string; port: string; offer: Offer | null; dph: number; since: number } | null;
  budget: { max_usd_hr: number; spent_usd: number; last_tick: number | null };
  events: { ts: string; msg: string }[];
  err: string | null;
};

const ev = (s: State, msg: string) => {
  s.events.push({ ts: new Date().toISOString().slice(11, 19), msg });
  if (s.events.length > 60) s.events.splice(0, s.events.length - 60);
  console.log(`[provision] ${msg}`);
};

function defaultState(): State {
  const volId = parseInt(cfg("VOLUME_ID", "0")) || null;
  return {
    v: 2, phase: "idle",
    volume: { id: volId, machine_id: null, size_gb: 100, seeded_model: cfg("MODEL_PATH") ? path.basename(cfg("MODEL_PATH")) : null },
    chain: [], chain_idx: 0, pinned_offer: null, instance: null,
    budget: { max_usd_hr: P.maxUsdHr, spent_usd: 0, last_tick: null },
    events: [], err: null,
  };
}

export function readState(): State {
  try {
    const s = JSON.parse(readFileSync(P.statePath, "utf8"));
    if (s?.v === 2) return s;
    if (s?.iid) { // v1 마이그레이션 (iid/ip/port 포인터)
      const d = defaultState();
      d.instance = { iid: s.iid, ip: s.ip ?? "", port: s.port ?? "", offer: null, dph: 0, since: Date.now() };
      return d;
    }
  } catch { /* fresh */ }
  return defaultState();
}
export function writeState(s: State) {
  mkdirSync(path.dirname(P.statePath), { recursive: true });
  writeFileSync(P.statePath, JSON.stringify(s));
}

// ── vast.ai exec ──
const VASTAI = process.env.VASTAI || path.join(os.homedir(), ".local/bin/vastai");
const vast = (args: string[], timeoutMs = 30_000): Promise<any> =>
  new Promise((resolve) =>
    execFile(VASTAI, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, so) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse((so || "").trim())); } catch { resolve(null); }
    }));

export async function volumeMachineId(volId: number): Promise<number | null> {
  const vols = await vast(["show", "volumes", "--raw"]);
  const v = (Array.isArray(vols) ? vols : []).find((x: any) => x.id === volId);
  return v?.machine_id ?? null;
}

// ── offer search: 예산 내 후보 랭킹 ──
// 계층1: 시딩된 볼륨의 머신 (즉시 사용) / 계층2: 볼륨 호스팅 머신 교집합 (재시딩 필요)
// 볼륨은 머신 단위로만 붙으므로, 계층2는 '볼륨 제공 머신'의 GPU 오퍼만 대상 (실증: 일반 GPU 머신 대다수는 볼륨 불가)
export async function refreshChain(s: State): Promise<Offer[]> {
  const volMachine = s.volume.machine_id ?? (s.volume.id ? await volumeMachineId(s.volume.id) : null);
  s.volume.machine_id = volMachine;
  const mk = (o: any, same: boolean): Offer => ({
    offer_id: o.id, machine_id: o.machine_id, gpu: o.gpu_name, vram_gb: Math.round(o.gpu_ram / 1024),
    usd_hr: o.dph_total, reliability: o.reliability ?? 0, geo: o.geolocation || "?",
    compute_cap: o.compute_cap || 80, same_machine: same, needs_reseed: !same,
  });
  const pass = (o: any) =>
    o.num_gpus === 1 && o.gpu_ram >= P.minVramGb * 1024 &&
    o.dph_total > 0 && o.dph_total <= P.maxUsdHr && (o.reliability ?? 0) > 0.97;
  let chain: Offer[] = [];

  // 계층1: 같은 머신 (시딩된 볼륨) — 머신 단위 직접 조회 (전역 가격정렬 페이지 상한이 비싼 동일머신 오퍼를 누락시킴: 실증)
  if (volMachine) {
    const raw = await vast(["search", "offers", `machine_id=${volMachine}`, "--raw"], 30_000);
    chain.push(...(Array.isArray(raw) ? raw : []).filter((o: any) => pass(o)).map((o: any) => mk(o, true)));
  }
  // 계층2: 볼륨 호스팅 머신 교집합 — 머신별 조회 8-웨이 병렬 (인스톨러 방식, 페이지 상한 회피)
  if (P.reseed) {
    const vols = await vast(["search", "volumes", "--raw"], 30_000);
    const volByMid = new Map<number, any>();
    for (const v of Array.isArray(vols) ? vols : []) volByMid.set(v.machine_id, v);
    const hostMids = [...volByMid.keys()].filter((m: number) => m !== volMachine);
    const results: Offer[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < hostMids.length) {
        const mid = hostMids[cursor++];
        const offers = await vast(["search", "offers", `machine_id=${mid}`, "--raw"], 25_000);
        for (const o of Array.isArray(offers) ? offers : [])
          if (pass(o)) results.push({ ...mk(o, false), volume_offer_id: volByMid.get(mid)?.id });
      }
    };
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(worker));
    results.sort((a, b) => a.usd_hr - b.usd_hr || b.reliability - a.reliability);
    chain.push(...results.slice(0, 6)); // 재시딩 폴백 상위 6개만
  }
  s.chain = chain;
  const nSame = chain.filter((c) => c.same_machine).length;
  ev(s, `체인 갱신: 후보 ${chain.length}개 (같은머신 ${nSame} + 재시딩 ${chain.length - nSame}, 예산 ≤$${P.maxUsdHr}/hr, VRAM ≥${P.minVramGb}GB)`);
  return chain;
}

// ── instance launch (직접 vast API — offer/볼륨/이미지 완전 제어) ──
function onstartCmd(o: Offer): string {
  const model = cfg("MODEL_PATH", "/root/models/llm/model.gguf");
  // 24GB 카드는 256K KV로 OOM → VRAM에 따라 ctx 축소 (실측: 32GB=23.9GB@256K, 24GB=21.2GB@128K)
  const ctx = o.vram_gb >= 31 ? P.ctxLen : Math.min(P.ctxLen, 131072);
  return `nohup /root/models/llm/llama.cpp/build/bin/llama-server -m ${model} -ngl 99 -c ${ctx} -fa on --host 0.0.0.0 --port ${P.llamaPort} > /root/server.log 2>&1 &`;
}
const imageFor = (cc: number) => cc >= 120 ? "nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04" : "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04";

async function launchOn(s: State, o: Offer, volId: number): Promise<number | null> {
  const r = await vast(["create", "instance", String(o.offer_id),
    "--image", imageFor(o.compute_cap), "--disk", cfg("DISK_GB", "10"), "--ssh",
    "--link-volume", String(volId), "--mount-path", "/root/models",
    "--env", `-p ${P.llamaPort}:${P.llamaPort}`,
    "--onstart-cmd", onstartCmd(o), "--raw"], 60_000);
  const iid = r?.instance ?? r?.new_contract ?? null;
  if (iid) ev(s, `런치 iid ${iid} ← ${o.gpu} $${o.usd_hr.toFixed(3)}/hr ${o.geo}${o.same_machine ? "" : " (재시딩 머신)"}`);
  else ev(s, `런치 실패 (${o.offer_id}): ${JSON.stringify(r)?.slice(0, 120)}`);
  return iid;
}

// ── 상태폴링: running 도달 or 스톨 가드(파기) ──
async function waitRunning(s: State, iid: number, timeoutMs = P.loadingTimeoutMs): Promise<{ ip: string; port: string; dph: number } | null> {
  const t0 = Date.now();
  let lastSt = "";
  while (Date.now() - t0 < timeoutMs) {
    await sleep(15_000);
    const inst = await vast(["show", "instance", String(iid), "--raw"], 20_000);
    const st = inst?.actual_status ?? inst?.status ?? "?";
    if (st !== lastSt) { ev(s, `iid ${iid}: ${st}`); lastSt = st; }
    if (st === "running") {
      const ip = inst.public_ipaddr || inst.ip_address || "";
      const hp = (inst.ports?.[`${P.llamaPort}/tcp`]?.[0]?.HostPort) || "";
      if (ip && hp) return { ip, port: hp, dph: inst.dph_total ?? 0 };
    }
    if (["error", "dead", "exited"].includes(st)) return null;
  }
  ev(s, `스톨 가드: iid ${iid} ${Math.round(timeoutMs / 60000)}분 내 running 미도달 → 파기`);
  await vast(["destroy", "instance", String(iid), "-y"], 30_000);
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── health ──
export function healthProbe(ip: string, port: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((res) => {
    const r = http.get({ host: ip, port: parseInt(port), path: "/health", timeout: timeoutMs },
      (hr) => { let b = ""; hr.on("data", (c) => (b += c)); hr.on("end", () => res(b.includes("ok"))); });
    r.on("error", () => res(false));
    r.on("timeout", () => { r.destroy(); res(false); });
  });
}

// ── 비용 누적 (dph × 경과시간) ──
function tickSpend(s: State) {
  const now = Date.now();
  if (s.instance?.dph && s.budget.last_tick) {
    s.budget.spent_usd += (s.instance.dph * (now - s.budget.last_tick)) / 3_600_000;
  }
  s.budget.last_tick = s.instance && s.phase === "ready" ? now : null;
}

// ── 라이브 인스턴스 감지 (gateway state와 무관하게 계정 전수조사) — 5s TTL 캐시 (대시보드 폴링 과다 방지) ──
let _liveCache: { at: number; val: Awaited<ReturnType<typeof _liveInstance>> } | null = null;
export async function liveInstance() {
  if (_liveCache && Date.now() - _liveCache.at < 5_000) return _liveCache.val;
  const val = await _liveInstance();
  _liveCache = { at: Date.now(), val };
  return val;
}
async function _liveInstance(): Promise<{ iid: number; ip: string; port: string; dph: number; status: string } | null> {
  const insts = await vast(["show", "instances", "--raw"], 25_000);
  for (const d of Array.isArray(insts) ? insts : []) {
    const st = d.actual_status ?? d.status ?? "";
    if (["exited", "dead", "error"].includes(st)) continue;
    const ip = d.public_ipaddr || "";
    const hp = d.ports?.[`${P.llamaPort}/tcp`]?.[0]?.HostPort || "";
    return { iid: d.id, ip, port: hp, dph: d.dph_total ?? 0, status: st };
  }
  return null;
}

// ── 메인 수명주기: 체인 순회 런치 ──
let provisioning = false;
const failedOffers = new Set<number>(); // 이 세션에서 런치/시딩 실패한 오퍼 (머신 상태 나쁨) — 재시도 방지
export async function ensureServing(s: State): Promise<boolean> {
  tickSpend(s);
  const live = await liveInstance();
  if (live && live.status === "running") {
    const ok = await healthProbe(live.ip, live.port);
    if (ok) {
      s.phase = "ready";
      s.instance = { iid: live.iid, ip: live.ip, port: live.port, offer: s.instance?.offer ?? null, dph: live.dph, since: s.instance?.since ?? Date.now() };
      writeState(s);
      return true;
    }
  }
  if (provisioning) { // 이미 진행 중 → 완료 대기
    for (let i = 0; i < 100 && s.phase !== "ready"; i++) { await sleep(3000); s = readState(); }
    return s.phase === "ready";
  }
  provisioning = true;
  s.phase = "launching"; s.err = null; writeState(s);
  try {
    if (!s.chain.length) await refreshChain(s);
    let chain = s.chain;
    if (s.pinned_offer) chain = [...chain].sort((a, b) => (b.offer_id === s.pinned_offer ? 1 : 0) - (a.offer_id === s.pinned_offer ? 1 : 0));
    for (let i = 0; i < chain.length; i++) {
      const o = chain[i];
      if (failedOffers.has(o.offer_id)) continue;
      if (o.needs_reseed && !(await ensureVolumeSeeded(s, o))) { failedOffers.add(o.offer_id); continue; } // 재시딩 확보 (실패 시 다음)
      const volId = o.same_machine ? (s.volume.id ?? 0) : s.volume.id!;
      const iid = await launchOn(s, o, volId);
      if (!iid) continue;
      s.chain_idx = i; writeState(s);
      const up = await waitRunning(s, iid);
      if (!up) { failedOffers.add(o.offer_id); continue; }
      s.instance = { iid, ip: up.ip, port: up.port, offer: o, dph: up.dph, since: Date.now() };
      s.phase = "ready"; s.budget.last_tick = Date.now();
      ev(s, `READY ${up.ip}:${up.port} (${o.gpu}, $${up.dph.toFixed(3)}/hr)`);
      writeState(s);
      return true;
    }
    s.phase = "failed";
    s.err = `예산($${P.maxUsdHr}/hr)·VRAM(${P.minVramGb}GB) 내 가용 후보 없음 — 체인 ${chain.length}개 전부 실패`;
    ev(s, s.err);
    writeState(s);
    return false;
  } finally { provisioning = false; }
}

// ── 타머신 재시딩 (옵션 폴백): 볼륨 확보 → 시딩 인스턴스 → 빌드/다운로드 → 파기 ──
async function ensureVolumeSeeded(s: State, o: Offer): Promise<boolean> {
  // 이 머신에 내 볼륨이 이미 있으면 재사용 (시딩된 경우 즉시 통과, 아니면 그 볼륨에 시딩)
  const vols = await vast(["show", "volumes", "--raw"], 20_000);
  const mine = (Array.isArray(vols) ? vols : []).find((v: any) => v.machine_id === o.machine_id);
  let volId: number;
  if (mine && s.volume.machine_id === o.machine_id && s.volume.seeded_model) {
    s.volume = { id: mine.id, machine_id: o.machine_id, size_gb: s.volume.size_gb, seeded_model: s.volume.seeded_model };
    writeState(s);
    return true;
  }
  s.phase = "seeding"; ev(s, `재시딩 시작: ${o.gpu} ${o.geo}에 신규 볼륨 (10~20분, 일회성)`); writeState(s);
  // CUDA arch: cc≥120(Blackwell) 120 / ≥89 89 / ≥80 80 / ≥75 75 / 그 외 70(Volta)
  const arch = o.compute_cap >= 120 ? 120 : o.compute_cap >= 89 ? 89 : o.compute_cap >= 80 ? 80 : o.compute_cap >= 75 ? 75 : 70;
  // 1) 볼륨 확보 — 체인이 실어온 볼륨 오퍼 ID 우선 (재조회는 실패 가능: 실증)
  if (mine) {
    volId = mine.id;
  } else {
    let vOfferId = o.volume_offer_id ?? null;
    if (!vOfferId) {
      const volOffers = await vast(["search", "volumes", "--raw"], 30_000);
      vOfferId = (Array.isArray(volOffers) ? volOffers : []).find((v: any) => v.machine_id === o.machine_id)?.id ?? null;
    }
    if (!vOfferId) { ev(s, "볼륨 호스팅 오퍼 없음 → 다음 후보"); return false; }
    const name = `vastless_${Date.now().toString(36)}`;
    await vast(["create", "volume", String(vOfferId), "-s", "100", "-n", name, "--raw"], 60_000);
    const vols2 = await vast(["show", "volumes", "--raw"], 20_000);
    const created = (Array.isArray(vols2) ? vols2 : []).find((v: any) => v.label === name);
    if (!created) { ev(s, "볼륨 생성 실패 → 다음 후보"); return false; }
    volId = created.id;
  }
  s.volume = { id: volId, machine_id: o.machine_id, size_gb: 100, seeded_model: null }; writeState(s);
  // 2) 시딩 인스턴스 (볼륨 마운트) — setup-volume.sh 원격 실행
  const r = await vast(["create", "instance", String(o.offer_id),
    "--image", imageFor(o.compute_cap), "--disk", "10", "--ssh",
    "--link-volume", String(volId), "--mount-path", "/root/models", "--raw"], 60_000);
  const iid = r?.instance ?? r?.new_contract;
  if (!iid) { ev(s, "시딩 인스턴스 생성 실패"); return false; }
  const up = await waitRunning(s, iid, 10 * 60_000);
  if (!up) return false;
  const modelUrl = process.env.VASTLESS_MODEL_URL || "https://huggingface.co/orcarouter/Nex-N2.5-mini-Uncensored-GGUF/resolve/main/Nex-N2.5-mini-Uncensored-IQ4_XS.gguf";
  const setupB64 = Buffer.from(readFileSync(path.join(P.repoDir, "setup-volume.sh"), "utf8"), "utf8").toString("base64");
  await ssh(iid, `echo ${setupB64} | base64 -d > /root/setup.sh`);
  const hfEnv = process.env.HF_TOKEN ? `HF_TOKEN=${process.env.HF_TOKEN} ` : "";
  await ssh(iid, `${hfEnv}nohup bash /root/setup.sh ${modelUrl} ${arch} > /root/setup.log 2>&1 & echo started`);
  // 3) 완료 마커 폴링 (최대 25분)
  const t0 = Date.now();
  while (Date.now() - t0 < 25 * 60_000) {
    await sleep(30_000);
    const tail = await ssh(iid, `tail -2 /root/setup.log`);
    if (tail?.includes("VOLUME-SETUP-DONE")) break;
    if (/error|빌드 실패/i.test(tail || "")) { ev(s, `시딩 실패: ${tail?.slice(0, 80)}`); break; }
  }
  const done = (await ssh(iid, `tail -1 /root/setup.log`))?.includes("VOLUME-SETUP-DONE");
  await vast(["destroy", "instance", String(iid), "-y"], 30_000);
  if (!done) { ev(s, "시딩 미완료 → 다음 후보"); return false; }
  s.volume.seeded_model = path.basename(new URL(modelUrl).pathname);
  ev(s, `재시딩 완료 (볼륨 ${volId})`);
  writeState(s);
  return true;
}

// SSH 헬퍼 (vast ssh 프록시: ssh root@ssh?.vast.ai -p <port>)
async function ssh(iid: number, cmd: string): Promise<string | null> {
  const inst = await vast(["show", "instance", String(iid), "--raw"], 20_000);
  const port = inst?.ssh_port, host = inst?.ssh_host;
  if (!port || !host) return null;
  const key = path.join(os.homedir(), ".ssh/id_vastai");
  const keyOpt = existsSync(key) ? `-i ${key}` : "";
  return new Promise((resolve) => {
    execFile("bash", ["-c",
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 ${keyOpt} -p ${port} root@${host} '${cmd.replace(/'/g, `'\\''`)}'`],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, so) => resolve((so || "").trim() || (err ? null : "")));
  });
}

// ── 외부 API ──
export async function statusSnapshot(): Promise<State> {
  const s = readState();
  tickSpend(s);
  const live = await liveInstance();
  if (!live) { if (s.phase === "ready") { s.phase = "idle"; s.instance = null; } }
  else if (live.status === "running" && s.phase !== "seeding") {
    const ok = await healthProbe(live.ip, live.port);
    s.phase = ok ? "ready" : "launching";
    s.instance = { iid: live.iid, ip: live.ip, port: live.port, offer: s.instance?.offer ?? null, dph: live.dph, since: s.instance?.since ?? Date.now() };
  } else if (s.phase !== "seeding") s.phase = "launching";
  writeState(s);
  return s;
}

export async function stopAll(): Promise<string> {
  const s = readState();
  const live = await liveInstance();
  if (live) { await vast(["destroy", "instance", String(live.iid), "-y"], 30_000); ev(s, `파기 iid ${live.iid}`); }
  s.phase = "idle"; s.instance = null; s.budget.last_tick = null;
  writeState(s);
  return live ? `destroyed ${live.iid}` : "no live instance";
}
