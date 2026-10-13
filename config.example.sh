#!/usr/bin/env bash
# vastless 개인 설정 — 이 파일을 복사해 config.sh로 만들어 채운다 (config.sh는 .gitignore됨)
# vast.ai API 키: `vastai set-api-key <KEY>` 로 사전 등록 필요

# ── 인프라 식별자 ──
# 볼륨이 붙은 머신의 GPU 오퍼 ID (vastai search offers 'machine_id=<ID>')
OFFER_ID=51102905
# 볼륨 ID (vastai search volumes → create volume)
VOLUME_ID=54773962
MOUNT_PATH=/root/models

# ── 인스턴스 ──
# Blackwell(5090)은 CUDA 12.8+, Ampere 이하는 12.4도 가능
IMAGE=nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04
DISK_GB=10
LLAMA_PORT=8080

# ── 서버 기동 명령 (볼륨에 사전 빌드된 llama.cpp + 모델) ──
# 최초 1회는 setup-volume.sh로 볼륨에 llama.cpp 빌드와 모델 다운로드를 해둔다.
# 병렬 처리 우선이면 '-c 262144' 대신 '-c 262144 -np 8 --cont-batching' (슬롯당 32K).
MODEL_PATH=/root/models/llm/nex-mini-IQ4_XS.gguf
ONSTART="nohup /root/models/llm/llama.cpp/build/bin/llama-server -m $MODEL_PATH -ngl 99 -c 262144 -fa on --host 0.0.0.0 --port $LLAMA_PORT > /root/server.log 2>&1 &"

# ── 게이트웨이 ──
STATE="$HOME/.vastless/state.json"
VASTAI="$HOME/.local/bin/vastai"
