// vastless gateway — Hono rewrite
// OpenAI-compatible proxy over vast.ai spot GPU with auto-launch / auto-destroy.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { execFile } from "child_process";
import { createReadStream, existsSync, readFileSync } from "fs";
import { mkdirSync, writeFileSync } from "fs";
import http from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";

// ── config ──
const PORT = parseInt(process.env.VASTLESS_PORT || "8790", 10);
const CTL = process.env.VASTLESS_CTL || path.join(import.meta.dirname, "vastless-ctl");
const STATE = process.env.VASTLESS_STATE || path.join(os.homedir(), ".vastless", "state.json");
const IDLE_MIN = parseInt(process.env.VASTLESS_IDLE_MIN || "10", 10);
const MODEL_ID = process.env.VASTLESS_MODEL_ID || "nex";
const CTX_LEN = parseInt(process.env.VASTLESS_CTX || "262144", 10);
const READY_TIMEOUT_MS = 150_000;

// ── types ──
type InstInfo = {
  phase: string; ip?: string; port?: string; dph?: number;
  iid?: string; uptime?: number; balance?: string | null;
};
type RunResult = { err: Error | null; out: string };

// ── lifecycle state ──
let lastHit = Date.now();
let activeStreams = 0;
let launching = false;

const run = (cmd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, so) =>
      resolve({ err: err ?? null, out: (so || "").trim() }));
  });

const readState = (): { iid?: number; ip?: string; port?: string } | null => {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; }
};
const writeState = (s: object) => { mkdirSync(path.dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); };

async function ctlStatus(): Promise<InstInfo> {
  const { out } = await run(CTL, ["status"], 20_000);
  // state:running|ip|port|dph iid:N up:S bal:X
  const m = /state:([^ ]+) iid:(\S+)(?: up:(\S+))?(?: bal:(\S+))?/.exec(out || "");
  if (!m) return { phase: "none" };
  const [st, ip, port, dph] = m[1].split("|");
  const info = { phase: st, ip, port, dph: parseFloat(dph || "0"), iid: m[2],
                 uptime: parseInt(m[3] || "0"), balance: m[4] || null };
  if (st !== "running" || !ip || !port) return info;
  // health probe
  const ok = await new Promise<boolean>((res) => {
    const r = http.get({ host: ip, port: +port, path: "/health", timeout: 4000 },
      (hr) => { let b = ""; hr.on("data", (c) => (b += c)); hr.on("end", () => res(b.includes("ok"))); });
    r.on("error", () => res(false));
    r.on("timeout", () => { r.destroy(); res(false); });
  });
  return { ...info, phase: ok ? "ready" : "starting" };
}

async function ctlLaunch(): Promise<number | null> {
  const { out } = await run(CTL, ["launch"], 180_000);
  return /^\d+$/.test(out) ? parseInt(out) : null;
}

async function ctlStop(): Promise<RunResult> { return run(CTL, ["stop"], 60_000); }

async function syncStatePointer(iid: number) {
  const s = await ctlStatus();
  if (s.ip && s.port) writeState({ iid, ip: s.ip, port: s.port });
}

async function waitForReady(deadlineMs = READY_TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    const s = await ctlStatus();
    if (s.phase === "ready") return true;
    if (Date.now() - t0 > deadlineMs) return false;
    await new Promise<void>((r) => setTimeout(r, 3000));
  }
}

async function ensureUp() {
  let s: InstInfo = await ctlStatus();
  if (["ready", "starting", "running", "loading"].includes(s.phase) && s.ip) {
    if (s.phase === "ready") { if (s.ip && s.port) writeState({ iid: s.iid, ip: s.ip, port: s.port }); return true; }
    return waitForReady();
  }
  if (launching) return waitForReady();
  launching = true;
  console.log("[autolaunch] /v1 call — provisioning instance");
  const iid = await ctlLaunch();
  launching = false;
  if (!iid) return false;
  writeState({ iid });
  await syncStatePointer(iid);
  return waitForReady();
}

