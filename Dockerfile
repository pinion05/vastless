# vastless gateway — 프록시 호스트용 이미지 (GPU 불필요, RAM ~200MB)
# 요구: node 22.6+ (native TS), vastai CLI. SSH는 런타임에 불필요 (인스턴스 제어는 전부 vast API).
FROM node:22-slim

# vastai CLI (인스턴스 lifecycle 제어용)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends python3-pip bash curl && \
    pip3 install --break-system-packages vastai && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY gateway.ts tsconfig.json ./
COPY public/ public/
COPY vastless-ctl setup-volume.sh config.example.sh ./
RUN chmod +x vastless-ctl setup-volume.sh && mkdir -p /data

# 컨테이너 기본 config — 개인값은 환경변수로 주입 (아래 ENV들) 또는 /app/config.sh 마운트로 덮음
ENV VASTLESS_PORT=8790 \
    VASTLESS_STATE=/data/state.json \
    VASTLESS_CTL=/app/vastless-ctl \
    NODE_ENV=production

EXPOSE 8790
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -sf http://127.0.0.1:8790/v1/models || exit 1

ENTRYPOINT ["node", "--experimental-strip-types", "gateway.ts"]
