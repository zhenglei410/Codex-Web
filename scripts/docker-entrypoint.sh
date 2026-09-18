#!/bin/sh
# 容器入口：首次启动时用示例配置生成 config.json（监听 0.0.0.0 并写入随机 sessionSecret）
set -e

CONFIG="${CODEX_WEB_CONFIG:-/app/config.json}"

if [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] 未找到 $CONFIG，使用 config.example.json 生成"
  cp /app/config.example.json "$CONFIG"
fi

node -e '
const fs = require("fs");
const crypto = require("crypto");
const file = process.env.CODEX_WEB_CONFIG || "/app/config.json";
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
let dirty = false;
if (cfg.host === "127.0.0.1") { cfg.host = "0.0.0.0"; dirty = true; }
if (!cfg.sessionSecret || cfg.sessionSecret === "change-me-to-a-long-random-string") {
  cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
  dirty = true;
  console.log("[entrypoint] 已生成随机 sessionSecret");
}
if (dirty) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
if (!Array.isArray(cfg.users) || !cfg.users.length) {
  console.log("[entrypoint] 提示：还没有账号，请执行 node user-admin.js add <账号> <密码> --admin");
}
'

exec node /app/server.js
