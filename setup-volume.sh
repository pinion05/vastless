#!/usr/bin/env bash
# vastless 볼륨 최초 셋업 — llama.cpp CUDA 빌드 + GGUF 모델 다운로드를 영구 볼륨에 설치
# 사용: 볼륨 마운트된 인스턴스에 SSH 접속 후 이 스크립트 실행
#   bash setup-volume.sh <모델HF URL> [아키텍처 예: 120(Blackwell)|86(Ampere)|70(Volta)]
set -euo pipefail
MODEL_URL="${1:?사용법: setup-volume.sh <model-url> [cuda-arch]}"
ARCH="${2:-120}"
VOL=/root/models

apt-get update -qq && apt-get install -y -qq build-essential cmake curl python3-pip > /dev/null
mkdir -p "$VOL/llm"

for a in 1 2 3; do
  rm -rf "$VOL/llm/llama.cpp"
  curl -sL https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.tar.gz -o /root/lc.tar.gz \
    && tar xzf /root/lc.tar.gz -C "$VOL/llm" && mv "$VOL/llm/llama.cpp-master" "$VOL/llm/llama.cpp" && break
  echo "retry $a"; sleep 5
done

cd "$VOL/llm/llama.cpp"
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH"
cmake --build build --config Release -j "$(nproc)"
ls build/bin/llama-server || { echo "빌드 실패"; exit 1; }

FNAME=$(basename "$MODEL_URL")
if [ -n "${HF_TOKEN:-}" ]; then
  curl -sL -H "Authorization: Bearer $HF_TOKEN" -o "$VOL/llm/$FNAME" "$MODEL_URL"
else
  curl -sL -o "$VOL/llm/$FNAME" "$MODEL_URL"
fi
stat -c%s "$VOL/llm/$FNAME"
echo "VOLUME-SETUP-DONE: $VOL/llm/$FNAME"
