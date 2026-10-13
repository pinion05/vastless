<p align="center">
  <img src="assets/banner.png" alt="vastless — serverless GPU orchestration platform" width="720">
</p>

# vastless — serverless OpenAI-compatible LLM on vast.ai spot GPUs

[English](README.md) | [한국어](README.ko.md)

**Call the API → GPU boots itself. Idle → GPU destroys itself. Pay only for seconds used.**

```
curl http://your-gateway:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nex","messages":[{"role":"user","content":"안녕"}]}'
```

## What it does

A tiny Node.js gateway that fronts a llama.cpp server running on a vast.ai
rental GPU, giving you a **fixed OpenAI-compatible URL** with cloud-style
elasticity at spot-market prices:

- **Auto-launch on demand** — first `/v1/chat/completions` call provisions the
  GPU instance (builds live on a persistent volume, ~40 s to ready), holds the
  request, then forwards it. Callers never see the churn.
- **Auto-destroy on idle** — no `/v1` traffic for N minutes (default 10) and no
  in-flight streams → instance destroyed, billing stops to the second.
- **Fixed URL forever** — the gateway tracks the instance's floating IP/port;
  clients (and agents like Hermes) point at one URL and never reconfigure.
- **Volume-backed cold start** — llama.cpp binary + GGUF weights live on a
  vast.ai storage volume mounted at boot. No build, no download, no 25-minute
  cold starts. Model load: ~7 s.
- **Dashboard** — live status (phase, $/hr, uptime, credit balance), launch/stop
  buttons, and a built-in chat UI.
- **`reasoning_effort` translation** — OpenAI-style top-level
  `reasoning_effort` is rewritten to llama.cpp `chat_template_kwargs` per
  request (llama.cpp interprets the top-level param differently — measured).
- **Stream-safe teardown** — auto-destroy waits for in-flight responses.

## Measured on Nex-N2.5-mini (35B MoE, IQ4_XS) @ RTX 5090 32 GB

| metric | value |
|---|---|
| cold start → ready | 37 s |
| model load (volume NVMe) | 6.5 s |
| decode | 269 t/s (EN) / 261 t/s (KO) |
| 256K full-context prefill | 248K tokens in 68 s (3,646 t/s) |
| concurrent streams (8-slot) | 478 t/s aggregate |
| cost | $1.08/hr, per-request pennies |

## Layout

```
vastless-ctl        lifecycle: status | launch | stop (wraps vastai CLI)
gateway.ts          the whole product — Hono + TypeScript (needs Node >= 22.6, no build step:
                    `npm install && npm start`)
public/index.html   dashboard UI served by the gateway
setup-volume.sh     one-time: build llama.cpp + download GGUF onto the volume
config.example.sh   copy to config.sh and fill in your IDs (gitignored)
systemd/            user units for the gateway
legacy/             gateway-zero-dep.js — the original single-file, zero-dependency
                    plain-Node version; feature-identical, kept for minimal installs
```

## Quick start (installer)

```bash
npx pinion05/vastless init
```

Interactive installer: checks prereqs → finds volume+GPU combos on one
machine → creates the volume → builds llama.cpp + downloads your GGUF onto
it (10–20 min, one time) → writes `config.sh` → starts the gateway → smoke
test. After that the URL is live forever.

Manual setup below if you prefer.

## Setup (manual)

1. **Prereqs**: `vastai` CLI (`pipx install vastai`), API key set, SSH key
   registered. Node ≥ 18.

2. **Create a volume** on a machine that also offers the GPU you want
   (volumes can only link to instances on the same machine):
   ```bash
   vastai search volumes          # pick a cheap one
   vastai create volume <offer> -s 100 -n vastless
   vastai search offers 'machine_id=<that machine>'   # find its GPU offer
   ```

3. **Boot an instance once and seed the volume**:
   ```bash
   vastai create instance <gpu-offer> --image nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04 \
     --disk 10 --ssh --link-volume <vol-id> --mount-path /root/models
   # attach ssh key, then:
   ssh ... 'HF_TOKEN=hf_xxx bash -s' < setup-volume.sh \
     "https://huggingface.co/<org>/<model>-GGUF/resolve/main/<quant>.gguf" 120
   # arch: 120=Blackwell(5090) 89/86=Ampere(3090/4090) 80=Hopper 70=Volta
   vastai destroy instance <id> -y
   ```

4. **Configure**:
   ```bash
   cp config.example.sh config.sh   # fill OFFER_ID, VOLUME_ID, MODEL_PATH...
   ```

5. **Run the gateway**:
   ```bash
   node gateway.js                 # http://0.0.0.0:8790
   # systemd user service in systemd/ for persistence
   ```

6. **Point anything OpenAI-compatible at it**. Hermes example:
   ```yaml
   custom_providers:
     - name: nex-vast
       base_url: http://100.x.y.z:8790/v1
       api_mode: chat_completions
       models: [{id: nex, context_length: 262144}]
   model_overrides:
     nex-vast:
       nex: {supports_reasoning: true, supports_tools: true, context_window: 262144}
   ```

## Environment

| var | default | meaning |
|---|---|---|
| `VASTLESS_PORT` | 8790 | gateway listen port |
| `VASTLESS_CTL` | `./vastless-ctl` | lifecycle script path |
| `VASTLESS_STATE` | `~/.vastless/state.json` | instance pointer file |
| `VASTLESS_IDLE_MIN` | 10 | idle minutes before destroy |
| `VASTLESS_MODEL_ID` | `nex` | model id advertised at `/v1/models` |

## Hard-won notes (read before operating)

**Hono-specific (if hacking on gateway.ts):**
- `c.req.raw` is a **web** Request, not a Node stream — read the body via
  `await c.req.arrayBuffer()`, never `.on("data")`.
- Returning a `Response` whose body is `Readable.toWeb(upstream)` is the
  hono-native way to stream a proxy. Writing directly to `c.res.writeHead`
  collides with @hono/node-server's own response cycle
  (`ERR_HTTP_HEADERS_SENT`).

- **CUDA image must match GPU arch** — Blackwell (RTX 50xx) needs CUDA ≥ 12.8;
  a 12.4 image fails nvcc with cryptic compiler-ID errors.
- **vastai CLI quirk** — `destroy instance` needs `-y`; without it the prompt
  aborts silently while the instance keeps billing.
- **create's `--raw` response can lie** (`success: false` with a live
  contract) — always take `new_contract`/`instance` from the body.
- **SSH proxy blackouts** — instance `running` but SSH times out for minutes?
  Don't retry the same offer; destroy and pick another on the same machine.
- **systemd PATH** — user services don't inherit `~/.local/bin`; the ctl
  script uses absolute paths for this reason.
- **One offer per machine for volume-linked instances** — volume must live on
  the same machine as the GPU offer you launch.

## License

MIT
