#!/usr/bin/env bash
# Codex Web 冒烟测试：在临时目录里起一个隔离实例，验证登录、模型与 API Key（加密/脱敏）、
# 本机权限策略与审计链路，不需要真实的 Codex 与 API Key。
#
#   bash scripts/smoke-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8879}"
WORK="$(mktemp -d)"
LOG="$WORK/server.log"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok() {
  PASS=$((PASS + 1))
  printf '  \033[32m✓\033[0m %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf '  \033[31m✗\033[0m %s\n' "$1"
}
check() {
  if [[ "$2" == "$3" ]]; then ok "$1（$2）"; else bad "$1：期望 $3，实际 $2"; fi
}

echo "==> 准备工作目录 $WORK"
mkdir -p "$WORK/data" "$WORK/ws"

# 一个假的 codex 可执行文件：先报会话开始，再报一条命中禁止规则的命令，然后挂住等被杀掉
cat > "$WORK/fake-codex" <<'FAKE'
#!/usr/bin/env bash
# 把收到的参数和环境变量落盘，用于验证「密钥只走环境变量、不进命令行」
{
  printf '%s\n' "$@"
} > "${SMOKE_DUMP_DIR:-/tmp}/argv.txt" 2>/dev/null || true
env > "${SMOKE_DUMP_DIR:-/tmp}/env.txt" 2>/dev/null || true
echo '{"type":"thread.started","thread_id":"smoke-thread"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"rm -rf /","status":"completed","exit_code":0}}'
exec sleep 30
FAKE
chmod +x "$WORK/fake-codex"

cat > "$WORK/config.json" <<JSON
{
  "host": "127.0.0.1",
  "port": $PORT,
  "users": [],
  "sessionSecret": "smoke-test-secret-smoke-test-secret-smoke-test-secret",
  "sessionTtlHours": 72,
  "codexBin": "$WORK/fake-codex",
  "codexHome": "$WORK/codex-home",
  "defaultCwd": "$WORK/ws",
  "sandbox": "read-only",
  "model": "",
  "maxConcurrentRuns": 3,
  "maxConcurrentRunsPerUser": 2
}
JSON

export CODEX_WEB_CONFIG="$WORK/config.json"
export CODEX_WEB_DATA_DIR="$WORK/data"
export SMOKE_DUMP_DIR="$WORK"

echo "==> 创建管理员账号"
node "$HERE/user-admin.js" add admin 'smoke-test-pass' --admin >/dev/null

echo "==> 启动服务（端口 $PORT）"
node "$HERE/server.js" >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/session" 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "服务启动失败："; cat "$LOG"; exit 1
  fi
  sleep 0.25
done

BASE="http://127.0.0.1:$PORT"
COOKIE="$WORK/cookie.txt"

echo "==> 登录"
LOGIN_CODE=$(curl -sS -o "$WORK/login.json" -w '%{http_code}' -c "$COOKIE" -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"smoke-test-pass"}')
check "登录返回 200" "$LOGIN_CODE" "200"

echo "==> 未登录访问要拦掉"
check "未登录 /api/session" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/session")" "401"
check "未登录 /api/admin/models" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/models")" "401"

echo "==> 会话信息包含模型与策略"
SESSION=$(curl -sS -b "$COOKIE" "$BASE/api/session")
check "session 带 models 字段" "$(jq -r '.models | type' <<<"$SESSION")" "array"
check "session 带 policy 字段" "$(jq -r '.policy.enabled' <<<"$SESSION")" "true"

echo "==> 通过接口新增成员账号"
USER_CODE=$(curl -sS -o "$WORK/user.json" -w '%{http_code}' -b "$COOKIE" -X POST "$BASE/api/admin/users" \
  -H 'Content-Type: application/json' -d '{
    "username": "smoke-user",
    "password": "smoke-user-pass",
    "role": "member",
    "permissions": { "run": true, "browse": false, "sandboxMax": "read-only", "defaultCwd": "/tmp" }
  }')
check "新增账号返回 200" "$USER_CODE" "200"
check "成员账号沙箱上限被记录" "$(jq -r '.user.permissions.sandboxMax' <<<"$(cat "$WORK/user.json")")" "read-only"

echo "==> 新增模型供应商（API Key 必须加密+脱敏落盘）"
FAKE_KEY="sk-smoketest-0123456789abcdef"
ADD_CODE=$(curl -sS -o "$WORK/provider.json" -w '%{http_code}' -b "$COOKIE" -X POST "$BASE/api/admin/models" \
  -H 'Content-Type: application/json' -d "{
    \"id\": \"deepseek\",
    \"name\": \"DeepSeek\",
    \"baseUrl\": \"https://api.deepseek.com\",
    \"wireApi\": \"responses\",
    \"envKey\": \"DEEPSEEK_API_KEY\",
    \"models\": [\"deepseek-chat\", \"deepseek-reasoner\"],
    \"defaultModel\": \"deepseek-chat\",
    \"apiKey\": \"$FAKE_KEY\"
  }")
check "新增供应商返回 200" "$ADD_CODE" "200"
check "接口只返回脱敏值" "$(jq -r '.provider.apiKeyMask' <<<"$(cat "$WORK/provider.json")")" "sk-****cdef"
check "配置文件里是密文" "$(grep -c 'enc:v1:' "$WORK/config.json")" "1"
check "配置文件里没有明文密钥" "$(grep -c "$FAKE_KEY" "$WORK/config.json" || true)" "0"
check "配置文件权限 600" "$(stat -c '%a' "$WORK/config.json")" "600"
check "models 已能在会话里选到" "$(curl -sS -b "$COOKIE" "$BASE/api/models" | jq -r '.models | length')" "2"

echo "==> 供应商连通性测试走失败分支（不可达地址）"
curl -sS -o /dev/null -b "$COOKIE" -X POST "$BASE/api/admin/models/deepseek" \
  -H 'Content-Type: application/json' -d '{"baseUrl":"http://127.0.0.1:1"}' >/dev/null
TEST_RESULT=$(curl -sS -b "$COOKIE" -X POST "$BASE/api/admin/models/deepseek/test" -H 'Content-Type: application/json' -d '{}')
check "测试接口返回 ok=false" "$(jq -r '.ok' <<<"$TEST_RESULT")" "false"

echo "==> 本机权限策略：限制工作目录"
POLICY_CODE=$(curl -sS -o "$WORK/policy.json" -w '%{http_code}' -b "$COOKIE" -X POST "$BASE/api/admin/policy" \
  -H 'Content-Type: application/json' -d "{
    \"policy\": {
      \"enabled\": true,
      \"allowedRoots\": [\"$WORK/ws\"],
      \"browseRoots\": [\"$WORK/ws\"],
      \"denyCommands\": [\"rm\\\\s+-rf\\\\s+/(\\\\s|\$)\"],
      \"protectPaths\": [\"/etc\", \"/root/.ssh\"],
      \"maxRunMinutes\": 5,
      \"allowNetwork\": false,
      \"audit\": true
    },
    \"limits\": { \"maxConcurrentRuns\": 3, \"maxConcurrentRunsPerUser\": 2 }
  }")
check "保存策略返回 200" "$POLICY_CODE" "200"
check "策略里的联网开关已生效" "$(jq -r '.policy.allowNetwork' <<<"$(cat "$WORK/policy.json")")" "false"

echo "==> 越界目录的任务要被拒绝"
OUT_CODE=$(curl -sS -o "$WORK/out.json" -w '%{http_code}' -b "$COOKIE" -X POST "$BASE/api/run" \
  -H 'Content-Type: application/json' -d '{"prompt":"hi","cwd":"/etc"}')
check "越界 cwd 返回 403" "$OUT_CODE" "403"
check "越界目录不能被浏览" "$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/api/fs?path=/etc")" "403"

