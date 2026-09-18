#!/usr/bin/env bash
# Codex Web 一键安装（Linux + systemd）
#
#   sudo bash scripts/install.sh [--dir /opt/codex-web] [--user root] [--port 8790] [--no-start]
#
# 脚本做的事：复制程序 → 生成 config.json（随机 sessionSecret）→ 创建 data 目录并收紧权限
#            → 生成并启动 systemd 服务 codex-web.service
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/codex-web"
RUN_USER="root"
PORT="8790"
START="yes"
# 供测试/自定义安装使用：默认写系统 systemd 目录
UNIT_PATH="${CODEX_WEB_UNIT_PATH:-/etc/systemd/system/codex-web.service}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-start) START="no"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo bash scripts/install.sh"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 node，请先安装 Node.js ≥ 20（见 docs/deployment.md）"
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node 版本过低（$("$NODE_BIN" -v)），需要 ≥ 20"
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "用户 $RUN_USER 不存在，请先创建（useradd -m -s /bin/bash $RUN_USER）"
  exit 1
fi

RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[[ -n "$RUN_HOME" ]] || RUN_HOME="/root"
CODEX_BIN="$(command -v codex || true)"
[[ -n "$CODEX_BIN" ]] || CODEX_BIN="$RUN_HOME/.local/bin/codex"

echo "==> 安装到 $APP_DIR（运行用户 $RUN_USER，端口 $PORT，node $NODE_BIN，codex $CODEX_BIN）"
mkdir -p "$APP_DIR"
for item in server.js user-admin.js model-admin.js hash-password.js package.json config.example.json lib public scripts docs deploy; do
  cp -r "$HERE/$item" "$APP_DIR/"
done

mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

if [[ ! -f "$APP_DIR/config.json" ]]; then
  echo "==> 生成 config.json"
  "$NODE_BIN" -e '
const fs = require("fs");
const crypto = require("crypto");
const [target, port, home, codexBin] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(target.replace(/config\.json$/, "config.example.json"), "utf8"));
cfg.port = Number(port);
cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
cfg.codexHome = require("path").join(home, ".codex");
cfg.defaultCwd = home;
cfg.codexBin = codexBin;
// 默认管理员：账号密码都是 admin，登录后强制改密（示例配置里已带好哈希）
if (!Array.isArray(cfg.users) || !cfg.users.length) {
  cfg.users = [{
    username: "admin",
    displayName: "管理员",
    passwordHash: hashPassword("admin"),
    role: "admin",
    disabled: false,
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
    lastLoginAt: "",
    mustChangePassword: true,
    permissions: {
      run: true, browse: true, threads: true, threadsAll: true, manageUsers: true,
      sandboxMax: "danger-full-access", defaultCwd: home,
    },
  }];
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return "scrypt$" + salt.toString("base64") + "$" + crypto.scryptSync(password, salt, 64).toString("base64");
}
fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
console.log("    写入 " + target + "（默认管理员 admin/admin，首次登录会强制改密）");
' "$APP_DIR/config.json" "$PORT" "$RUN_HOME" "$CODEX_BIN"
else
  echo "==> 已存在 config.json，保留不改动"
fi

chmod 600 "$APP_DIR/config.json"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

echo "==> 安装 systemd 服务"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__RUN_USER__|$RUN_USER|g" \
  "$APP_DIR/deploy/codex-web.service" > "$UNIT_PATH"
systemctl daemon-reload
if [[ "$START" == "yes" ]]; then
  systemctl enable --now codex-web
  sleep 2
  systemctl --no-pager --lines=5 status codex-web || true
fi

cat <<EOF

安装完成。接下来：
  1) 打开网页用默认账号登录：admin / admin
     首次登录会被要求修改密码，改完才能使用其他功能（也可以先手工设置一个初始密码）：
       sudo -u $RUN_USER $NODE_BIN $APP_DIR/user-admin.js passwd admin '你的强密码'
  2) 配置模型供应商（网页里配置也可以）：
       sudo -u $RUN_USER $NODE_BIN $APP_DIR/model-admin.js add deepseek --name DeepSeek \\
         --base-url https://api.deepseek.com --wire-api responses \\
         --models deepseek-chat,deepseek-reasoner --key sk-xxxx --activate
  3) 重启并检查：
       systemctl restart codex-web && journalctl -u codex-web -f
  4) 用 nginx 反代到 127.0.0.1:$PORT（参考 $APP_DIR/deploy/nginx.conf.example）

注意：默认账号密码是公开的，改密之前不要把服务暴露到公网。

EOF
