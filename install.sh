#!/usr/bin/env bash









set -euo pipefail

TARGET="${REPOCTX_TARGET:-$HOME/.agent-skills/repo-context}"
WITH_DEPS=0

for arg in "$@"; do
  case "$arg" in
    --with-deps) WITH_DEPS=1 ;;
    --target=*)  TARGET="${arg#*=}" ;;
    -h|--help)   sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（-h 查看用法）" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== repo-context 安装 =="
echo "  源  : $HERE"
echo "  目标: $TARGET"

mkdir -p "$TARGET/scripts"
cp -f "$HERE/SKILL.md" "$TARGET/"
cp -f "$HERE/package.json" "$TARGET/" 2>/dev/null || true
cp -f "$HERE/package-lock.json" "$TARGET/" 2>/dev/null || true
cp -R "$HERE/scripts/." "$TARGET/scripts/"
[ -d "$HERE/docs" ] && cp -R "$HERE/docs" "$TARGET/"

if [ -d "$HERE/node_modules/tree-sitter-wasms" ]; then
  echo "  含 node_modules（AST 增强）→ 一并复制"
  cp -R "$HERE/node_modules" "$TARGET/"
elif [ "$WITH_DEPS" -eq 1 ]; then
  echo "  本包不含 node_modules 且指定 --with-deps → 在目标目录执行 npm install"
  ( cd "$TARGET" && npm install --no-audit --no-fund )
else
  echo "  未带 node_modules 且未指定 --with-deps → 使用行级抽取（功能完整、精度略低）"
fi

echo ""
echo "完成。用法（在任意 git 仓库目录）："
echo "  node \"$TARGET/scripts/repoctx.mjs\" index"
echo "  node \"$TARGET/scripts/repoctx.mjs\" for \"<english keywords>\""
echo "  node \"$TARGET/scripts/repoctx.mjs\" impact <符号名> --depth 3"
echo "自测：  cd \"$TARGET\" && npm test"
