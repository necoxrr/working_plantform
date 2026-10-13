#!/usr/bin/env bash
#
# 本地模式一键回归
#
# 用「真实库的一份隔离副本」起一个本地模式实例，跑完整端到端断言。
# 真实库只读（脚本从不写它），测试数据全部落在副本里，跑完即删。
#
# 用法：
#   ./scripts/e2e-local.sh
#   PORT=5972 ./scripts/e2e-local.sh
#
# 安全约定：只用独立端口（默认 5972），绝不碰 3000/3100 这些日常端口。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-node}"
PORT="${PORT:-5972}"
BASE="http://127.0.0.1:${PORT}"
WORK=".workbuddy/e2e-local"
mkdir -p "$WORK"

cleanup() {
  if [ -n "${SRV:-}" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
}
trap cleanup EXIT

# 真实库路径（与 server/db.js 规则一致）
REAL_DB="$("$NODE" -e '
  const os=require("os"), path=require("path");
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), ".work-manager");
  console.log(process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dir, "work.db"));
')"
TEST_DB="$PWD/$WORK/work.db"

echo "真实库（只读）：$REAL_DB"
echo "测试副本：     $TEST_DB"
cp "$REAL_DB" "$TEST_DB"

BASELINE="$("$NODE" -e '
  const {DatabaseSync}=require("node:sqlite");
  const d=new DatabaseSync(process.argv[1],{readOnly:true});
  console.log(d.prepare("SELECT COUNT(*) c FROM tasks").get().c);
' "$TEST_DB")"
echo "基线任务数：$BASELINE"

echo ""
echo "→ 1/2 启动本地模式服务（端口 ${PORT}）"
DB_PATH="$TEST_DB" PORT="$PORT" "$NODE" --no-warnings server/index.js > "$WORK/server.log" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$BASE/login.html"; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "$BASE/login.html"; then
  echo "服务没起来，日志："; cat "$WORK/server.log"; exit 1
fi
echo "服务已就绪"

echo ""
echo "→ 2/2 跑端到端断言"
BASE="$BASE" EXPECT_DRIVER=local BASELINE_TASKS="$BASELINE" \
  "$NODE" --no-warnings tests/e2e.js

echo ""
echo "→ 清理测试副本"
# 删不掉也无所谓（某些环境有删除保护），下次运行会被 cp 直接覆盖
rm -f "$TEST_DB" "$TEST_DB-journal" "$TEST_DB-wal" "$TEST_DB-shm" 2>/dev/null || true
echo "✅ 本地模式回归全部通过（真实库全程未被写入）"
