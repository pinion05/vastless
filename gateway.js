#!/usr/bin/env node
// nex-dashboard — Nex-mini vast LLM 원클릭 대시보드 + 고정 API 게이트웨이 (proxy형)
// - 로컬: 대시보드 UI + /v1/* 프록시 → vast 인스턴스
// - OCI(점프박스)에도 동일 서버를 띄우면 외부 고정 URL로 사용 (같은 코드, NEX_REMOTE=oci 모드)
const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = parseInt(process.env.VASTLESS_PORT || "8790", 10);
const CTL = process.env.VASTLESS_CTL || path.join(__dirname, "vastless-ctl");
const AUTOSTOP_MIN = parseInt(process.env.VASTLESS_IDLE_MIN || "10", 10);
const STATE = process.env.VASTLESS_STATE || path.join(os.homedir(), ".vastless", "state.json");


function run(cmd, args, cb, timeoutMs = 120000) {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    cb(err, (stdout || "").trim(), (stderr || "").trim());
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
}

function probeVast(cb) {
  run(CTL, ["status"], (err, out) => {
    // state:running|ip|port|dph iid:N up:S bal:X
    const m = /state:([^ ]+) iid:(\S+)(?: up:(\S+))?(?: bal:(\S+))?/.exec(out || "");
    if (!m) return cb({ phase: "none" });
    const [st, ip, port, dph] = m[1].split("|");
    const info = { phase: st, ip, port, dph: parseFloat(dph || 0), iid: m[2],
                   uptime: parseInt(m[3] || 0), balance: m[4] || null };
    if (st === "running" && ip && port) {
      const req = http.get({ host: ip, port: parseInt(port), path: "/health", timeout: 4000 }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => cb({ ...info, phase: b.includes("ok") ? "ready" : "starting" }));
      });
      req.on("error", () => cb(info));
      req.on("timeout", () => { req.destroy(); cb(info); });
    } else cb(info);
  }, 20000);
}

function launch(cb) {
  // 이미 살아있는 인스턴스가 있으면 중복 생성 금지 (더블클릭/디버깅 사고 방지)
  run(CTL, ["status"], (err0, out0) => {
    const m0 = /state:([^ ]+) iid:(\S+)/.exec(out0 || "");
    if (m0) {
      const st0 = m0[1].split("|")[0];
      if (["running", "loading", "starting", "ready"].includes(st0) && m0[2] !== "-") {
        return cb({ already: true, iid: parseInt(m0[2]), msg: "이미 실행 중 — 새로 만들지 않음" });
      }
    }
    run(CTL, ["launch"], (err, iid) => {
      if (err || !/^\d+$/.test(iid)) return cb({ error: "launch 실패: " + (err ? err.message : iid) });
      writeState({ iid: parseInt(iid) });
      probeAndFill(parseInt(iid), () => cb({ launched: true, iid: parseInt(iid) }));
    }, 180000);
  }, 15000);
}

// 상태파일에 ip/port를 채우는 헬퍼 (probeVast와 별개로 launch 직후 호출)
function probeAndFill(iid, done) {
  run(CTL, ["status"], (err, out) => {
    const m = /state:([^ ]+) iid:(\S+)/.exec(out || "");
    if (m) {
      const [st, ip, port] = m[1].split("|");
      if (ip && port) writeState({ iid, ip, port });
    }
    if (done) done();
  }, 15000);
}

// ── 자동 런치/자동 파기 상태 ──
let lastHit = Date.now();
let activeStreams = 0;
let launching = false;
const autoStop = { enabled: true, idleMs: AUTOSTOP_MIN * 60 * 1000 };

function waitForReady(cb, deadlineMs = 150000) {
  const t0 = Date.now();
  (function check() {
    probeVast((s) => {
      if (s.phase === "ready") return cb(true);
      if (Date.now() - t0 > deadlineMs) return cb(false);
      setTimeout(check, 3000);
    });
  })();
}

