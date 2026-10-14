<p align="center">
  <img src="assets/banner.png" alt="vastless — serverless GPU orchestration platform" width="720">
</p>

# vastless — vast.ai 스팟 GPU 위의 서버리스 OpenAI 호환 LLM

[English](README.md) | [한국어](README.ko.md)

**API를 호출하면 GPU가 저절로 켜지고, 한가해지면 저절로 꺼진다. 사용한 초만큼만 지불한다.**

```
curl http://your-gateway:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nex","messages":[{"role":"user","content":"안녕"}]}'
```

## 무엇을 하나요

vast.ai 스팟 GPU에서 돌아가는 llama.cpp 서버 앞단에 서는 초경량 Node.js 게이트웨이.
**고정된 OpenAI 호환 URL** 하나를 주면서 클라우드형 탄력성을 스팟 가격에 누립니다:

- **요청 시 자동 런치** — 첫 `/v1/chat/completions` 호출이 GPU 인스턴스를 프로비저닝합니다
  (영구 볼륨 위에 사전 빌드돼 있어 ready까지 약 40초). 요청은 그 사이 보류됐다가
  그대로 전달됩니다. 호출자는 뒤에서 벌어지는 일을 전혀 모릅니다.
- **유휴 시 자동 파기** — N분(기본 10분)간 `/v1` 트래픽이 없고 진행 중 스트림도 없으면
  인스턴스가 파기되고 과금은 초 단위로 멈춥니다.
- **영구 고정 URL** — 게이트웨이가 인스턴스의 유동 IP/포트를 추적합니다. 클라이언트
  (Hermes 같은 에이전트 포함)는 URL 하나만 바라보면 되고 재설정이 없습니다.
- **볼륨 기반 콜드스타트** — llama.cpp 바이너리와 GGUF 가중치는 vast.ai 스토리지
  볼륨에 상주하며 부팅 시 마운트됩니다. 빌드도 다운로드도 없이 25분 콜드스타트가
  사라집니다. 모델 로드 약 7초.
- **대시보드** — 실시간 상태(단계, $/hr, 업타임, 잔액), 실행/정지 버튼, 내장 채팅 UI.
- **`reasoning_effort` 변환** — OpenAI식 최상위 `reasoning_effort`를 요청별로 llama.cpp
  `chat_template_kwargs`로 재작성합니다 (llama.cpp는 최상위 파라미터를 다르게 해석함 — 실측).
- **스트림 안전 파기** — 자동 파기는 진행 중 응답이 끝날 때까지 기다립니다.

## Nex-N2.5-mini (35B MoE, IQ4_XS) @ RTX 5090 32 GB 실측

| 지표 | 값 |
|---|---|
| 콜드스타트 → ready | 37초 |
| 모델 로드 (볼륨 NVMe) | 6.5초 |
| 디코딩 | 269 t/s (영어) / 261 t/s (한국어) |
| 256K 풀컨텍스트 프리필 | 248K 토큰 68초 (3,646 t/s) |
| 동시 스트림 (8슬롯) | 집계 478 t/s |
| 비용 | $1.08/hr, 요청당 몇 센트 |

## 구성

```
vastless-ctl        수명주기: status | launch | stop (vastai CLI 래퍼)
gateway.ts          제품 전체 — Hono + TypeScript (Node 22.6+ 필요, 빌드 단계 없음:
                    `npm install && npm start`)
public/index.html   게이트웨이가 서빙하는 대시보드 UI
setup-volume.sh     최초 1회: llama.cpp 빌드 + GGUF 볼륨 다운로드
config.example.sh   config.sh로 복사해 본인 ID를 채운다 (gitignored)
systemd/            게이트웨이 유닛
legacy/             gateway-zero-dep.js — 의존성 0 원조 단일 파일 버전.
                    기능 동일하며 미니멀 설치용으로 보존
```

## 빠른 시작 (인스톨러)

```bash
npx @npmc_5/vastless init
```

대화형 인스톨러: 사전요구 검사 → 같은 머신의 볼륨+GPU 조합 탐색 → 볼륨 생성 →
llama.cpp 빌드 + GGUF 다운로드 (10~20분, 최초 1회) → `config.sh` 생성 → 게이트웨이
기동 → 스모크. 이후 URL은 영구 활성.

수동 설치는 아래.

## 설치 (수동)

1. **사전 준비**: `vastai` CLI (`pipx install vastai`), API 키 등록, SSH 키 등록. Node 18+.

2. **볼륨 생성** — GPU도 같이 파는 머신에 만들어야 한다 (볼륨은 같은 머신 인스턴스에만
   연결 가능):
   ```bash
   vastai search volumes          # 저렴한 것 선택
   vastai create volume <offer> -s 100 -n vastless
   vastai search offers 'machine_id=<그 머신>'   # GPU 오퍼 찾기
   ```