echo "==> 命中禁止命令的任务要被实时终止"
curl -sS -N --max-time 30 -b "$COOKIE" -X POST "$BASE/api/run" \
  -H 'Content-Type: application/json' -d "{\"prompt\":\"run something dangerous\",\"cwd\":\"$WORK/ws\",\"model\":\"deepseek-chat\"}" \
  > "$WORK/stream.txt" || true
check "SSE 出现 policy.blocked" "$(grep -c 'policy.blocked' "$WORK/stream.txt" || true)" "1"
check "SSE 里没有明文密钥" "$(grep -c "$FAKE_KEY" "$WORK/stream.txt" || true)" "0"
check "命令行里带上了供应商配置" \
  "$(grep -c 'model_providers\.deepseek\.env_key="DEEPSEEK_API_KEY"' "$WORK/argv.txt" || true)" "1"
check "命令行里没有明文密钥" "$(grep -c "$FAKE_KEY" "$WORK/argv.txt" || true)" "0"
check "子进程环境变量里有密钥" "$(grep -c "DEEPSEEK_API_KEY=$FAKE_KEY" "$WORK/env.txt" || true)" "1"

echo "==> 审计日志"
sleep 0.3
AUDIT=$(curl -sS -b "$COOKIE" "$BASE/api/admin/audit?limit=10")
check "审计里有被拦截的任务" "$(jq -r '[.entries[] | select(.blockedReason=="policy")] | length' <<<"$AUDIT")" "1"
check "审计不记录明文密钥" "$(grep -c "$FAKE_KEY" <<<"$AUDIT" || true)" "0"

echo
echo "通过 $PASS 项，失败 $FAIL 项"
[[ "$FAIL" -eq 0 ]] || { echo "服务日志："; tail -30 "$LOG"; exit 1; }
