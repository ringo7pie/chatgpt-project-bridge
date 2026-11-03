#!/usr/bin/env bash
# 1プロジェクト分の対話セットアップを同梱Pythonへ安全に委譲する。
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" # 実体解決済みのスクリプト配置先。
exec python3 -u "${script_dir}/project-bridge.py" add-project "$@"
