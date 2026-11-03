# chatgpt-project-bridge プロジェクト概要

最終確認日：2026-11-03

## 目的

ChatGPT から、利用者が承認したローカルのプロジェクトの文書・Git の状態・（許可したときは）ソースを、読み取り専用の MCP で読めるようにする。利用者が `claudeCode` を承認したプロジェクトだけ、ChatGPT から Claude Code のジョブを起動できる。

## 技術構成

- MCP サーバー: Node.js 18 以上（組み込みモジュールだけ。npm の依存なし）。`scripts/server.mjs` と `scripts/bridge-*.mjs`。
- 接続: OpenAI Secure MCP Tunnel（`openai/tunnel-client`。版と SHA-256 を `dependencies.lock.json` で固定）。
- 管理 CLI と管理画面: Windows は PowerShell 7（Windows Forms）、Ubuntu は Python 3（GTK 3）。設定の変換は共通の `scripts/bridge-permission.mjs`。
- 配布: `distribution.json` の一覧から作る Bundle（Windows は zip と `install.ps1`、Ubuntu は tar.gz と `install.sh`）。

## 主要構成

- `scripts/server.mjs`: 単一モードとハブモードの MCP サーバー。公開範囲の判定、承認の指紋の照合、秘密値のマスク。
- `scripts/bridge-git.mjs`・`bridge-analysis.mjs`・`bridge-source*.mjs`: Git・分析・ソース読み取りのツール。
- `scripts/bridge-claude-jobs.mjs`・`claude-job-runner.mjs`: Claude Code のジョブ。
- `scripts/project-bridge.*`・`project-bridge-gui.*`・`install-*`: 管理 CLI・管理画面・インストーラー。
- `scripts/*-selftest.*`: 自己試験。`references/`: 手引きと変更履歴。

## 設計方針・制約

- 既定は読み取り専用。公開範囲を正規化した SHA-256 の指紋を、プロジェクトの外の承認と照合し、一致しないときは全ツールが応答しない。
- 新しい設定は、あるときだけ指紋に入れる（既存の承認を失効させない）。
- 秘密の名前・リンク・実行を伴う `.git/config` は、許可リストより優先して拒否する。
- Claude Code は `dontAsk` と生成した設定で動かし、許可したコマンドだけを実行させる。git の書き込みはさせない。
- Windows と Ubuntu で同じサーバーを使い、管理ツールはそれぞれの OS のものにする。

## ChatGPTへ相談するときの注意

- この文書と `CHATGPT_PROJECT_STATUS.md` の更新日時を確認する。
- 現在のGit情報は `get_project_status` または `get_recent_changes` のライブ値を優先する。
- 不明な事項を過去の会話から推測しない。
