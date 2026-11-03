#!/usr/bin/env bash
# ローカルプロジェクトを、このPCのハブ（1つのTunnel・App・Runtime API Key）へ追加する処理を同梱Pythonへ委譲する。
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" # 実体解決済みのスクリプト配置先。
exec python3 -u "${script_dir}/project-bridge.py" hub-add "$@"
