# chatgpt-project-bridge

ChatGPT から、承認済みのプロジェクトの文書と Git 情報を、読み取り専用の MCP（Model Context Protocol）で読ませるための配布ソース。
例外は 2.7.0 の Claude Code のジョブ（`claudeCode` を承認したプロジェクトだけ、ChatGPT から Claude Code を起動できる）。2.9.0 で、計画を立ててから実装させる流れのために、読み取り専用の `get_claude_code_settings`（使える範囲の確認）を足した。2.10.0 で、`start_claude_job` に省略可の `model`・`effort` を足した（ChatGPT がジョブごとにモデルと思考の深さを選べる。値はコードで固定した許可リストで、設定のキーは増やさず、承認の指紋は変わらない）。
版は `distribution.json` の `version`。Windows と Ubuntu の両方へ、Bundle（インストーラー付き）として配る。

## 構成

| パス | 内容 |
|---|---|
| `scripts/server.mjs` | ライブ MCP サーバー（単一モード・ハブモード）。公開範囲の判定と秘密値マスクを持つ |
| `scripts/bridge-*.mjs` | 2.5.0・2.6.0・2.7.0 の追加ツール。`bridge-tool-definitions`（定義）・`bridge-git`（Git 層。`get_git_diff` を含む）・`bridge-analysis`（分析）・`bridge-source`・`bridge-source-io`（ソースの検索・読み取り・ログ。ファイルには `server.mjs` の境界だけを通して触れる）・`bridge-claude-jobs`（Claude Code のジョブと、2.9.0 の `get_claude_code_settings`。実行はランナー `claude-job-runner.mjs`）・`bridge-tools-common`（共通） |
| `scripts/offline-bridge.mjs`・`snapshot-*.mjs` | 終了時保存（スナップショット）。受信側は `snapshot-relay.mjs` |
| `scripts/project-bridge.{py,ps1,sh}`・`project-bridge-gui.*` | 管理 CLI と GUI（Ubuntu は Python、Windows は PowerShell）。2.8.0 の `SetPermission`・`HubPermissions` が設定を変えるときの変換は `bridge-permission.mjs`（両 CLI が node で呼ぶ） |
| `scripts/install-ubuntu.sh`・`install-windows.ps1` | インストーラー（Bundle の中で実行する） |
| `distribution.json`・`SHA256SUMS.txt` | 配布するファイルと mode の一覧と、その hash（静的ファイル） |
| `references/`・`assets/` | 手順書・変更履歴・テンプレート |
| `knowledge/` | ナレッジベース本体（作者の環境の記録。GitHub の公開リポジトリには含めない） |
| `.github/workflows/ci.yml`・`docs/`・`LICENSE`・`SECURITY.md` | GitHub の公開用（2.10.1）。`README.md` は英語、日本語の手引きは `README.ja.md` |

## ビルドとテスト

ビルドは無い。試験は Node で実行する。環境の制約と手順は `knowledge/10-silver/areas/` に置く（公開リポジトリには無い）。

- `node scripts/security-selftest.mjs`・`server-boundary-selftest.mjs`・`snapshot-hooks-selftest.mjs`・
  `snapshot-publisher-selftest.mjs`（openssl 必須）・`snapshot-relay-selftest.mjs`（Linux のみ）。
- 2.5.0 以降のツール: `tools-selftest.mjs`・`git-tools-selftest.mjs`・`analysis-selftest.mjs`、2.6.0 のソース読み取りは `source-tools-selftest.mjs`、2.7.0 の Claude Code のジョブは `claude-jobs-selftest.mjs`（偽の claude を使い、本物は起動しない。どちらも引数に試験名の一部を渡すと、その試験だけ実行する）、2.8.0 の権限の切り替え（管理 CLI の `SetPermission`・`HubPermissions` と `bridge-permission.mjs`）は `permission-cli-selftest.mjs`（その OS の CLI を一時の APPDATA・XDG で実際に起動する。Windows は pwsh、Linux は python3 が要る）。点検は `tools-smoke.mjs --hub <hub.json>`。
- 管理画面の試験: `python scripts/gui-selftest-windows-static.py`（どの OS でも。ps1 の静的検査）、`gui-selftest.py`・`workflow-selftest.py`（Linux のみ。GTK は画面なしの broadwayd で動く）。
  `linux-security-selftest.mjs` は Windows で実行しない（一時ディレクトリが残る）。
- 配布物（Bundle）: `bash scripts/project-bridge.sh export-bundle --output-path <Skill の外のフォルダー>`。

## 常時ロードされる知識

作者の環境の知識は、非公開の `CLAUDE.local.md` が読み込む（GitHub の公開リポジトリには含めない）。

## GitHub への公開

公開リポジトリ（`ringo7pie/chatgpt-project-bridge`）は、私的リポジトリの履歴を持たないスナップショットで、`tools/export-public.ps1` だけで更新する（除外と禁止語句は `tools/export-public.json`。どちらも公開しない）。公開するファイルに、作者の PC 名・ユーザー名・IP・非公開のプロジェクト名を書かない。
