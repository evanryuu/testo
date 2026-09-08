#!/bin/zsh
set -e
workspace_dir="${0:A:h}"
cd "$workspace_dir"
electron_bin="$workspace_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$electron_bin" || ! -f "$workspace_dir/dist/src/main/index.js" || ! -f "$workspace_dir/dist-ui/index.html" || ! -f "$workspace_dir/dist-preview/index.html" ]]; then
  print "请先按 README.md 安装依赖并编译桌面应用。"
  read "?按回车键退出。"
  exit 1
fi
exec env -u ELECTRON_RUN_AS_NODE "$electron_bin" "$workspace_dir"
