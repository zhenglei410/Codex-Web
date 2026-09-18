# Codex Web —— 自带 Codex CLI 的镜像（Node 22 + codex）
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CODEX_WEB_DATA_DIR=/app/data \
    CODEX_WEB_CONFIG=/app/config.json \
    CODEX_HOME=/home/node/.codex

# Codex CLI 需要 git / ripgrep 等常见工具；ca-certificates 用于访问模型 API
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex \
 && npm cache clean --force

WORKDIR /app

COPY package.json ./
COPY server.js user-admin.js model-admin.js hash-password.js config.example.json ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs

RUN mkdir -p /app/data /home/node/.codex /workspace \
 && chown -R node:node /app /home/node/.codex /workspace \
 && chmod +x /app/scripts/*.sh

USER node
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/session').then(r=>process.exit(r.status===401||r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
