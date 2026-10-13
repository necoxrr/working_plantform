#!/usr/bin/env bash
#
# 云端模式一键回归
#
# 做四件事：
#   1. 用本地库快照把云端重置成可预期的基线
#   2. 用云端模式在独立端口起一个服务实例
#   3. 跑完整端到端断言（tests/e2e.js）
#   4. 无论成败，再把云端重置回本地库的样子，不留测试残留
#
# 用法：
#   ./scripts/e2e-cloud.sh
#   PORT=5971 ./scripts/e2e-cloud.sh
#
# 需要 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN；没有的话会尝试从 .env.local 读。
# 本地库路径同 server/db.js 的规则，可用 DB_PATH / DATA_DIR 覆盖。
#
# 安全约定：本脚本只用「独立端口」起实例，绝不碰 3000/3100 这些日常端口；
# 云端数据在跑完后会被重置为本地库的副本，不会留下测试数据。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${TURSO_DATABASE_URL:-}" ] && [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi
: "${TURSO_DATABASE_URL:?需要 TURSO_DATABASE_URL（或写进 .env.local）}"
: "${TURSO_AUTH_TOKEN:?需要 TURSO_AUTH_TOKEN（或写进 .env.local）}"

NODE="${NODE:-node}"
PORT="${PORT:-5971}"
BASE="http://127.0.0.1:${PORT}"
mkdir -p .workbuddy
LOG=".workbuddy/e2e-cloud-${PORT}.log"

cleanup() {
  if [ -n "${SRV:-}" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
}
trap cleanup EXIT

# 本地库路径（与 server/db.js 保持一致）
LOCAL_DB="$("$NODE" -e '
  const os=require("os"), path=require("path");
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), ".work-manager");
  console.log(process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dir, "work.db"));
')"
BASELINE="$("$NODE" -e '
  const {DatabaseSync}=require("node:sqlite");
  const d=new DatabaseSync(process.argv[1],{readOnly:true});
  console.log(d.prepare("SELECT COUNT(*) c FROM tasks").get().c);
' "$LOCAL_DB" 2>/dev/null)"
echo "本地库：$LOCAL_DB（基线任务数 $BASELINE）"

echo ""
echo "→ 1/4 用本地库快照重置云端"
"$NODE" --no-warnings server/migrate-to-cloud.js --force

echo ""
echo "→ 2/4 启动服务（端口 ${PORT}）"
PORT="$PORT" "$NODE" --no-warnings server/index.js > "$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE/login.html"; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "$BASE/login.html"; then
  echo "服务没起来，日志："; cat "$LOG"; exit 1
fi
echo "服务已就绪"

echo ""
echo "→ 3/4 跑端到端断言"
TEST_RC=0
BASE="$BASE" EXPECT_DRIVER=remote BASELINE_TASKS="$BASELINE" \
  "$NODE" --no-warnings tests/e2e.js || TEST_RC=$?

echo ""
echo "→ 4/4 把云端重置回本地库的样子（清掉测试数据）"
"$NODE" --no-warnings server/migrate-to-cloud.js --force

if [ "$TEST_RC" -ne 0 ]; then
  echo ""; echo "✘ 测试未全部通过（退出码 $TEST_RC）"
  exit "$TEST_RC"
fi
echo ""; echo "✅ 云端模式回归全部通过"