// ── upstream forward (with reasoning_effort translation) ──
// Returns a web Response piping the upstream — the hono-native way.
async function forwardUpstream(c: any, st: { ip: string; port: string }): Promise<Response | null> {
  // body with optional reasoning_effort rewrite
  let buf: Buffer | null = null;
  const rawBody = await c.req.raw.arrayBuffer().catch(() => null);
  if (rawBody && rawBody.byteLength > 0) {
    buf = Buffer.from(rawBody);
    if (c.req.path.includes("/chat/completions") && c.req.method === "POST") {
      try {
        const body = JSON.parse(buf.toString("utf8"));
        if (typeof body.reasoning_effort === "string") {
          let eff = body.reasoning_effort === "minimal" ? "none" : body.reasoning_effort;
          body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), reasoning_effort: eff };
          delete body.reasoning_effort;
          buf = Buffer.from(JSON.stringify(body), "utf8");
          console.log(`[reffort] translated → ${eff}`);
        }
      } catch { /* passthrough */ }
    }
  }

  return await new Promise<Response | null>((resolve) => {
    activeStreams++;
    const done = () => { activeStreams = Math.max(0, activeStreams - 1); lastHit = Date.now(); };
    const headers: Record<string, string | string[]> = { ...c.req.raw.headers, host: `${st.ip}:${st.port}` };
    delete (headers as any)["content-length"];

    const preq = http.request(
      { host: st.ip, port: +st.port, path: c.req.path, method: c.req.method, headers, timeout: 600_000 },
      (pres) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(pres.headers)) if (typeof v === "string" || Array.isArray(v)) h[k] = v as string;
        const stream = Readable.toWeb(pres) as unknown as ReadableStream;
        // stream closes / errors → track + idle timer refresh
        const tracked = new ReadableStream({
          start(controller) {
            stream.pipeTo(new WritableStream({
              write(chunk) { controller.enqueue(chunk); },
              close() { controller.close(); done(); },
              abort() { done(); },
            })).catch(() => { try { controller.close(); } catch {} done(); });
          },
        });
        resolve(new Response(tracked, { status: pres.statusCode, headers: h }));
      });
    preq.on("error", (e: Error) => {
      done();
      resolve(Response.json({ error: { message: "upstream error: " + e.message, type: "upstream_error" } }, { status: 502 }));
    });
    preq.on("timeout", () => { preq.destroy(); });
    if (buf && buf.length) { preq.setHeader("Content-Length", buf.length); preq.write(buf); }
    preq.end();
  });
}

// ── dashboard UI (same design as v1) ──
const UI = readFileSync(path.join(import.meta.dirname, "public", "index.html"), "utf8");

// ── app ──
const app = new Hono();

app.get("/", (c) => c.html(UI));
app.get("/index.html", (c) => c.html(UI));

app.get("/api/status", async (c) => c.json(await ctlStatus()));

app.post("/api/launch", async (c) => {
  const s = await ctlStatus();
  if (["ready", "starting", "running", "loading"].includes(s.phase) && s.iid && s.iid !== "-")
    return c.json({ already: true, iid: s.iid });
  const iid = await ctlLaunch();
  if (!iid) return c.json({ error: "launch failed" }, 500);
  writeState({ iid });
  syncStatePointer(iid);
  return c.json({ launched: true, iid });
});

app.post("/api/stop", async (c) => { await ctlStop(); return c.json({ stopped: true }); });

// /v1/models — static, instant, never wakes the GPU
app.get("/v1/models", (c) =>
  c.json({
    object: "list",
    data: [{
      id: MODEL_ID, object: "model", created: 1760000000, owned_by: "vastless",
      context_length: CTX_LEN,
      description: "vastless spot-GPU LLM (llama.cpp GGUF)",
    }],
  }));

// /v1/* — auto-launch proxy
app.all("/v1/*", async (c) => {
  lastHit = Date.now();
  const ok = await ensureUp();
  if (!ok) return c.json({ error: { message: `auto-launch failed/timeout (${READY_TIMEOUT_MS / 1000}s)`, type: "autolaunch_timeout" } }, 504);
  const st = readState();
  if (!st?.ip || !st?.port) return c.json({ error: { message: "state pointer missing", type: "internal" } }, 500);
  const resp = await forwardUpstream(c, { ip: st.ip, port: st.port });
  if (!resp) return c.json({ error: { message: "forward produced no response", type: "internal" } }, 502);
  return resp;
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, () =>
  console.log(`vastless gateway (hono) on http://0.0.0.0:${PORT}`));

// idle auto-destroy (stream-safe)
setInterval(async () => {
  const idle = Date.now() - lastHit;
  if (idle < IDLE_MIN * 60_000) return;
  if (activeStreams > 0) { console.log(`[autostop] idle but ${activeStreams} stream(s) in flight — holding`); return; }
  const s = await ctlStatus();
  if (["none", "gone"].includes(s.phase)) return;
  console.log(`[autostop] ${Math.round(idle / 60000)}min idle, 0 streams → destroying (iid ${s.iid})`);
  await ctlStop();
}, 60_000);
