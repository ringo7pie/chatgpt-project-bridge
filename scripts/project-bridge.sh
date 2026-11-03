#!/usr/bin/env bash
# Ubuntuでは常に同梱Python CLIを使い、引数を文字列再評価せずそのまま渡す。
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" # 実体解決済みscriptsディレクトリ。
exec python3 -u "${script_dir}/project-bridge.py" "$@"