function maybeLaunchAndWait(cb) {
  if (launching) return waitForReady(cb);
  probeVast((s) => {
    if (["ready", "starting", "running", "loading"].includes(s.phase) && s.ip) return waitForReady(cb);
    launching = true;
    console.log("[autolaunch] /v1 호출 감지 — 인스턴스 자동 생성");
    launch(() => { launching = false; waitForReady(cb); });
  });
}

function forwardTracked(req, res, bodyBuf, st) {
  activeStreams++;
  res.on("close", () => { activeStreams = Math.max(0, activeStreams - 1); lastHit = Date.now(); });
  // OpenAI 스타일 최상위 reasoning_effort → llama.cpp chat_template_kwargs 변환
  // (llama.cpp는 최상위 파라미터를 다르게 해석 — 템플릿 변수로 전달해야 정확히 동작)
  if (bodyBuf && bodyBuf.length && req.url.includes("/chat/completions") && req.method === "POST") {
    try {
      const body = JSON.parse(bodyBuf.toString("utf8"));
      if (body && typeof body === "object" && typeof body.reasoning_effort === "string") {
        let eff = body.reasoning_effort;
        if (eff === "minimal") eff = "none";           // 이 모델 템플릿의 none = think 완전 스킵
        body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), reasoning_effort: eff };
        delete body.reasoning_effort;
        bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
      }
    } catch (_) { /* 파싱 실패 시 원본 그대로 */ }
  }
  forward(req, res, bodyBuf, st);
}

function stop(cb) {
  run(CTL, ["stop"], (err, out) => cb({ stopped: true, out }));
}

// ── /v1 프록시 → vast ──
function proxyV1(req, res, bodyBuf) {
  lastHit = Date.now();
  // /v1/models는 게이트웨이가 정적 응답 — 서버 꺼져있어도 즉답 + 자동런치 트리거 안 함
  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/v1/models/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      object: "list",
      data: [{
        id: "nex",
        object: "model",
        created: 1760000000,
        owned_by: "nex-vast",
        context_length: 262144,
        description: "Nex-N2.5-mini-Uncensored 35B MoE (IQ4_XS) on vast RTX 5090"
      }]
    }));
  }
  const st = readState();
  const hasLive = st && st.ip && st.port;
  if (!hasLive) {
    // 서버 꺼져있음 → 자동 런치 후 포워드 (요청 보류)
    return maybeLaunchAndWait((ok) => {
      if (!ok) {
        res.writeHead(504, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "자동 런치 실패/타임아웃 (150s). 잠시 후 재시도.", type: "autolaunch_timeout" } }));
      }
      const st2 = readState();
      forwardTracked(req, res, bodyBuf, st2);
    });
  }
  forwardTracked(req, res, bodyBuf, st);
}

function forward(req, res, bodyBuf, st) {
  const opts = {
    host: st.ip, port: parseInt(st.port), path: req.url, method: req.method,
    headers: { ...req.headers, host: `${st.ip}:${st.port}` },
    timeout: 600000,
  };
  const preq = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", (e) => {
    if (res.headersSent) return;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "vast 업스트림 오류: " + e.message, type: "upstream_error" } }));
  });
  if (bodyBuf.length) {
    // body가 변형되었을 수 있으므로 Content-Length 재계산
    const h = { ...opts.headers };
    delete h["content-length"];
    preq.setHeader("Content-Length", bodyBuf.length);
    preq.write(bodyBuf);
  }
  preq.end();
}