3. **인스턴스를 한 번 띄워 볼륨 시딩**:
   ```bash
   vastai create instance <gpu-offer> --image nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04 \
     --disk 10 --ssh --link-volume <vol-id> --mount-path /root/models
   # ssh 키 등록 후:
   ssh ... 'HF_TOKEN=hf_xxx bash -s' < setup-volume.sh \
     "https://huggingface.co/<org>/<model>-GGUF/resolve/main/<quant>.gguf" 120
   # 아키텍처: 120=Blackwell(5090) 89/86=Ampere(3090/4090) 80=Hopper 70=Volta
   vastai destroy instance <id> -y
   ```

4. **설정**:
   ```bash
   cp config.example.sh config.sh   # OFFER_ID, VOLUME_ID, MODEL_PATH 채우기
   ```

5. **게이트웨이 실행**:
   ```bash
   npm install
   npm start                        # http://0.0.0.0:8790
   # 상시 운영은 systemd/ 유닛 사용
   ```

6. **OpenAI 호환 클라이언트라면 아무거나 붙인다**. Hermes 예시:
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

## 자동 프로비저닝 (v0.3)

게이트웨이가 라이프사이클 전체를 소유한다 — 런치/파기만이 아닌:

- **예산 검색** — `VASTLESS_MAX_USD_HR` (기본 0.80)가 시간당 요금 상한. VRAM 하한(`VASTLESS_MIN_VRAM_GB`, 기본 24)과 신뢰도 >0.97로 후보 필터.
- **2계층 폴백 체인** — 1계층: 시딩된 볼륨을 보유한 머신의 오퍼 (즉시 부착, 콜드 ~40초). 2계층: 다른 볼륨 호스팅 머신 (일회성 재시딩: llama.cpp 빌드 + 모델 다운로드 10~20분, 이후 영구 1계층).
- **스톨 가드** — `loading`에 걸린 인스턴스는 `VASTLESS_LOADING_TIMEOUT_MIN`(기본 8) 후 파기하고 다음 후보 시도. 실패 오퍼는 세션 내 기억.
- **상태 머신 + 실시간 대시보드** — phase(idle/launching/seeding/ready/failed), 이벤트 로그, 지출 추적, 웹 UI에서 오퍼 체인 확인·수동 선택('선택').
- VRAM별 컨텍스트: 24GB 카드 128K, 31GB+ 256K (실측 기준).

## Docker (프록시 호스트 권장)

게이트웨이만 설치하면 된다 — 항시 켜진 아무 머신이면 충분 (RAM ~200MB, GPU 불필요):

```bash
git clone https://github.com/pinion05/vastless && cd vastless
cp config.example.sh config.sh   # OFFER_ID / VOLUME_ID / MODEL_PATH 채우기
docker compose up -d             # http://<호스트>:8790/v1
```

compose가 vast API 키를 읽기전용 마운트하고, config.sh에 볼륨/오퍼 ID가 들어간다.
헬스체크·재시작 정책 포함.

## 환경변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `VASTLESS_PORT` | 8790 | 게이트웨이 리슨 포트 |
| `VASTLESS_CTL` | `./vastless-ctl` | 수명주기 스크립트 경로 |
| `VASTLESS_STATE` | `~/.vastless/state.json` | 인스턴스 포인터 파일 |
| `VASTLESS_IDLE_MIN` | 10 | 파기까지 유휴 분 |
| `VASTLESS_MODEL_ID` | `nex` | `/v1/models`에 광고할 모델 id |

## 피땀 어린 노트 (운영 전 필독)

**Hono 관련 (gateway.ts를 만질 때):**
- `c.req.raw`는 Node 스트림이 아니라 **web** Request다 — 본문은
  `await c.req.arrayBuffer()`로 읽는다. `.on("data")`는 절대 안 됨.
- 업스트림을 `Readable.toWeb(upstream)`으로 감싼 `Response`를 반환하는 것이
  프록시 스트리밍의 hono 정석이다. `c.res.writeHead`에 직접 쓰면
  @hono/node-server 자체 응답 사이클과 충돌한다 (`ERR_HTTP_HEADERS_SENT`).

**vast.ai 관련:**
- **CUDA 이미지는 GPU 아키텍처와 일치해야** — Blackwell(RTX 50xx)은 CUDA 12.8+.
  12.4 이미지는 정체불명의 컴파일러 ID 에러로 nvcc가 죽는다.
- **vastai CLI 함정** — `destroy instance`에는 `-y`가 필요. 없으면 프롬프트가
  조용히 중단되는 동안 인스턴스는 과금을 계속한다.
- **create의 `--raw` 응답은 거짓말을 한다** (`success: false`인데 계약은 살아있음) —
  반드시 본문에서 `new_contract`/`instance`를 직접 확인할 것.
- **SSH 프록시 블랙아웃** — 인스턴스는 `running`인데 SSH가 몇 분째 타임아웃?
  같은 오퍼 재시도 금지. 파기하고 같은 머신의 다른 오퍼로 갈아탈 것.
- **systemd PATH** — user 서비스는 `~/.local/bin`을 상속하지 않는다. ctl
  스크립트는 이 때문에 절대경로를 쓴다.
- **볼륨 연결 인스턴스는 머신 단위** — 볼륨은 실행할 GPU 오퍼와 같은 머신에 있어야 한다.

## 라이선스

MIT