const UI = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vastless dashboard</title>
<style>
:root{--bg:#0b0e14;--card:#141a24;--line:#232c3b;--tx:#e6edf3;--mut:#8b98a9;--acc:#4f8cff;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,'Segoe UI','Noto Sans KR',sans-serif;padding:24px;max-width:860px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px} .sub{color:var(--mut);font-size:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.stat{display:inline-flex;gap:8px;align-items:center;background:var(--bg);border:1px solid var(--line);padding:8px 12px;border-radius:8px;font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)} .dot.warn{background:var(--warn)} .dot.err{background:var(--err)} .dot.none{background:var(--mut)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer}
button.stop{background:var(--err)} button:disabled{opacity:.4;cursor:wait}
label.tog{display:flex;gap:8px;align-items:center;color:var(--mut);font-size:12px;cursor:pointer}
code,pre{font:12px/1.5 ui-monospace,monospace}
.urlbox{display:flex;gap:8px;margin-top:10px}
.urlbox input{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:9px 12px;font:13px ui-monospace,monospace}
.copy{background:var(--line);color:var(--tx);border:0;border-radius:8px;padding:9px 14px;cursor:pointer;font-size:12px}
.hint{color:var(--mut);font-size:12px;margin-top:8px}
.mut{color:var(--mut)} .mt{margin-top:12px}
#curl{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;color:var(--mut);white-space:pre}
</style></head><body>
<h1>vastless dashboard</h1>
<div class="sub">vast.ai spot GPU · OpenAI-compatible auto-launch gateway</div>

<div class="card">
  <div class="row" style="justify-content:space-between">
    <div class="row" id="stats"></div>
    <div class="row">
      <button id="btnLaunch">🚀 Launch</button>
      <button id="btnStop" class="stop" style="display:none">■ Stop</button>
      <label class="tog"><input type="checkbox" id="autoStop" checked> 10분 무응답 시 자동파기</label>
    </div>
  </div>
  <div class="hint" id="detail"></div>
</div>

<div class="card">
  <b>OpenAI 호환 API (고정 URL)</b>
  <div class="urlbox"><input id="apiurl" readonly><button class="copy" onclick="cp()">복사</button></div>
  <div class="hint">이 URL은 vast IP가 바뀌어도 그대로 — 게이트웨이가 현재 인스턴스로 프록시합니다.</div>
  <div class="mt" id="curl"></div>
</div>

<div class="card" style="display:flex;flex-direction:column;height:420px">
  <b>💬 Chat</b>
  <div id="chatlog" style="flex:1;overflow-y:auto;margin-top:10px;padding-right:6px"></div>
  <div class="row" style="margin-top:10px">
    <input id="chatin" placeholder="메시지 입력 (Enter)" style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:10px 12px;font-size:14px">
    <button id="btnSend">전송</button>
  </div>
</div>

<script>
let timer;
const $=id=>document.getElementById(id);
function fmtDur(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=Math.floor(s%60);
  return h>0?h+'시간 '+m+'분':(m>0?m+'분 '+sec+'초':sec+'초');}
const history=[];
function addMsg(role,text){
  const el=document.createElement('div');
  el.style.cssText='margin:6px 0;display:flex;'+(role==='user'?'justify-content:flex-end':'');
  const b=document.createElement('div');
  b.style.cssText='max-width:78%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;line-height:1.55;font-size:14px;'+
    (role==='user'?'background:var(--acc);color:#fff;border-bottom-right-radius:3px':'background:var(--bg);border:1px solid var(--line);border-bottom-left-radius:3px');
  b.textContent=text;
  el.appendChild(b);$('chatlog').appendChild(el);
  $('chatlog').scrollTop=$('chatlog').scrollHeight;
}
async function send(){
  const q=$('chatin').value.trim(); if(!q) return;
  $('chatin').value=''; addMsg('user',q); history.push({role:'user',content:q});
  const t0=performance.now(); addMsg('assistant','…');
  const last=$('chatlog').lastChild.firstChild;
  try{
    const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'nex',messages:history.slice(-20),max_tokens:1024,temperature:0.7})});
    const d=await r.json();
    const dt=((performance.now()-t0)/1000).toFixed(1);
    if(d.choices){const a=d.choices[0].message.content;history.push({role:'assistant',content:a});
      last.textContent=a+'  ·  '+dt+'s';}
    else last.textContent='에러: '+JSON.stringify(d).slice(0,150);
  }catch(e){last.textContent='에러: '+e.message;}
  $('chatlog').scrollTop=$('chatlog').scrollHeight;
}
$('btnSend').onclick=send;
$('chatin').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing)send();});
function render(s){
  const dot=function(c){return '<span class="dot '+c+'"></span>';};
  const map={ready:[dot('ok'),'READY — API 사용 가능'],starting:[dot('warn'),'기동 중… (콜드 ~40s)'],running:[dot('warn'),'부팅 중…'],loading:[dot('warn'),'이미지 로딩…'],none:[dot('none'),'정지 (과금 0)'],gone:[dot('err'),'인스턴스 소멸 — 재런치 필요']};
  const pair=map[s.phase]||[dot('none'),s.phase];
  const d=pair[0], t=pair[1];
  $('stats').innerHTML='<span class="stat">'+d+t+'</span>'+
    (s.dph?'<span class="stat">$'+s.dph.toFixed(3)+'/hr</span>':'')+
    (s.uptime?'<span class="stat">⏱ '+fmtDur(s.uptime)+'</span>':'')+
    (s.balance!==null&&s.balance!==undefined&&s.balance!==''?'<span class="stat">💰 $'+s.balance+'</span>':'')+
    (s.iid&&s.iid!='-'?'<span class="stat">IID '+s.iid+'</span>':'')+
    (s.ip?'<span class="stat">'+s.ip+(s.port?':'+s.port:'')+'</span>':'');
  $('detail').textContent = s.phase==='ready' ? '연결 정상 · 269 t/s (EN) / 261 t/s (KO) 실측' :
    s.phase==='none' ? 'Launch를 누르면 37초 내 서버가 뜹니다 (볼륨 영구빌드).' : JSON.stringify(s);
  const running=!['none','gone'].includes(s.phase);
  const upStr = s.uptime ? fmtDur(s.uptime) : '';
  $('btnLaunch').disabled=running; $('btnLaunch').textContent = running ? '🚀 Running' : '🚀 Launch';
  $('btnStop').style.display=running?'':'none';
  const loc=location.origin;
  $('apiurl').value=loc+'/v1';
  $('curl').textContent=['curl '+loc+'/v1/chat/completions','-H "Content-Type: application/json"','-d '+JSON.stringify({model:'nex',messages:[{role:'user',content:'안녕'}]})].join(String.fromCharCode(10));
}
async function poll(){ try{ render(await (await fetch('/api/status')).json()); }catch(e){} }
let acting=false;
async function act(path,btn,label){ 
  if(acting) return; acting=true;
  const old=btn.textContent; btn.textContent=label||'…처리 중'; btn.disabled=true;
  try{ await fetch(path,{method:'POST'}); }catch(e){} 
  finally{ acting=false; btn.textContent=old; poll(); }
}
$('btnLaunch').onclick=e=>act('/api/launch',e.target,'🚀 생성 중… (최대 3분)');
$('btnStop').onclick=e=>act('/api/stop',e.target,'■ 파기 중…');
function cp(){ navigator.clipboard.writeText($('apiurl').value); event.target.textContent='복사됨!'; setTimeout(()=>event.target.textContent='복사',1200); }
poll(); timer=setInterval(poll,5000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(body);
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(UI);
    }
    if (req.url === "/api/status") {
      return probeVast((s) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s)); });
    }
    if (req.url === "/api/launch" && req.method === "POST") {
      return launch((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); });
    }
    if (req.url === "/api/stop" && req.method === "POST") {
      return stop((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); });
    }
    if (req.url.startsWith("/v1/") || req.url === "/v1") {
      return proxyV1(req, res, buf);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`nex-dashboard listening on http://0.0.0.0:${PORT}`);
});
// 자동파기: 스트림 없음(non-streaming) + 마지막 호출로부터 idleMs 경과 시 파기
server.on("request", (r) => { if (r.url.startsWith("/v1")) lastHit = Date.now(); });
setInterval(() => {
  if (!autoStop.enabled) return;
  const idle = Date.now() - lastHit;
  if (idle > autoStop.idleMs && activeStreams === 0) {
    probeVast((s) => {
      if (["none", "gone"].includes(s.phase)) return;
      console.log(`[autostop] ${Math.round(idle/60000)}분 무호출 + 스트림 0 → 자동 파기 (iid ${s.iid})`);
      stop(() => {});
    });
  } else if (idle > autoStop.idleMs && activeStreams > 0) {
    console.log(`[autostop] 유휴 도달했으나 스트림 ${activeStreams}개 진행 중 — 보류`);
  }
}, 60 * 1000);
