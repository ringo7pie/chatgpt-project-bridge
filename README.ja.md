# ChatGPT Project Bridge 2.10.1

English: [README.md](README.md)

このリポジトリ（と Bundle の Skill archive）は、ソース一式です。Windows・Ubuntu 用の管理ツール、管理画面（GUI）、インストーラーを含みます。ChatGPT・OpenAI・Claude・Anthropic とは無関係の、非公式のツールです（商標は各社のものです）。

2.10.1 は、GitHub での公開のための整備をした版です。動作（サーバー・管理 CLI・GUI・インストーラー）は 2.10.0 と同じで、ChatGPT の「ツールを更新」も、再承認も要りません。
- 英語の [README.md](README.md) を足し、この日本語の手引きを `README.ja.md` にしました（Bundle にも両方が入ります）。
- `LICENSE`（MIT）を足しました。リポジトリには、ほかに [SECURITY.md](SECURITY.md)・[docs/portfolio.md](docs/portfolio.md)・GitHub Actions の CI（`.github/workflows/ci.yml`）があります（Bundle には入れません）。
- 文書と試験の入力から、作者の環境に固有の名前（PC 名・プラグイン名・プロジェクト名・ユーザーフォルダー名）を除きました。試験の件数は変わりません。

2.10.0 は、ChatGPT が `start_claude_job` で、Claude Code の**モデル**（`model`。`fable`・`opus`・`sonnet`・`haiku` か `claude-fable-5-1` のような小文字の正式名）と**思考の深さ**（`effort`。`low`・`medium`・`high`・`xhigh`・`max`）を、ジョブごとに指定できるようにした版です。ツールの数は変わらず（ハブでは 31 個）、**ツールの定義が変わるので、ChatGPT の「ツールを更新」が要ります**（ハブごとに作ったプラグインのすべて。たとえば Windows 用と Ubuntu 用）。
- 追加した引数は両方とも省略可です。省略したときの優先順位は、`start_claude_job` の引数 > 続きの依頼（`continueJobId`）では前のジョブが**引数で選んだ**値 > プロジェクトの設定 `claudeCode.model`・`claudeCode.effort` > Claude Code の既定、です。出どころは `get_claude_job` の `modelSource`・`effortSource`（`request`・`continued`・`project`・`default`）に出ます。
- 受け付ける値はコードで固定した許可リストです（大文字・別の形は `invalid_argument`）。**設定のキーは増やしていないので、承認の指紋は変わらず、再承認は要りません。** 選べる値は `get_claude_code_settings` の `modelChoices`・`effortChoices` で ChatGPT が確かめられます。
- `get_claude_job` の `model` は Claude Code が報告した実際のモデル、新しい `requestedModel` は `--model` に渡した値です。設定の `model` に書ける `sonnet[1m]` のような添え字つきの名前は、設定でだけ使えます（ChatGPT の引数では使えません）。
- 上位のモデル（`fable`・`opus`）や高い effort（`xhigh`・`max`）ほど、この PC の Claude Code の利用枠を多く消費します。制限時間（`maxMinutes`）と予算の上限は、引数では変えられません。モデルと effort の組み合わせの規則は持たないので、Claude Code が拒否した組み合わせは `failed`（`stderrTail` に理由）になります。
- 試験: `node scripts/claude-jobs-selftest.mjs`（297 件。引数の検証・優先順位・続きの依頼での引き継ぎ・検証がジョブの記録や起動より前にあること・指紋が変わらないことの試験を足しました）。変更内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.10.0」にあります。

2.9.0 は、「ChatGPT で計画（PLAN）を作り、MCP 経由でその計画を Claude Code に実装させる」流れを成立させる版です。ツールを 1 個足し（ハブでは 31 個）、ツールの説明に手順を書きました。**ChatGPT の「ツールを更新」が要ります**（ハブごとに作ったプラグインのすべて）。
- 新ツール `get_claude_code_settings`（**読み取り専用**）: 計画を書く**前**に、そのプロジェクトで Claude Code が使えるか（利用者の承認）と、使える範囲を返します。有効なときだけ、許可コマンドの形・1 ジョブの制限時間（`maxMinutes`）・モデルと effort・動いているジョブの数・結果の確認に使える手段（`get_git_diff`・`read_source` の公開可否）・コマンドの規則と編集の範囲の説明を返します。無効なプロジェクトでもエラーにせず `enabled: false` だけを返します（中身は返しません）。予算の上限は金額を返さず、有無（`hasBudgetLimit`）だけです。
- これまでは、許可コマンドと制限時間を ChatGPT が知るのは `start_claude_job` を呼んだ**後**でした。計画の「確認の方法」を、許可された形のとおりに書けるようになります。
- `start_claude_job` の説明と、サーバーの初期化の説明に、手順を書きました: ① `get_claude_code_settings` で確認 → ② `list_source_files`・`search_code`・`read_source` で調べて計画を作る → ③ **計画を利用者に見せて承認を得てから**起動（計画を `prompt` に渡す。最大 20000 文字） → ④ `get_claude_job`・`read_claude_job_log` で進み具合、終わったら `get_git_diff`（`unstaged`）と `read_source` で計画との差を確かめる → ⑤ 差があれば `continueJobId` で修正を依頼 → ⑥ commit・push は利用者が行う。計画のひな形は、目的・変更するファイルと内容・手順・確認のコマンド（許可された形のとおり）・やらないこと・最後の報告に含めること、です。
- 新しい権限のキーは作りません。承認の指紋は 2.8.0 と同じです（再承認は要りません）。既存の 30 ツールの名前・引数・応答は変えていません（`start_claude_job` は説明の文だけを変えました）。Claude Code の動かし方（`dontAsk`・allow/deny）も変えていません。
- 試験: `node scripts/claude-jobs-selftest.mjs`（213 件。新ツールの試験を足しました）。実機への導入前に、使い捨てのプロジェクトで、本物の Claude Code を使った通し試験（設定の確認 → 計画の実装 → 差分の確認 → 続きの依頼）を行いました。変更内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.9.0」にあります。

2.8.0 は、プロジェクトごとの「ChatGPT からソースの本文を読めるか」「ChatGPT から Claude Code を起動できるか」を、管理画面（GUI）の一覧で**確認し、On / Off で切り替えられる**ようにした版です。ツールの定義は変えていません（ChatGPT の「ツールを更新」は要りません）。
- 管理 CLI に Action を 2 つ足しました: `HubPermissions`（Ubuntu は `hub-permissions`。ハブの全プロジェクトの権限と承認の状態を JSON で出す。読み取り専用）と、`SetPermission`（`set-permission`。権限の切り替え）。
- **設定の変更と承認を、1 つの操作にしました。** 設定を変えると承認の指紋が変わるので、「設定を書く → 承認する」の順だと、承認のダイアログでキャンセルしたときに、そのプロジェクトが未承認のまま ChatGPT から使えなくなります（Off にする場合も同じ）。`SetPermission` は、指紋なしでは何も書かずに変更後の公開範囲だけを出し、承認された指紋を付けたときだけ、設定を書いて承認を保存します（途中で失敗したら設定を元に戻します）。キャンセルすれば何も変わりません。
- 管理画面の「かんたん」タブの一覧に、「ソースの読み取り」「Claude Code」「承認」の列と、「権限を確認」「ソースの読み取りを切り替え」「Claude Code の起動を切り替え」のボタンを足しました（[setup.md](references/setup.md) の「権限の切り替え」）。画面自身は、設定も承認も書きません（CLI を呼ぶだけで、承認は利用者がダイアログで押したときだけです）。
- On / Off の意味: **ソースの読み取り On** = `detailExposure.sourceText` と `gitExposure.paths` を許可、**Off** = `sourceText` だけ止める（ファイル名の公開 `paths` は残る）。**Claude Code On** = `claudeCode.enabled: true`（`claudeCode` が無ければ、許可コマンドなし＝ファイルの編集だけで作る）、**Off** = `enabled: false`（許可コマンドなどは残る）。
- 設定の変換（on / off の規則・未知のキーとキーの順を保つ・厳密な UTF-8）は `scripts/bridge-permission.mjs` 1 か所に置き、Windows と Ubuntu の CLI が同じものを使います。Windows では、Hidden 属性のファイルにも書け、書いたあとも属性を保ちます。
- Claude Code のジョブ（2.7.0）の改善: 許可コマンドの一覧を、Claude Code のシステムプロンプトにも書き添えます（許可された形のとおりにコマンドを書かせ、拒否される試行を減らすため）。
- 管理画面の承認ダイアログに、`detailExposure`（ソースの本文・差分の抜粋・ブランチ名の公開）の専用の行を足しました（いままで「その他の項目」に生の JSON で出ていました）。
- 試験: `node scripts/permission-cli-selftest.mjs`（その OS の CLI を実際に起動して試す。Windows は `project-bridge.ps1`、Linux は `project-bridge.py`）。変更内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.8.0」にあります。

2.7.0 は、ChatGPT から、この PC の Claude Code を起動して作業（修正・デバッグ・テスト）をさせられるようにした版です。新ツールは 5 個です（`start_claude_job`・`get_claude_job`・`read_claude_job_log`・`cancel_claude_job`・`list_claude_jobs`）。
**既定では従来どおり読み取り専用です。** 使えるのは、利用者がプロジェクトの設定に `claudeCode.enabled: true` を書き、PC で承認したプロジェクトだけです。そのプロジェクトでは、Claude Code が作業ツリーのファイルを直接書き換え、設定の `allowedCommands` に書いたコマンドだけを確認なしで実行します。git の commit・push はできません。
既存の 25 ツールの名前・引数・応答は変えていません。`claudeCode` を書かないプロジェクトは承認の指紋が 2.6.0 と同じで、既存の承認は有効なままです。
仕組み・設定・残るリスクは下の「[2.7.0 で追加した Claude Code のジョブ](#270-で追加した-claude-code-のジョブ)」、変更の内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.7.0」にあります。

2.6.0 は、ChatGPT が承認済みプロジェクトのソースコード・設定・設計資料・Knowledge・Git の差分・テストログを、**検索して必要な範囲だけ読める**ようにした版です。
読み取り専用の新ツールを 6 個追加しました（`list_source_files`・`search_code`・`read_source`・`find_references`・`get_git_diff`・`read_test_log`）。**ChatGPT からソースやリソースへの書き込み・削除・コマンドの実行はできません。**
既存の 19 ツール（既存 9 + 2.5.0 の 10）の名前・引数・応答は変えていません。新しい権限のキーは作らず、既存の `detailExposure.sourceText` と `gitExposure.paths` を使います。
**そのため、`sourceText` と `paths` を許可済みのプロジェクトでは、2.6.0 を導入して ChatGPT で「ツールを更新」するだけで、再承認なしにソース全体を検索・読み取りできるようになります。** 止めたいプロジェクトは `sourceText` を `false` にして承認し直してください。
引数・返却例・設定は下の「[2.6.0 で追加したソース読み取りツール](#260-で追加したソース読み取りツール)」、変更の内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.6.0」にあります。

2.5.0 は、ChatGPT が承認済みプロジェクトの現状（ブランチ、差分の規模、未コミット変更、最近の活動、構造、実装状況、課題、テスト記録）を、根拠付きで詳しく読めるようにした版です。
読み取り専用の新ツールを 10 個追加しました（`get_git_branches`・`get_branch_details`・`compare_branches`・`get_worktree_details`・`get_recent_activity`・`get_project_overview`・`get_project_structure`・`get_project_tasks`・`get_project_validation`・`get_portfolio_summary`）。
既存の 9 ツールの名前・引数・応答は変えていません。ブランチ名・差分の抜粋・ファイル本文は、`detailExposure` で個別に許可したときだけ返します（既定はすべて非公開で、既存の承認は有効なままです）。
引数・返却例・エラー例は下の「[2.5.0 で追加した読み取りツール](#250-で追加した読み取りツール)」、変更の内容と検証結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.5.0」にあります。

2.4.3 は、Windows の管理画面をコンソールから起動して Ctrl+C で止めると、「ハンドルされていない例外」のダイアログが出続けて閉じられなくなる問題への対応です。
コンソールの Ctrl+C（と Ctrl+Break）を画面が受け取り、画面を閉じるときと同じ手順で閉じます。
内容は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.4.3」にあります。

2.4.2 は、PC を再起動したあとハブが止まったままになり、ChatGPT から接続できなくなる問題への対応です。
自動起動の登録状態を、Windows の `HubStatus`・`HubDoctor`・インストーラーと、Ubuntu の `hub-doctor`・インストーラーに表示します（未登録でも自動では登録しません）。
Ubuntu の `hub-service-install` は、linger の有効化と、起動時のネットワーク待ちも行います。
内容は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.4.2」にあります。

2.4.1 は、2.4.0（ChatGPT による改修）を Claude Code が読み取りで監査し、運用面・起動判定・秘密値マスク・一覧の通知を修正した版です。
内容と、修正前後の試験結果は [改修内容と検証結果](references/CHANGELOG-2.4.0.md) の末尾「2.4.1」にあります。

## 2.7.0 で追加した Claude Code のジョブ

ChatGPT が計画を立て、この PC の Claude Code に作業させ、結果を `get_git_diff`（2.6.0）で確かめる、という使い方のためのツールです。
Claude Code は非対話（`claude -p`）で、ハブとは別のプロセスとして動きます。`start_claude_job` はすぐに `jobId` を返し、ChatGPT は状態と経過をあとから取得します（ハブは要求を 1 件ずつ処理するので、Claude Code の終了を待ちません）。

| ツール | 内容 | 注釈 |
|---|---|---|
| `start_claude_job` | 依頼文（`prompt`、20000 文字まで）でジョブを開始し、`jobId` を返す。`continueJobId` に終わったジョブを渡すと、その会話の続き（`--resume`）になる。省略可の `model`・`effort`（2.10.0）で、ジョブごとにモデルと思考の深さを選べる | 読み取り専用ではない（書き換えあり） |
| `get_claude_job` | 状態（`queued`・`running`・`succeeded`・`failed`・`cancelled`・`timeout`・`interrupted`）・経過時間・Claude Code の最後の報告・拒否された操作・推定コスト・Claude Code が編集したファイル・作業ツリーの変更（開始前からあった変更 `preexistingAtStart` と、開始後に増えた変更 `newSinceStart`） | 読み取り専用 |
| `read_claude_job_log` | 経過の要約（Claude Code の文章・ツールの呼び出しの対象（ファイル・コマンド）・拒否・最終結果）。`cursor` で続きを取得 | 読み取り専用 |
| `cancel_claude_job` | Claude Code を子プロセスごと止める（書き換えたファイルは戻らない） | 読み取り専用ではない |
| `list_claude_jobs` | このプロジェクトのジョブの一覧（新しい順） | 読み取り専用 |
| `get_claude_code_settings`（2.9.0） | 計画を書く前の確認。Claude Code が使えるか・許可コマンド・制限時間・動いているジョブの数・結果の確認に使える手段・`start_claude_job` に渡せるモデルと effort の選択肢（`modelChoices`・`effortChoices`。2.10.0）。無効でもエラーにせず `enabled: false`（中身は返さない） | 読み取り専用 |

ハブでは `project` が必須です。6 個（2.7.0 の 5 個と 2.9.0 の `get_claude_code_settings`）は全プロジェクトの一覧に並びますが（ツールの一覧は起動時に固定されるため）、`claudeCode` を承認していないプロジェクトでは、`get_claude_code_settings` 以外は `permission_denied`（`meta.hidden` に `claudeCode`）です。

### 有効にする（利用者が PC で行う）

プロジェクトの `.chatgpt-project-bridge.json` に `claudeCode` を足し、`--print-exposure` の指紋で承認し直します（承認の画面に、許可するコマンドの一覧と警告が出ます）。ChatGPT から設定や承認は変えられません。

```json
"claudeCode": {
  "enabled": true,
  "allowedCommands": ["node scripts/*-selftest.mjs", "git status", "git diff *"],
  "model": "sonnet",
  "effort": "high",
  "maxMinutes": 30,
  "maxBudgetUsd": 5
}
```

| 項目 | 意味 |
|---|---|
| `enabled` | `true` のときだけジョブを開始できる（既定 `false`） |
| `allowedCommands` | Claude Code が確認なしで実行してよいコマンドのパターン（Claude Code の `Bash(...)`・`PowerShell(...)` の許可ルールの中身。`*` が任意の文字列）。空なら、コマンドを実行するツール自体を渡さない（ファイルの編集だけ）。次は書けない（設定全体を拒否する）: `*` だけ、先頭がシェル・中継・通信・権限昇格のもの（`bash`・`sh`・`pwsh`・`powershell`・`cmd`・`wsl`・`env`・`sudo`・`ssh`・`curl`・`wget`・`npx`・`xargs`・`claude` など）、git の書き込み系（`commit`・`push`・`reset`・`checkout`・`switch`・`restore`・`clean`・`rebase`・`merge`・`stash`・`tag`・`branch`・`remote`・`config`・`worktree`・`submodule`・`pull`・`fetch` など）、git の `-c`・`-C`、改行・括弧 |
| `model`・`effort` | Claude Code の `--model`・`--effort` の**プロジェクトの既定**。省略すると Claude Code の既定（利用者設定の `model`）。2.10.0 から、ChatGPT は `start_claude_job` の引数 `model`・`effort` でジョブごとに上書きできる（優先順位: 引数 > 続きの依頼で前のジョブが引数で選んだ値 > この設定 > Claude Code の既定）。引数で渡せる値はコードで固定している（`model` は `fable`・`opus`・`sonnet`・`haiku` か `claude-fable-5-1` のような小文字の正式名、`effort` は `low`・`medium`・`high`・`xhigh`・`max`）ので、承認の指紋に入るのはこの設定の値だけで、引数のための設定のキーは無い。`sonnet[1m]` のような添え字つきの名前は、この設定でだけ書ける |
| `maxMinutes` | 1 ジョブの制限時間（1〜180 分、既定 30）。過ぎたら止めて `timeout` |
| `maxBudgetUsd` | Claude Code の `--max-budget-usd`（推定のドル。省略可）。サブスクリプションでの効き方は確認していない |

`claudeCode` のキーがあれば（`enabled: false` でも）承認の指紋に入ります。キーを書かないプロジェクトの指紋は 2.6.0 と同じです。

### Claude Code の起動のしかた

ランナー（`scripts/claude-job-runner.mjs`）が、シェルを介さずに次の形で起動し、依頼文を標準入力で渡します。作業フォルダーはプロジェクトのルートです。

```
claude -p --output-format stream-json --verbose
  --permission-mode dontAsk --permission-prompts none
  --setting-sources user --settings <ジョブの記録>/settings.json
  --strict-mcp-config --no-chrome
  --tools Read,Glob,Grep,Edit,Write,NotebookEdit[,Bash,PowerShell]
  --disallowedTools WebFetch,WebSearch
  --session-id <UUID> | --resume <前のジョブの会話>
  [--model] [--effort] [--max-budget-usd] --append-system-prompt <注意書き>
  （--model・--effort は、start_claude_job の引数 > 続きの依頼で引き継いだ値 > 設定 の順で決め、どれも無ければ付けない）
```

- `dontAsk` と `--permission-prompts none`: 事前に許可した操作と読み取りだけを行い、確認が要る操作はすべて自動で拒否します（拒否は `get_claude_job` の `permissionDenials` に出ます）。
- `--setting-sources user`: 利用者の設定（`~/.claude/settings.json` の hook。たとえば、作業フォルダーやナレッジベースの原本を書き換えさせない hook）は効かせ、プロジェクトの `.claude/settings*.json` は読みません（Claude Code 自身が書き換えうるため）。
- 生成する `settings.json` の allow は、プロジェクトの中の編集（`Edit`）と `allowedCommands` だけです。deny は、ChatGPT に見せない範囲と同じもの（`.git`・`.env`・鍵などの秘密の名前、`knowledge/00-system`・`20-bronze`・`30-gold`、`Prompts/Prompt.txt`、`.chatgpt-project-bridge.json`、`denyDirectories`）の読み取りと編集、`.claude`・`.gitmodules`・`zzz-Temp` の編集、git の書き込み系のコマンド、`WebFetch`・`WebSearch`・MCP です。
- 使わないもの: `--bg`・`-w`（worktree に隔離したときに、終了時に自動で push してドラフト PR を開きうる）、`acceptEdits`（`rm`・`mv` なども自動で許可する）、`bypassPermissions`、`--restricted`（利用者の hook が外れる）、`--bare`（サブスクリプションのログインが使えない）。
- 環境変数は許可リストで渡します。Tunnel Client の鍵（`CONTROL_PLANE_API_KEY`）、`ANTHROPIC_API_KEY` など（あると課金の経路が API に変わる）、名前にトークン・パスワードを含むものは渡しません。
- `claude` は絶対パスで探します（Windows は `%USERPROFILE%\.local\bin\claude.exe`、次に PATH の絶対パスの要素。npm 版の `claude.cmd` は使いません。Linux は `~/.local/bin/claude`、次に PATH。実体の所有者と書き込み権を検査します）。

### 状態・経過・記録

- 1 プロジェクトで同時に動くジョブは 1 件、PC 全体で 2 件までです（`job_limit`）。
- ランナーは 5 秒ごとに状態を書きます。動作中のはずなのに 30 秒以上更新が無いジョブは `interrupted`（ハブの停止・PC の再起動などで止まった）と表示します。
- **ハブが止まると、ジョブも止まります**（Windows はハブの Job object ごと、Ubuntu は systemd のサービスごと止まる）。
- 経過（`read_claude_job_log`）は要約だけです。**ツールの結果の本文（Claude Code が読んだファイルの中身など）と、Edit・Write で書いた本文は返しません**（成否と長さだけ）。文章・コマンドには秘密値のマスクを掛けます。
- 記録の置き場所: Windows は `%LOCALAPPDATA%\chatgpt-project-bridge\claude-jobs\`、Ubuntu は `~/.local/state/chatgpt-project-bridge/claude-jobs/`（利用者だけが読み書きできる。プロジェクトごとに 30 件を残し、古い終了済みのものから消す。経過の記録は 1 ジョブ 32 MiB まで）。依頼文はここに残り、アクセスログと通知には出しません。
- ハブの通知（`notifications.access` か `start`）が有効なら、ジョブの開始を間引かずに通知します。終了の通知は、利用者の Claude Code の `Stop` hook があればそれが出します。

### 残るリスク（承認する前に読む）

- **許可したコマンドが、プロジェクトの中のスクリプトを実行する場合（例: `node scripts/*.mjs`）、Claude Code はそのスクリプトを書き換えてから実行できます。この場合、実質的に任意のコードを実行できます。**
- `cat`・`grep` などの読み取りのコマンドは、Claude Code が常に確認なしで実行します（Claude Code の仕様）。`grep -r` のように名前を指さない読み取りは、deny の読み取りの拒否をすり抜けえます（読んだ内容は経過に返しませんが、Claude Code の報告の文章に含まれる可能性はあります）。
- ソース・文書・ログに仕込まれた指示（プロンプトインジェクション）が、ChatGPT を通して依頼文に入りえます。依頼文は ChatGPT の会話で確かめてください。
- 利用者が同じフォルダーで作業していると、編集が衝突します（ジョブは作業ツリーを直接書き換える）。
- Windows の承認ファイルは ACL を検査しません（同じ利用者で動くプログラムは承認を書き換えうる）。
- ジョブは、この PC の Claude Code のサブスクリプションの利用枠を消費します。`costUsdEstimate` は Claude Code の推定値です。
- 緊急に止めるには: `cancel_claude_job`、ハブの停止（Windows は `-Action HubStop`、Ubuntu は `systemctl --user stop chatgpt-project-bridge-hub.service`。実行中のジョブも止まる）、または `enabled: false` にして承認し直す。

## 2.6.0 で追加したソース読み取りツール

ChatGPT が、承認済みプロジェクトのソースコード・設定・設計資料・Knowledge・テストログ・Git の差分を、**全体を一度に渡さず、検索して必要な範囲だけ読む**ための 6 個のツールです。1 万ファイルを超える依存ライブラリを含むプロジェクトでも、標準では生成物・依存・同梱した第三者のコードを除いて走査します。
**すべて読み取り専用**です。ファイルの変更・削除・作成、コマンドの実行は、この 6 個のツールにはありません（Claude Code の起動は、2.7.0 の別のツールで、`claudeCode` を承認したプロジェクトだけです）。新しいモジュール（`bridge-source.mjs`・`bridge-source-io.mjs`）はファイルを書く・プロセスを起動する部品を読み込まず、Git の実行は既存の許可リスト（読み取りの `diff`・`rev-parse`・`rev-list`・`status` だけを使う）を通ります。Windows と Ubuntu は同じ `scripts/server.mjs` と同じモジュールを使い、引数と応答の形も同一です。

| ツール | 返すもの | 必要な既存の設定 |
|---|---|---|
| `list_source_files` | ファイルの一覧（サイズ・更新日時・言語・サブモジュール名）。ディレクトリ・glob・拡張子で絞り、`cursor` で分割して取得 | `sourceText` + `gitExposure.paths` |
| `search_code` | 固定文字列・正規表現の検索結果（行番号・一致した行・前後の行）。大文字小文字の区別・単語単位・ディレクトリ・glob・拡張子・件数・時間の制限 | 同上 |
| `read_source` | 指定した行範囲の本文（行番号つき）。文字コード・行末・総行数。大きなファイルも範囲を指定して読める | 同上 |
| `find_references` | シンボルの定義の候補と使用箇所（文字列一致ベース。言語仕様上の厳密な参照解析ではない） | 同上 |
| `get_git_diff` | 未コミット（head・staged・unstaged）、ブランチ間・コミット間（range）、「この日時以降」（since）、指定ファイル、サブモジュールの中の差分。変更前後の行と変更範囲 | 上に加えて `diffExcerpts`（ブランチ名で指定するときは `branchNames`） |
| `read_test_log` | 許可されたログの場所の一覧、ログファイルの一覧（新しい順）、行範囲・末尾の読み取り、ERROR / FAIL / WARNING の検索 | 上の 2 つに加えて `sourceScope.logDirectories` |

ハブでは、すべてのツールに `project`（`list_projects` が返した名前）が必須です。応答は 2.5.0 の新ツールと同じ共通形式（下の「応答の共通形式」）で、`meta.warnings` に省略・スキップの理由を示します。

### 導入するだけで使えるようになる（再承認は不要）

2.6.0 は、新しい権限のキーを作りません。**すでに `detailExposure.sourceText` と `gitExposure.paths`（`get_git_diff` は `diffExcerpts` も）を許可しているプロジェクトでは、2.6.0 を導入して ChatGPT で「ツールを更新」した時点で、承認し直さなくても、ソース全体の検索・読み取りが使えます。** 既存の承認は無効になりません。止めたいプロジェクトは `sourceText` を `false` にして承認し直してください。許可していないプロジェクトでは、新ツールも `permission_denied` になります（`meta.hidden` に足りない項目名が出ます）。

標準の範囲を広げる設定と、ログを読む場所の設定だけが新しく、これらは**足すと承認の指紋が変わり、承認し直すまで応答しません**:

```json
"sourceScope": {
  "additionalDirectories": ["game/addons/my_addon/third_party/clipper"],
  "logDirectories": [{ "path": "Saved/Logs/tests", "recursive": true }]
}
```

- `additionalDirectories`: 標準では降りない生成物・依存・第三者のコードのディレクトリ（`node_modules`・`build`・`bin`・`.venv`・`vendor`・`third_party`・`godot-cpp`・`Saved` など）を、明示的に開けます。ツールの `scope: "extended"` で対象になります。
- `logDirectories`: `read_test_log` が読む場所です（ログ専用の明示許可）。
- **`denyDirectories` が常に優先です。** たとえば、`denyDirectories` に `Saved` を持つゲームのプロジェクトでは、そのままでは `Saved/Logs/tests` を読めません。`read_test_log` で読むには、`Saved` を、読ませたくない場所だけを指す指定（`Saved/CodexAgents`・`Saved/P1Evidence` など）に直し、`logDirectories` を足して、承認し直します。
- 承認の手順は [setup.md](references/setup.md) の「ソース読み取りツールの公開設定」と、下の「導入・再起動・設定変更」にあります。

### 使い方と返却例

以下は、見本のプロジェクト（GDScript の `VoiceConversation` クラスを持つゲーム。`main` ブランチ、未コミットの変更あり）に対して、すべての権限を許可して実際に呼んだ応答から、配列を短くして載せたものです（`meta` と `inferences`・`evidence` は共通形式のため省略します）。

#### `list_source_files`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `path` | 文字列 | プロジェクト全体 | プロジェクト相対のディレクトリかファイル（絶対パス・`..` は使えない） |
| `recursive` | 真偽値 | true | false なら直下のファイルだけ |
| `glob` | 文字列の配列（8 本まで） | なし | `*` `?` `**` `[abc]` `{a,b}`。`/` を含まない glob はどの階層のファイル名にも当てる |
| `extensions` | 文字列の配列 | なし | 例: `[".gd", ".cpp"]` |
| `scope` | `standard` / `extended` | `standard` | `extended` は `sourceScope.additionalDirectories` も対象にする |
| `includeOtherText` | 真偽値 | false | true なら拡張子の表にない拡張子も、本文がテキストであることを検査したうえで含める |
| `limit` | 整数 1〜500 | 100 | 1 回に返す件数 |
| `cursor` | 文字列 | なし | 前回の `page.nextCursor` |

標準の種類は、拡張子の表（GDScript・Godot のシーン・リソース・シェーダー・C/C++・C#・Python・JS/TS・PowerShell・Lua・Shell・JSON・YAML・TOML・XML・CSV・HTML/CSS・Markdown・ビルド定義・ログなど）と、`Makefile`・`CMakeLists.txt`・`SConstruct` などの名前です。`.gitignore` は見ません（無視されているソースも一覧に出ます。生成物・秘密ファイル・`denyDirectories` の除外が優先です）。サブモジュールの中も一覧に出て、`submodule` に名前が付きます。

```json
{
  "tool": "list_source_files", "project": "sample-game",
  "facts": {
    "scope": "standard", "startPath": ".",
    "files": [
      { "path": "game/scripts/voice_conversation.gd", "size": 220, "modified": "2026-10-25T02:40:06.968Z", "language": "GDScript" },
      { "path": "game/addons/inner_kit/lib/helper.gd", "size": 38, "modified": "2026-10-25T02:41:10.120Z", "language": "GDScript", "submodule": "game/addons/inner_kit" }
    ],
    "skipped": { "notStandardType": 1, "filtered": 0, "binary": 0 },
    "truncatedBy": null,
    "walk": { "links": 0, "hardlinks": 0, "hidden": 5, "unreadable": 0 },
    "excluded": { "directories": 4, "names": ["Saved", "godot-cpp", "node_modules", "third_party"] }
  },
  "page": { "limit": 100, "returned": 7, "nextCursor": null }
}
```

`walk` は数えただけで中身を出さないもの（リンク・hardlink・拒否領域や機微な名前・読めないディレクトリ）、`excluded.names` は標準で降りなかったディレクトリの名前です。`page.nextCursor` が文字列なら、続きを `cursor` に渡して取得します（走査の再開位置なので、ファイルが増減しても続きがずれません）。

#### `search_code`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `query` | 文字列 | （必須） | 検索する文字列。`mode: regex` なら JavaScript の正規表現（最大 512 文字） |
| `mode` | `literal` / `regex` | `literal` | |
| `caseSensitive` | 真偽値 | false | |
| `wholeWord` | 真偽値 | false | 識別子の途中の一致を除く |
| `path`・`glob`・`extensions`・`scope`・`includeOtherText` | | | `list_source_files` と同じ |
| `contextBefore`・`contextAfter` | 整数 0〜10 | 0 | 前後の行数 |
| `maxResults` | 整数 1〜200 | 50 | 返す最大件数 |
| `maxMatchesPerFile` | 整数 1〜200 | 20 | 1 ファイルあたりの最大件数 |
| `timeBudgetMs` | 整数 1000〜30000 | 10000 | 走査に使う時間の上限 |
| `cursor` | 文字列 | なし | 前回の `page.nextCursor`（引数は前回と同じにする） |

1 行につき最初の一致だけを返します。件数・時間・応答サイズの上限に達したときは、`facts.truncatedBy`（`limit` / `time` / `bytes` / `entries` / `size` / `regexTimeout`）と `meta.warnings` に理由を示し、続きの `page.nextCursor` を返します（応答サイズで省いた結果も続きに含まれます）。正規表現の評価が時間内に終わらないとき（破滅的なバックトラックなど）は `regexTimeout` で、続きの `cursor` は付きません。

```json
{
  "tool": "search_code",
  "facts": {
    "query": "voiceconversation", "mode": "literal", "caseSensitive": false, "wholeWord": false, "scope": "standard",
    "matches": [
      { "path": "game/scripts/voice_conversation.gd", "line": 4, "column": 3, "text": "# VoiceConversation の本文 日本語 変更",
        "before": ["3: "], "after": ["5: func start_conversation(name: String) -> void:"] }
    ],
    "summary": { "filesScanned": 7, "filesWithMatches": 2, "filesCappedPerFile": 0, "bytesScanned": 68206 },
    "skipped": { "notStandardType": 1, "filtered": 0, "binary": 0, "undecodable": 0, "secretFile": 0, "tooLarge": 0, "unreadable": 0 },
    "truncatedBy": null
  },
  "page": { "returned": 4, "nextCursor": null }
}
```

検索は、次のファイルを数えてスキップします（`skipped`）: 標準の種類でない拡張子、バイナリ、UTF-8（BOM 付き UTF-16 を含む）として復号できないファイル、秘密ファイルと判定したもの（`secretFile`）、8 MiB を超えるファイル、読めないもの。マスクした後の行を照合するので、トークン・パスワードの値を検索で探ることはできません。

#### `read_source`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `path` | 文字列 | （必須） | プロジェクト相対のファイル |
| `startLine` | 整数 ≥ 1 | 1 | 読み始める行（1 始まり） |
| `lineCount` | 整数 1〜2000 | 200 | 返す行数 |
| `maxChars` | 整数 1000〜200000 | 60000 | 1 回に返す本文の最大文字数（応答の大きさの上限は別に 160000 バイト） |
| `encoding` | 文字列 | `auto` | `auto`（BOM か厳密な UTF-8）・`utf-8`・`utf-16le`・`utf-16be`・`shift_jis`・`euc-jp`・`windows-1252` |
| `cursor` | 文字列 | なし | 前回の `page.nextCursor`（ファイルが変わっていなければ、先頭から数え直さず続きの位置へ直接進む） |

```json
{
  "tool": "read_source",
  "facts": {
    "path": "docs/big.md", "size": 67893, "modified": "2026-10-25T02:40:06.668Z",
    "encoding": { "name": "utf-8", "bom": false, "detected": "utf8-strict" }, "lineEnding": "lf",
    "startLine": 1500, "endLine": 1502, "returnedLines": 3, "totalLines": 3000, "hasMore": true,
    "text": "1500\tline 1500: lorem ipsum\n1501\tline 1501: lorem ipsum\n1502\tline 1502: lorem ipsum"
  },
  "page": { "returned": 3, "nextStartLine": 1503, "nextCursor": "eyJrIjoicmVhZCIs…" }
}
```

- 本文は「行番号 + タブ + 行」の形で、行末の改行は含みません。`lineEnding` は `lf` / `crlf` / `mixed` / `none`、`totalLines` は数えられたときだけ（大きなファイルで数えていないときは `null`）です。1 行が 2000 文字を超えるときは切り、警告します。
- **文字コード**: BOM 付き UTF-8・UTF-16（LE/BE）は BOM に従い、BOM がなければ厳密な UTF-8 として読みます。復号できないファイル（Shift_JIS など）は、文字化けを黙って返さず `unsupported_encoding` を返します（行番号つき）。`encoding` を明示したときだけ、その指定で読み、警告に出します。BOM と食い違う指定は `invalid_argument` です。
- **大きなファイル**: 範囲だけを読みます。行番号で途中から読むには先頭から数えるため、32 MiB を超えるファイルでは `startLine: 1` か前回の `cursor` が必要です（`file_too_large`）。
- バイナリは `binary_file`、秘密ファイルは `permission_denied`（`meta.hidden` に `secretFile`）で、本文を返しません。範囲外の行は `range_out_of_bounds` です。

#### `find_references`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `symbol` | 文字列 | （必須） | 探す名前（空白・制御文字なし。最大 128 文字） |
| `kind` | `any` / `definition` / `usage` | `any` | |
| `path`・`glob`・`extensions`・`scope` | | | `list_source_files` と同じ |
| `contextLines` | 整数 0〜5 | 1 | 前後の行数 |
| `limit` | 整数 1〜200 | 60 | 返す最大件数 |
| `timeBudgetMs`・`cursor` | | | `search_code` と同じ |

```json
{
  "tool": "find_references",
  "facts": {
    "symbol": "VoiceConversation", "kind": "any", "scope": "standard", "analysis": { "provider": "text", "exact": false },
    "definitions": [ { "path": "game/scripts/voice_conversation.gd", "line": 1, "column": 12, "text": "class_name VoiceConversation",
                       "language": "GDScript", "classification": "code", "before": [], "after": ["2: extends Node"] } ],
    "usages": [ { "path": "game/tests/test_voice.gd", "line": 2, "column": 10, "text": "\tvar x = VoiceConversation.new()",
                  "language": "GDScript", "classification": "code", "before": ["1: func test_voice():"], "after": [] } ]
  }
}
```

**これは文字列一致ベースで、言語仕様上の厳密な参照解析ではありません**（`meta.warnings` に必ず明記します）。単語単位・大文字小文字を区別して探し、コメント・文字列・同名の別のシンボル・別のスコープの同名の変数も含みます。`classification`（`code` / `comment` / `string` / `unknown`）は、同じ行の中だけを見た目安です。定義の候補は、言語ごとの宣言の形（GDScript の `func`・`class_name`・`signal`・`var`・`const`、C/C++・C# の `class` や関数の宣言、Python の `def`・`class`、JS/TS の `function`・`class`・`const`、PowerShell・Lua・Shell の関数）に当てはまる行です。`kind: any` の最初のページでは、使用箇所で上限に達する前に定義を見つけられるよう、定義だけを探す走査を先に行います。将来、LSP や言語別の解析器を足せるよう、結果に `provider: "text"` を付けています。

#### `get_git_diff`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `mode` | `head` / `staged` / `unstaged` / `range` | `head` | `head` は HEAD と作業ツリーの差（staged と unstaged の合算）。`range` は `base` と `target` の間 |
| `base`・`target` | 文字列 | `target` は HEAD | ブランチ名（`branchNames` が必要）または 7〜64 桁のコミットの SHA。任意のリビジョン式（`HEAD~1` など）は受け付けない |
| `since` | 文字列 | なし | ISO 8601 の日付・日時（例: `2026-10-24`）。「HEAD の履歴で、この日時以前の最後のコミット」を比較元にする。日付だけならこのマシンのローカル時刻の 0 時。`base` とは同時に指定できない |
| `paths` | 文字列の配列（20 件まで） | なし | 差分を見るファイル・ディレクトリ（glob は使えない）。サブモジュール指定時はそのルートからの相対（プロジェクト相対も可） |
| `submodule` | 文字列 | なし | `.gitmodules` に登録されたサブモジュールのパス。その中の差分を返す（応答のパスはプロジェクト相対） |
| `contextLines` | 整数 0〜20 | 3 | |
| `filesPerPage` | 整数 1〜50 | 10 | 1 ページのファイル数 |
| `maxLinesPerFile` | 整数 10〜2000 | 400 | 1 ファイルの差分の最大行数 |
| `lineOffset` | 整数 ≥ 0 | 0 | 1 ファイルだけのとき、差分の何行目から返すか |
| `cursor` | 文字列 | なし | 前回の `page.nextCursor` |

```json
{
  "tool": "get_git_diff",
  "facts": {
    "mode": "head", "base": null, "target": null, "since": null, "paths": null,
    "totals": { "filesChanged": 1, "insertions": 2, "deletions": 2, "binaryFiles": 0, "omittedHiddenPaths": 0 },
    "files": [ {
      "path": "game/scripts/voice_conversation.gd", "oldPath": null, "status": "M", "additions": 2, "deletions": 2, "binary": false, "submodule": false,
      "hunks": [ { "oldStart": 1, "oldLines": 10, "newStart": 1, "newLines": 10 } ],
      "totalPatchLines": 13,
      "patch": "@@ -1,10 +1,10 @@\n class_name VoiceConversation\n extends Node\n \n-# VoiceConversation の本文 日本語\n+# VoiceConversation の本文 日本語 変更\n …",
      "truncated": false, "nextLineOffset": null } ],
    "untracked": { "count": 1, "files": ["untracked_new.gd"], "truncated": false, "note": "未追跡ファイルは差分を持たないため、名前だけです。本文は read_source で読めます。" },
    "diffId": "a216bae435c9b499"
  },
  "page": { "offset": 0, "limit": 10, "returned": 1, "total": 1, "nextOffset": null, "nextCursor": null }
}
```

- まず `git diff --raw --numstat -z` で変更の一覧とページを決め、そのページのファイルだけ、まとめて 1 回の `git diff -p` で本文を取ります（Git の出力の上限 4 MiB を避けるため）。大きな 1 ファイルは、行数・100 KB で切り、`truncated: true` と `nextLineOffset` を返すので、`paths` にそのファイルだけを指定して `lineOffset` で続きを取得します。
- バイナリ・サブモジュールのコミットの変化・競合中のファイル・秘密ファイルと判定した差分は、本文を返さず、`withheld`（`binary` / `submodule` / `conflicted` / `secret` / `unavailable`）で示します。`.env`・鍵ファイル・`denyDirectories` 配下・橋渡し自身の設定ファイルの変更は、一覧にも出さず `totals.omittedHiddenPaths` の件数だけです。差分の行も、秘密値・メールアドレス・ユーザー名を伏せます。
- 未追跡のファイルは名前だけ返します（本文は `read_source`）。差分が途中で変わったときの `cursor` は `stale_cursor` です（`diffId` が変わるため。最初から取得し直す）。
- **「昨日の変更」の確認**: `mode: range` と `since`（昨日の日付）で、昨日以前の最後のコミットから HEAD までのコミット済みの変更を、`mode: head` で未コミットの変更を、それぞれ取得して比べます。
- サブモジュールの中は、`submodule` に `.gitmodules` のパスを指定します。サブモジュール自身の `.git/config` を、親とは別に安全検査してから Git を実行します（Git 自身が書く `core.worktree` は、そのサブモジュール自身の作業ツリーを指す相対パスのときだけ許します）。
- 実行する Git のサブコマンドは `diff`・`rev-parse`・`rev-list`・`status` だけです（`fetch`・`checkout`・`reset`・`merge`・`commit`・`push` などは実行しません）。コミットの SHA は `rev-parse --verify` で実在を確かめ、ブランチ名は列挙した実在の参照と完全一致したものだけ受け付け、パスは `--` の後ろに `--literal-pathspecs` で渡すので、ユーザーの入力が Git のオプションとして解釈されることはありません。

#### `read_test_log`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `action` | `directories` / `files` / `read` / `search` | `directories` | 許可された場所の一覧 / ログファイルの一覧（更新が新しい順）/ 範囲・末尾の読み取り / 検索 |
| `directory` | 文字列 | 設定が 1 か所ならその場所 | `files`・`search` の対象の場所（`directories` が返したパス、またはその配下） |
| `file` | 文字列 | なし | `read` の対象。`search` で 1 ファイルだけを対象にするとき |
| `glob`・`limit` | | | `files` の絞り込みと件数（1〜200、既定 50） |
| `startLine`・`lineCount` | 整数 | 1・200 | `read` の行範囲（`lineCount` は 2000 まで） |
| `fromEnd` | 真偽値 | false | `read` で true にすると、末尾から `lineCount` 行 |
| `severity` | `error` / `fail` / `warning` の配列 | `error` と `fail` | `search` で、重大度の語を含む行を探す（`pattern` とは同時に指定できない） |
| `pattern` | 文字列 | なし | `search` で、この文字列（大文字小文字を区別しない固定文字列）を含む行を探す |
| `latest` | 整数 1〜20 | 1 | `search` で directory を指定したとき、更新が新しい何ファイルを対象にするか |
| `contextBefore`・`contextAfter`・`maxResults`・`timeBudgetMs`・`cursor` | | | `search_code` と同じ（前後の行は既定 1） |

```json
{
  "tool": "read_test_log",
  "facts": {
    "action": "search", "directory": "Saved/Logs/tests", "latest": 1, "matchedFiles": 1, "severity": ["error", "fail"],
    "matches": [
      { "path": "Saved/Logs/tests/b/new.log", "line": 3001, "column": 1, "text": "[ERROR] new failure with token=[REDACTED]",
        "severity": ["error", "fail"], "before": ["3000: [INFO] step 3000"], "after": ["3002: [WARNING] slow"] }
    ],
    "severityCounts": { "error": 1, "fail": 1, "warning": 0 }
  }
}
```

- 許可された場所は、`sourceScope.logDirectories` に書いた場所だけです。ログは、拡張子が `.log`・`.txt`・`.json`・`.jsonl`・`.xml`・`.csv`・`.md`・`.tap`・`.trx`・`.out`・`.err` などで、本文がテキストのファイルだけ読みます。ログの上限は 1 ファイル 64 MiB です。
- 一覧は更新が新しい順です（「最新のテストログ」は `files` の先頭、または `search` の `latest`）。`read` の `fromEnd` で末尾を読めます。ログにも秘密値・メールアドレス・ユーザー名のマスクを掛けます。ログが書き込み中なら、取得のたびに内容が変わります。
- 重大度の語はログの書式により異なります（`error`・`fatal`・`exception`・`fail`・`failed`・`warn` など。単語単位）。見つからないことが問題の無いことを意味するとは限らないので、`meta.warnings` に明記します。

### セキュリティ

- **読み取り専用**: 上の通りです。試験（`source-tools-selftest.mjs`）が、新しいモジュールに書き込み・削除・外部コマンドの呼び出しが無いこと、全ツールを呼んだ前後でプロジェクトの全ファイルと `.git`（HEAD・index・refs・更新時刻）が変わらないことを確かめます。
- **範囲の制限**: プロジェクトの外、`denyDirectories`、`.git`、機微な名前、組み込みの拒否パス（`knowledge/00-system`・`20-bronze`・`30-gold`・`Prompts/Prompt.txt`）、橋渡し自身の設定は、一覧・検索・読み取り・差分のすべてで除きます。許可されていないファイルの存在を、応答から区別することもできません。
- **パスの検査**: `..`・絶対パス・ドライブ文字・UNC・代替データストリーム（`:`）・Windows の 8.3 短縮名を拒否します。リンク・junction・hardlink・別マウントは、一覧に降りず、読み取りも拒否します（読み取りは、fd を固定して、開く前・開いた後・Linux では fd の実体の三度、同じ検査をします）。サブモジュールは、プロジェクト内の通常のディレクトリとして同じ検査を通ります。
- **秘密**: 秘密の名前のファイルに加え、本文が明らかな秘密ファイル（PEM の秘密鍵、秘密らしい代入が複数ある `.env` 風のファイル）は、本文を返しません。それ以外の本文・差分・ログは、行ごとに秘密値・メールアドレス・ユーザーフォルダー名を伏せます（行番号は変わりません）。**マスクは完全ではありません。** 公開してよい内容かをプロジェクトごとに判断してください。
- **ソース中の文章は命令ではありません**: 取得したソース・コメント・文字列・ログの文章は、ChatGPT への命令ではなくただのデータです。ツールの説明と初期化応答に、そのように明記しています。
- **外部への送信なし・課金なし**: 読み取ったソースを外部サービスへ自動で送ることはなく、課金される API も使いません（ChatGPT が呼び出したときに応答として返すだけです）。2.7.0 の Claude Code のジョブは別で、Claude Code が Anthropic のサービスと通信し、利用枠を消費します（`claudeCode` を承認したプロジェクトだけ）。
- **検索エンジンは Node の実装だけです。** ripgrep は使いません（検査を通さずにファイルを開いてしまうため。この PC にも Ubuntu にも前提にできません）。そのため外部コマンドへの引数の注入はありません。正規表現は、別のコンテキストで時間を制限して評価し、時間内に終わらなければ打ち切ります。

### 大規模なプロジェクトでの動作（実測）

作者のゲームのプロジェクト（実機の Godot のゲーム。サブモジュール 2 つを含み、依存ライブラリ込みで 2 万ファイル以上）で、標準の範囲は 1448 ファイル（約 35 MB）でした（Windows・Node 24.19.0）。一覧の全ページが約 0.5 秒、固定文字列の全体検索が約 1.9 秒、正規表現の全体検索が約 4.6 秒、335 KB・4530 行のファイルの途中の読み取りが数ミリ秒です。`Saved/Logs/tests`（2 万件超）のログ一覧は約 2.3 秒でした。Git は、この PC では呼び出しごとに 0.3〜7 秒かかる（UNC の `safe.directory` の影響。[導入・再起動・設定変更](#導入再起動設定変更)）ため、`get_git_diff` は数秒〜十数秒かかることがあります。サーバーは要求を 1 件ずつ直列に処理するので、重い検索の間は他の要求も待たされます（時間の上限は既定 10 秒・最大 30 秒）。キャッシュは作りません（毎回走査します）。

### 制限

- `find_references` は文字列一致ベースです。言語仕様上の参照解析（スコープ・オーバーロード・継承）はしません。
- 検索は 1 行につき最初の一致だけを返し、1 行 2 万文字より後ろの一致は見つけません。8 MiB を超えるファイルは検索しません（`read_source` は範囲を指定して読めます）。
- 複数行にまたがるコメント・文字列は、`classification` の判定に使いません。
- UTF-8 と BOM 付き UTF-16 以外は、検索の対象にしません（`read_source` の `encoding` で個別に読めます）。
- 「最新」のログは、更新日時で決めます（ログの書き込み中は変わります）。
- 新ツールの応答は、終了時保存（オフライン）の対象ではありません。

## 2.5.0 で追加した読み取りツール

ChatGPT が承認済みプロジェクトの現状（ブランチ、差分の規模、未コミット変更、最近の活動、構造、実装状況、課題、テスト記録）を、根拠付きで詳しく読めるようにする 10 個のツールです。
**すべて読み取り専用**で、既存の 9 ツール（`list_projects`・`get_project_context`・`get_project_status`・`get_recent_changes`・`get_project_issues`・`list_documents`・`get_document`・`search`・`fetch`）の名前・引数・応答は変えていません。
Windows と Ubuntu は同じ `scripts/server.mjs` を使い、ツールの引数と応答の JSON の形も同一です（OS ごとに違うのは、Git の実行ファイルの探し方とパスの区切りだけです）。

| ツール | 返すもの | 許可が要る情報 |
|---|---|---|
| `get_git_branches` | ローカル・リモート追跡ブランチ、現在のブランチ、HEAD、最終コミット日時、upstream、ahead/behind、マージ済みか | ブランチ名 |
| `get_branch_details` | 1 本のブランチの分岐点、基準との差分統計、直近コミット、変更ファイル、作成日時（分かれば） | ブランチ名、件名、ファイル名 |
| `compare_branches` | 2 本のブランチのコミット増減、変更量、変更された領域、マージ状態、競合の可能性の目安 | ブランチ名、件名、ファイル名 |
| `get_worktree_details` | 未コミット変更の分類（staged・unstaged・untracked・deleted・renamed・conflicted）、worktree、サブモジュール | ファイル名、差分の抜粋 |
| `get_recent_activity` | 日ごとのコミット数、最終活動、変更された領域、未コミット作業の有無 | 件名、ファイル名 |
| `get_project_overview` | 目的、利用者、言語、フレームワーク・エンジン、ビルド方法、エントリーポイント、モジュール、依存、実装済み機能、開発フェーズ | ファイル名、ファイル本文 |
| `get_project_structure` | ディレクトリ構造、言語別のファイル数、主要ファイルと役割の推測 | ファイル名 |
| `get_project_tasks` | 未完了の作業（文書の課題・次の作業・未完了項目、ソースの TODO / FIXME）と、根拠・確認日時・確度 | ソースの TODO は ファイル名 + ファイル本文 |
| `get_project_validation` | ビルド設定、テストの構成、過去のテスト結果の記録、CI 設定、ベンチマーク記録 | 記録の読み取りは ファイル本文 |
| `get_portfolio_summary` | 承認済みの全プロジェクトの概要（目的・技術・最終活動・ブランチ・未コミット件数・実装状況・課題・テスト・次に確認すべき事項） | （各プロジェクトの許可に従う） |

ハブでは、`get_portfolio_summary` 以外のツールに `project`（`list_projects` が返した名前）が必須です。

### 応答の共通形式

新ツールの応答は、どれも次の形の JSON です。**事実（`facts`）と推測（`inferences`）を分け**、取得の時点と欠落を `meta` で示します。

```json
{
  "schemaVersion": 1,
  "tool": "get_git_branches",
  "project": "sample-app",
  "meta": {
    "collectedAt": "2026-10-19T07:37:15.660Z",
    "status": "ok",
    "sources": [{ "kind": "liveGit", "live": true, "collectedAt": "2026-10-19T07:37:15.660Z", "sourceUpdatedAt": null }],
    "sourceUpdatedAt": null,
    "errorClass": null,
    "errorReason": null,
    "retryable": false,
    "hidden": [],
    "warnings": [],
    "truncated": false,
    "limits": { "offset": 0, "limit": 50 }
  },
  "facts": {},
  "inferences": [],
  "evidence": [],
  "page": { "offset": 0, "limit": 50, "returned": 2, "total": 2, "nextOffset": null }
}
```

| 項目 | 意味 |
|---|---|
| `meta.collectedAt` | このサーバーが取得した日時（ISO 8601）。 |
| `meta.status` | `ok` = 欠落なし。`partial` = 権限が無くて隠した項目、または応答サイズ・件数の上限で省いた項目がある。`unavailable` = 取得できなかった（`errorClass` と `errorReason` を見る）。 |
| `meta.sources[]` | 情報源。`kind` は `liveGit`（呼び出し時点の Git）、`staticAnalysis`（呼び出し時点のファイル構成・内容の解析）、`document`（保存された公開文書）、`config`（設定ファイル）、`testLog`（過去のテスト結果などの記録）。`live` が `true` の情報源だけが呼び出し時点の状態で、`false` は保存された内容を読んだものです。`sourceUpdatedAt` は情報源（文書・記録）の更新日時です。 |
| `meta.sourceUpdatedAt` | 情報源のうち最も新しい更新日時。 |
| `meta.hidden[]` | 権限が無くて返さなかった項目（`paths`・`commitSubjects`・`branchNames`・`diffExcerpts`・`sourceText`、2.6.0 で `logDirectories`（ログの読み取り場所の設定なし）・`secretFile`（本文が秘密らしいファイル）、2.7.0 で `claudeCode`（Claude Code のジョブを承認していない））。**隠した項目は「存在しない」ことを意味しません。** |
| `meta.warnings[]` | 欠落を意味しない注意事項（浅い clone、サブモジュールの中は見ていない、など）。 |
| `facts` | 測定・取得した事実だけ（HEAD、SHA、ブランチ名、件数など）。 |
| `inferences[]` | 推測・提案。`claim`・`basis`（根拠の説明）・`confidence`（`low` / `medium` / `high`）・`evidence` を持つ。事実とは混ぜない。 |
| `evidence[]` | 根拠。公開が許可された文書のパスと見出し、コミットの ID、ブランチなど。 |
| `page` | ページング。`nextOffset` が数値なら、続きを `offset` に渡して取得する。`null` なら最後。 |

**最新かどうかの判定**: `meta.collectedAt`（取得時点）と、各 `sources[].live` / `sourceUpdatedAt` を見ます。`liveGit` は呼び出し時点の値です。`document` と `testLog` は保存された内容なので、`sourceUpdatedAt` が古ければ、現在の状態と違う可能性があります。
文書と Git の値が食い違うときは、Git（`liveGit`）を優先してください。

**既存ツールとの違い**: 既存の 9 ツールの応答は 2.4.x と同じ形のままで、`meta` を持ちません。

### 公開権限

既定では、ファイル名・コミット件名・ブランチ名・差分・ファイル本文を返しません。**件数、現在のブランチ名、HEAD のハッシュと日時、言語別のファイル数、公開許可された文書から読める内容**は、許可が無くても返します。

| 設定 | 許可すると返すもの |
|---|---|
| `gitExposure.paths`（既存） | ファイル名・ディレクトリ名（変更ファイル、構造、根拠のパス） |
| `gitExposure.commitSubjects`（既存） | コミット件名 |
| `detailExposure.branchNames`（新） | 現在以外のブランチ名、`get_branch_details`・`compare_branches` の利用 |
| `detailExposure.diffExcerpts`（新） | `get_worktree_details` の差分の抜粋（`gitExposure.paths` も必要） |
| `detailExposure.sourceText`（新） | 文書の許可リストに無いファイルの本文の分析（設定ファイル、ソースの TODO、テスト記録） |

`denyDirectories` 配下、`.env`・鍵ファイルなどの機微な名前、`.git`、シンボリックリンク・junction・hardlink・別マウント・バイナリ・256 KiB を超える部分は、許可しても返しません（2.6.0 のソース読み取りツールは、`sourceText` と `paths` の許可を使い、範囲を指定して 256 KiB を超えるファイルも部分的に読めます。上の「2.6.0 で追加したソース読み取りツール」）。秘密値（トークン、パスワード、秘密鍵など）は、応答の本文・件名・差分の行から伏せます（完全ではありません。公開する内容自体を確認してください）。
設定の書き方と承認の流れは [setup.md](references/setup.md) の「詳細取得ツールの公開設定」にあります。

### エラーと再試行

引数の不備・権限・対象なし・見合わせ中は `isError: true` で、取得中の失敗（時間切れなど）は `isError: false` のまま `meta.status` が `unavailable` で返ります。どちらも `meta.errorClass` に分類が入ります。

| `errorClass` | 意味 | 再試行 |
|---|---|---|
| `invalid_argument` | 引数の型・範囲・形式が不正（整数でない、必須の引数が無い、ブランチ名の形が不正など） | しない。引数を直す |
| `permission_denied` | 公開権限が無い、または安全上の理由で読めない | しない。利用者が設定を変えて承認し直す |
| `not_found` / `ref_not_found` | 対象（ファイル、ブランチ）が存在しない | しない |
| `not_a_git_repository` | プロジェクトが Git リポジトリのルートではない | しない |
| `git_unavailable` | Git を実行できない | しない。Git の導入を確認する |
| `unsafe_git_config` | `.git/config` に実行を伴いうる設定がある（理由のキー名を `errorReason` に示す） | しない。利用者が設定を直す |
| `git_ownership_rejected` | Git が、リポジトリの所有者が現在の利用者と違うことを理由に拒否した | しない。Git の `safe.directory` を利用者が判断する（このサーバーは設定を変えません） |
| `timeout` | 制限時間（Git 1 回 15 秒）内に終わらなかった。原因は特定できない | 同じ呼び出しは続けて 3 回まで。範囲を絞る |
| `output_too_large` | Git の出力が上限（4 MiB）を超えた | 期間・件数・ブランチを絞る |
| `too_many_failures` | 同じプロジェクト・ツールの運用上の失敗（`timeout`・`output_too_large`・`git_error`・`internal_error`）が 3 回続いたため、約 30 秒は見合わせている | しばらく待つ。`errorReason` に残り秒数 |
| `git_error` / `internal_error` | 上のどれにも当てはまらない失敗。原因は特定できない | しない。サーバー側のログ（標準エラー出力）を見る |
| `binary_file`（2.6.0） | バイナリのファイルで、本文を返さない | しない |
| `unsupported_encoding`（2.6.0） | 文字コードを判定・復号できない（BOM なしで UTF-8 でない）。メッセージに行番号を示す | `read_source` の `encoding` を明示する |
| `range_out_of_bounds`（2.6.0） | `startLine` がファイルの行数を超えている | `startLine` を直す |
| `invalid_pattern`（2.6.0） | 検索の正規表現が不正 | パターンを直す |
| `file_too_large`（2.6.0） | 行番号で途中から読むには先頭から数える必要があり、上限（32 MiB・ログは 64 MiB）を超える | `startLine: 1` か前回の `cursor` を使う |
| `stale_cursor`（2.6.0） | 前回の取得から、差分が変わった・対象のファイルが無くなったため、`cursor` で続きを取得できない | 最初から取得し直す |
| `job_not_found`（2.7.0） | 指定した jobId のジョブが無い（保持の上限で消えたものを含む） | `list_claude_jobs` で確かめる |
| `job_limit`（2.7.0） | 同時に動かせるジョブの上限（1 プロジェクト 1 件・PC 全体 2 件）に達している | 終わるのを待つか、`cancel_claude_job` で止める |
| `claude_unavailable`（2.7.0） | Claude Code の実行ファイルが見つからない、またはプロジェクトの場所（ネットワークのパスなど）で権限を設定できない | PC に Claude Code（ネイティブ版）を導入する |
| `job_not_running`（2.7.0） | 続きを依頼した前のジョブが終わっていない・会話を始める前に終わっている | 前のジョブが終わってから依頼する、新しい会話で依頼する |

**HTTP 429・ChatGPT 側の時間切れ・認証失敗**は、このサーバーには届かない段階で起きることがあり、サーバーからは原因を判断できません。サーバーが応答しているかは、`access.log`（ツール別の成否）とトンネルのログに要求が届いているかで確かめてください（[setup.md](references/setup.md)）。

### ツールの使い方

以下の返却例は、見本のプロジェクト（`sample-app`: 予約管理 API。`main` と `feature/login`、未コミットの変更あり）で、すべての権限を許可して実際に呼んだ応答から、配列を短く・長い文字列を切って載せたものです（`meta` は共通形式のため `status`・`hidden`・`warnings` だけを示します）。

#### `get_git_branches`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `offset` | 整数 ≥ 0 | 0 | 何件目から返すか |
| `limit` | 整数 1〜200 | 50 | 1 回に返すブランチ数 |
| `includeRemote` | 真偽値 | true | リモート追跡ブランチも含める |
| `baseBranch` | 文字列 | 自動 | merged / ahead / behind の基準にするブランチ |

- 比較の基準（`facts.base`）は、**実在を確認した参照だけ**から選びます: 明示指定 → リモートの既定ブランチ（`refs/remotes/<リモート>/HEAD` の指す先。`origin` を優先）→ ローカルの `main` / `master` / `trunk` / `develop` → なし。`origin/main` が無くても動き、基準が無ければ merged / ahead / behind は `null` です。
- 現在のブランチを先頭に、最終コミット日時の新しい順に並べ、`branches` をページングします。`counts.mergedIntoBase` / `unmergedIntoBase` は基準ブランチ自身を除いた数です。
- `headState` は `branch`・`detached`・`unborn`（初回コミット前）のいずれかです。浅い clone では `warnings` に「履歴が途中まで」と出ます。

```json
{
  "tool": "get_git_branches",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "repository": {
      "isShallow": false,
      "hasCommits": true,
      "headState": "branch",
      "headSha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
      "headShortSha": "e69b8dd",
      "headCommittedAt": "2026-10-13T00:00:00Z",
      "currentBranch": "main"
    },
    "base": {
      "ref": "main",
      "kind": "local",
      "sha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
      "selection": "conventionalName"
    },
    "counts": {"local":2,"remote":0,"mergedIntoBase":0,"unmergedIntoBase":1},
    "branches": [
      {
        "name": "main",
        "kind": "local",
        "isCurrent": true,
        "sha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
        "shortSha": "e69b8dd",
        "lastCommitAt": "2026-10-13T00:00:00Z",
        "upstream": null,
        "upstreamState": "none",
        "aheadOfUpstream": null,
        "behindUpstream": null,
        "mergedIntoBase": true,
        "aheadOfBase": 0,
        "behindBase": 0,
        "aheadBehindCapped": false
      },
      "…（ほか 1 件）"
    ]
  },
  "page": {"offset":0,"limit":50,"returned":2,"total":2,"nextOffset":null}
}
```

ブランチ名の公開を許可していない場合は、ブランチの一覧（`branches`）を返さず、`hidden` に `branchNames` を示します（件数と現在のブランチは返します）。

```json
{
  "tool": "get_git_branches",
  "project": "sample-app",
  "meta": {"status":"partial","hidden":["branchNames"],"warnings":[]},
  "facts": {
    "repository": {
      "isShallow": false,
      "hasCommits": true,
      "headState": "branch",
      "headSha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
      "headShortSha": "e69b8dd",
      "headCommittedAt": "2026-10-13T00:00:00Z",
      "currentBranch": "main"
    },
    "counts": {"local":2,"remote":0,"mergedIntoBase":0,"unmergedIntoBase":1}
  }
}
```

#### `get_branch_details`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `branch` | 文字列（必須） | | `get_git_branches` が返した実在のブランチ名。`refs/heads/…` の完全名も可。`HEAD~1` や SHA は不可 |
| `baseBranch` | 文字列 | 自動 | 基準にするブランチ |
| `commitLimit` | 整数 1〜100 | 20 | 直近コミットの件数 |
| `fileOffset` / `fileLimit` | 整数 | 0 / 100（最大 500） | 変更ファイルのページング |

- 作成理由は履歴から断定しません。コミット件名から言えることは `inferences`（`confidence: low`、「目的は未確認」）に分けます。
- `createdAt` は reflog に「branch: Created from」が残っているときだけ日時を返し、無ければ文字列 `"unknown"` です（clone で作られたブランチやリモート追跡ブランチ、reflog の期限切れは `unknown`）。

```json
{
  "tool": "get_branch_details",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "base": {
      "ref": "main",
      "kind": "local",
      "sha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
      "shortSha": "e69b8dd",
      "selection": "conventionalName"
    },
    "mergeBase": {"sha":"e69b8dd77dffcacafe8249aaf75b8415b5917453","committedAt":"2026-10-13T00:00:00Z"},
    "ahead": 2,
    "behind": 0,
    "diffStat": {"range":"mergeBase..branch","filesChanged":2,"insertions":2,"deletions":0,"binaryFiles":0},
    "recentCommits": [
      {
        "sha": "f9f220cc4bdc4d1106a858e3bdc24c931274d9b8",
        "shortSha": "f9f220c",
        "committedAt": "2026-10-14T06:00:00Z",
        "subject": "Wire login into app"
      },
      "…（ほか 1 件）"
    ],
    "changedFiles": [
      {
        "path": "src/index.js",
        "status": "M",
        "renamedFrom": null,
        "insertions": 1,
        "deletions": 0,
        "binary": false,
        "submodule": false
      },
      "…（ほか 1 件）"
    ],
    "createdAt": {"at":"2026-10-13T06:00:00Z","source":"reflog"}
  },
  "inferences": [
    {
      "claim": "このブランチの直近のコミット件名（2 件。例: 「Wire login into app」「Add login endp…",
      "basis": "コミット件名だけから読み取ったもので、作成理由や目的を記録した情報ではありません。",
      "confidence": "low",
      "evidence": [{"type":"commit","sha":"f9f220cc4bdc4d1106a858e3bdc24c931274d9b8"},"…（ほか 1 件）"]
    }
  ],
  "page": {"offset":0,"limit":100,"returned":2,"total":2,"nextOffset":null}
}
```

#### `compare_branches`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `base` | 文字列（必須） | | 基準側のブランチ |
| `target` | 文字列（必須） | | 比較する側のブランチ |
| `commitLimit` / `fileOffset` / `fileLimit` | 整数 | 20 / 0 / 100 | `get_branch_details` と同じ |

- `mergeState` は `identical`・`targetMergedIntoBase`・`fastForwardPossible`・`diverged` のいずれかです（`merge-base --is-ancestor` で判定）。
- **マージは試しません。** `conflictIndicators` は、分岐点から両側で変更されたファイルの重なりを数えた**目安**（`heuristic: true`）で、重なっていても競合しないこと、重なっていなくても競合することがあります。
- `areas` は変更ファイルを先頭ディレクトリごとにまとめた追加・変更・削除の件数です。「機能」の名前は創作せず、パスとコミット件名から機械的に言えることだけを返します。

```json
{
  "tool": "compare_branches",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "mergeState": "fastForwardPossible",
    "ahead": 2,
    "behind": 0,
    "diffStat": {"range":"mergeBase..target","filesChanged":2,"insertions":2,"deletions":0,"binaryFiles":0},
    "areaTotals": {"added":1,"modified":1,"deleted":0,"renamed":0,"other":0},
    "conflictIndicators": {
      "heuristic": true,
      "note": "分岐点から両側で変更されたファイルの重なりを数えた目安です。実際にマージを試したものではなく、重なっていても競合しないこ…",
      "overlappingFileCount": 0,
      "overlappingFiles": [],
      "overlappingFilesTruncated": false
    },
    "areas": [{"area":"src","files":2,"added":1,"modified":1,"deleted":0,"renamed":0,"other":0}],
    "commits": [
      {
        "sha": "f9f220cc4bdc4d1106a858e3bdc24c931274d9b8",
        "shortSha": "f9f220c",
        "committedAt": "2026-10-14T06:00:00Z",
        "subject": "Wire login into app"
      },
      "…（ほか 1 件）"
    ]
  },
  "inferences": [
    {
      "claim": "target 側の直近のコミット件名（2 件。例: 「Wire login into app」「Add login en…",
      "basis": "コミット件名だけから読み取ったもので、作成理由や目的を記録した情報ではありません。",
      "confidence": "low",
      "evidence": [{"type":"commit","sha":"f9f220cc4bdc4d1106a858e3bdc24c931274d9b8"},"…（ほか 1 件）"]
    }
  ],
  "page": {"offset":0,"limit":100,"returned":2,"total":2,"nextOffset":null}
}
```

#### `get_worktree_details`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `offset` / `limit` | 整数 | 0 / 100（最大 500） | `files` のページング |
| `category` | 文字列 | `all` | `staged`・`unstaged`・`untracked`・`conflicted`・`deleted`・`renamed` で絞る |
| `includeUntracked` | 真偽値 | true | 未追跡のファイルを含める |

- 件数（`counts`）と差分の規模（`diffStat`）は、ファイル名を公開しなくても返します。1 つのファイルが staged と unstaged の両方に当たることがあり、`total` は重複を除いたファイル数です。
- `worktrees` は linked worktree も含みます。**プロジェクトの外にある worktree の中では Git を実行しません**。`submodules` は記録されたコミットと状態だけで、**サブモジュールの中でも Git を実行しません**。
- `patches`（差分の抜粋）は、`diffExcerpts` と `paths` の両方を許可したときだけ返します。1 ファイル 40 行・1 行 200 文字・最大 20 ファイル・合計 64 KiB まで、バイナリと秘密値は出しません。
- `operationInProgress` は、merge・rebase・cherry-pick などの途中なら、その種類を示します。

```json
{
  "tool": "get_worktree_details",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "counts": {"staged":1,"unstaged":2,"untracked":1,"deleted":1,"renamed":1,"conflicted":0,"total":4},
    "diffStat": {
      "staged": {"filesChanged":1,"insertions":0,"deletions":0,"binaryFiles":0},
      "unstaged": {"filesChanged":2,"insertions":1,"deletions":2,"binaryFiles":0}
    },
    "files": [
      {
        "path": "src/helpers.js",
        "kind": "staged",
        "indexStatus": "R",
        "worktreeStatus": ".",
        "renamedFrom": "src/util.js",
        "insertions": 0,
        "deletions": 0,
        "submodule": false
      },
      "…（ほか 3 件）"
    ],
    "worktrees": [
      {
        "isMain": true,
        "isCurrent": true,
        "isInsideProject": true,
        "path": ".",
        "branch": "main",
        "headSha": "e69b8dd77dffcacafe8249aaf75b8415b5917453",
        "detached": false,
        "bare": false,
        "locked": false,
        "prunable": false
      }
    ],
    "patches": [
      {
        "path": "src/reservations.js",
        "stage": "unstaged",
        "status": "M",
        "renamedFrom": null,
        "lines": ["@@ -1 +1 @@","…（ほか 2 件）"],
        "truncated": false
      },
      "…（ほか 1 件）"
    ]
  },
  "page": {"offset":0,"limit":100,"returned":4,"total":4,"nextOffset":null}
}
```

#### `get_recent_activity`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `days` | 整数 1〜365 | 14 | 遡る日数 |
| `limit` | 整数 1〜200 | 50 | 返す直近コミットの数 |

- `daily` は期間内の全日（コミットが無い日は 0）です。日付はこのサーバーのローカル日付です。作者名・メールアドレスは返しません。
- `uncommitted.newestChangedFileModifiedAt` は変更ファイルの更新日時の最大で、**参考値**です（コピーや checkout でも変わります）。実際の作業日を示すとは限りません。コミットが無い日も未コミットの作業がある可能性があるため、`inferences` に注意を添えます。

```json
{
  "tool": "get_recent_activity",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":["newestChangedFileModifiedAt はファイルの更新日時から求めた参考値です。コピー・チェックアウト…"]},
  "facts": {
    "windowDays": 14,
    "lastCommitAt": "2026-10-14T06:00:00Z",
    "commitsInWindow": 4,
    "daily": [{"date":"2026-10-05","commits":0},{"date":"2026-10-06","commits":0},"…（ほか 13 件）"],
    "recentCommits": [
      {
        "sha": "f9f220cc4bdc4d1106a858e3bdc24c931274d9b8",
        "shortSha": "f9f220c",
        "committedAt": "2026-10-14T06:00:00Z",
        "subject": "Wire login into app"
      },
      {
        "sha": "857fc4dfbf44724ba77d53407da4ffdeaea2ba45",
        "shortSha": "857fc4d",
        "committedAt": "2026-10-13T18:00:00Z",
        "subject": "Add login endpoint"
      },
      "…（ほか 2 件）"
    ],
    "changedAreas": [{"area":"src","files":4},{"area":".","files":3},"…（ほか 3 件）"],
    "uncommitted": {"count":4,"newestChangedFileModifiedAt":"2026-10-19T07:37:15.457Z"}
  }
}
```

#### `get_project_overview`

引数はありません。各項目は `{ value, status, evidence, … }` の形で、`status` は次のとおりです。

| `status` | 意味 |
|---|---|
| `known` | 公開許可された文書・設定・測定値に書かれていること（`evidence` に文書のパスと見出し、ファイルなど） |
| `inferred` | ファイル名やディレクトリ名の規約、README の冒頭などからの推測（`basis` と `confidence` を付ける） |
| `unknown` | 根拠が無い。`value` は `null` で、推測で補わない |

- **空欄テンプレート**（「…を記載してください」だけの節）は「未記入」として扱い、`known` にしません（`facts.documents.<役割>.templateUnfilled` が `true`）。実装済み・完了とは判断しません。
- ビルド設定やマニフェストの本文を読む項目（依存、スクリプト、エントリーポイントなど）は `detailExposure.sourceText` が要ります。許可が無いときは、ファイルの存在だけで言えること（`package.json` がある、など）に限り、`hidden` に `sourceText` を示します。

```json
{
  "tool": "get_project_overview",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "purpose": {
      "value": "社内向けの小さな予約管理 Web API を提供する。",
      "status": "known",
      "evidence": [{"type":"document","path":"CHATGPT_PROJECT_CONTEXT.md","heading":"目的","line":3}],
      "sourceKind": "document",
      "sourceUpdatedAt": "2026-10-19T07:37:14.488Z"
    },
    "phase": {
      "value": "- 予約の作成・取消 API は実装済み。\n- ログイン機能は feature/login で作業中。",
      "status": "known",
      "evidence": [{"type":"document","path":"CHATGPT_PROJECT_STATUS.md","heading":"現在状態（CURATED）","line":3}],
      "sourceKind": "document",
      "sourceUpdatedAt": "2026-10-19T07:37:14.489Z"
    },
    "implementedFeatures": {
      "value": null,
      "status": "unknown",
      "evidence": [],
      "note": "公開許可された文書に、実装済み機能の節が見つからない（現在状態の節に含まれている可能性はあるが、推測で補わない）。"
    },
    "frameworks": {
      "value": [
        {
          "name": "Node.js（npm パッケージ）",
          "kind": "runtime",
          "status": "known",
          "basis": "package.json がある",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "sourceKind": "staticAnalysis"
        },
        "…（ほか 1 件）"
      ],
      "status": "known",
      "evidence": [],
      "documented": {"value":null,"status":"unknown","evidence":[],"note":"公開許可された文書に、技術構成の節が見つからない。"}
    },
    "buildMethods": {
      "value": [
        {
          "kind": "npm scripts",
          "status": "known",
          "basis": "package.json がある",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "contentRead": true,
          "sourceKind": "config",
          "details": {"scripts":["start","…（ほか 1 件）"],"commands":{"start":"node src/index.js","test":"node --test"}}
        }
      ],
      "status": "known",
      "evidence": [],
      "documented": {"value":null,"status":"unknown","evidence":[],"note":"公開許可された文書に、ビルドの節が見つからない。"}
    },
    "entryPoints": {
      "value": [
        {
          "kind": "Node.js パッケージの main",
          "name": null,
          "value": "src/index.js",
          "status": "known",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "sourceKind": "config"
        }
      ],
      "status": "known",
      "evidence": []
    },
    "dependencies": {
      "value": [
        {
          "ecosystem": "npm",
          "manifest": "package.json",
          "runtime": ["express"],
          "development": [],
          "counts": {"runtime":1,"development":0},
          "status": "known",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "sourceKind": "config"
        }
      ],
      "status": "known",
      "evidence": []
    }
  },
  "inferences": [
    {
      "claim": "modules の一部の役割は、ディレクトリ名の規約から推測した（文書には書かれていない）。",
      "basis": "ディレクトリ名の規約（src・tests・docs など）",
      "confidence": "low",
      "evidence": []
    }
  ]
}
```

#### `get_project_structure`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `depth` | 整数 1〜8 | 3 | 返す階層の深さ |
| `limit` / `offset` | 整数 | 200（最大 1000）/ 0 | `entries` のページング |
| `path` | 文字列 | ルート | 起点にするディレクトリ（プロジェクト相対。`..` や絶対パスは `invalid_argument`） |

- 生成物・依存・キャッシュ（`node_modules`、`dist`、`build`、`Intermediate`、`.godot`、`3rdparty` など）のディレクトリは、一覧には載せますが（`excluded: true`）、中には降りません。`.git`・機微な名前・`denyDirectories` は件数（`skipped.hidden`）だけです。
- 走査は幅優先で、20000 エントリーまでです。上限に達したら `summary.truncated` を `true` にします。
- `entries` と `keyFiles` は `gitExposure.paths` を許可したときだけ返します。許可が無いときは、言語別のファイル数と合計だけを返し、`path` 引数は無視します（場所の有無を明かさないため）。
- `keyFiles[].role` は名前の規約からの推測（`roleStatus: inferred`）です。

```json
{
  "tool": "get_project_structure",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "summary": {
      "totalFiles": 9,
      "totalDirectories": 5,
      "totalBytes": 1087,
      "scannedEntries": 14,
      "skipped": {"hidden":1,"links":0,"excludedDirectories":0,"unreadable":0},
      "depthLimitedDirectories": 0,
      "truncated": false,
      "splitByTopDirectory": null
    },
    "languages": [
      {"language":"JavaScript","category":"programming","files":3,"bytes":173},
      {"language":"Markdown","category":"document","files":2,"bytes":492},
      "…（ほか 4 件）"
    ],
    "entries": [
      {
        "path": ".github",
        "kind": "directory",
        "depth": 1,
        "bytes": 61,
        "files": 1,
        "modifiedAt": "2026-10-19T07:37:14.502Z",
        "excluded": false
      },
      {
        "path": ".github/workflows",
        "kind": "directory",
        "depth": 2,
        "bytes": 61,
        "files": 1,
        "modifiedAt": "2026-10-19T07:37:14.502Z",
        "excluded": false
      },
      "…（ほか 11 件）"
    ],
    "keyFiles": [
      {
        "path": ".github",
        "kind": "directory",
        "role": "ciDirectory",
        "roleLabel": "CI・リポジトリ設定のディレクトリ",
        "confidence": "low",
        "depth": 1,
        "roleStatus": "inferred"
      },
      {
        "path": "package.json",
        "kind": "file",
        "role": "manifest",
        "roleLabel": "マニフェスト・ビルド定義（Node.js（npm パッケージ））",
        "confidence": "medium",
        "depth": 1,
        "roleStatus": "inferred"
      },
      "…（ほか 2 件）"
    ]
  },
  "inferences": [
    {
      "claim": "keyFiles の role は、ファイル名・ディレクトリ名の規約から推測した役割で、内容は確かめ…",
      "basis": "ファイル名の規約",
      "confidence": "medium",
      "evidence": []
    }
  ],
  "page": {"offset":0,"limit":200,"returned":13,"total":13,"nextOffset":null}
}
```

#### `get_project_tasks`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `limit` | 整数 1〜200 | 100 | 返す項目の数 |
| `offset` | 整数 ≥ 0 | 0 | ページング |

- 種類（`kind`）: `doc-open-item`（未完了のチェックボックス）、`doc-issue`（課題・リスクの節）、`doc-next-work`（次の作業の節）、`doc-blocker`（ブロッカーの節）、`code-todo`（ソースの TODO / FIXME / XXX / HACK）。
- 各項目に `location`（パス・見出し・行）、`source`、`sourceUpdatedAt`（確認日時の根拠）、`confidence`、`note` を付けます。**古い TODO が今も未解決とは断定しません。** ソースの TODO の確度は常に `low` です。第三者のコードらしい置き場所（`deps`、`vendor` など）の TODO には `possiblyVendored: true` を付けて後ろに並べます。
- ブロッカーを示す節が無いときは `blockers.status: "unknown"` で、「無い」とは言いません。
- ソースの TODO の走査は `detailExposure.sourceText` と `gitExposure.paths` の両方を許可したときだけ行い、行わなかったときは `codeTodoScan.performed: false` と理由を返します。

```json
{
  "tool": "get_project_tasks",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "tasks": [
      {
        "id": "doc-issue:CHATGPT_PROJECT_STATUS.md:10",
        "kind": "doc-issue",
        "text": "同時予約の競合の扱いが未決定。",
        "location": {"path":"CHATGPT_PROJECT_STATUS.md","heading":"課題・リスク・相談事項（CURATED）","line":10},
        "source": "document",
        "sourceUpdatedAt": "2026-10-19T07:37:14.489Z",
        "confidence": "medium",
        "note": "文書の更新日時: 2026-10-19T07:37:14.489Z。文書に書かれた時点の内容で、今も有効とは限らない"
      },
      "…（ほか 3 件）"
    ],
    "counts": {"doc-blocker":0,"doc-issue":1,"doc-open-item":1,"doc-next-work":1,"code-todo":1,"total":4},
    "blockers": {"status":"unknown","note":"妨げている問題を示す記述は見つからなかった。無いことを意味しない"}
  },
  "inferences": [
    {
      "claim": "文書の項目は、その文書が書かれた時点の内容で、今も未完了・未解決とは限らない。",
      "basis": "文書の更新日時より後の変化は、このツールでは確かめられない",
      "confidence": "high",
      "evidence": []
    },
    "…（ほか 1 件）"
  ],
  "page": {"offset":0,"limit":100,"returned":4,"total":4,"nextOffset":null}
}
```

#### `get_project_validation`

引数はありません。**ビルドもテストも実行しません**（`executedNow.performed` は常に `false`）。次の 3 つを別の項目に分けます。

| 項目 | 意味 |
|---|---|
| `configured` | 「設定されている」: ビルド方式、テストの枠組みとコマンド、テストファイルの件数、CI の設定ファイル |
| `pastRecords` | 「過去に成功した／失敗した記録がある」: JUnit XML・TRX・`coverage-summary.json` などの記録と、その日時。**現在の状態を保証しません** |
| `executedNow` | 「今回実行して成功した」: このサーバーは実行しないので常に `performed: false` |

- 記録が見つからないときは `pastRecords.found: false` で、「テストが無い」とは断定しません。
- `ciRunRecords` は常に `unknown` です（CI の実行結果はリモートにあり、見えません）。
- 設定ファイルと記録の本文を読む項目は `detailExposure.sourceText` が要ります。

```json
{
  "tool": "get_project_validation",
  "project": "sample-app",
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "executedNow": {"performed":false,"note":"このサーバーはビルドもテストも実行しません"},
    "configured": {
      "status": "known",
      "semantics": "configured",
      "build": [
        {
          "kind": "npm scripts",
          "status": "known",
          "basis": "package.json がある",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "contentRead": true,
          "sourceKind": "config",
          "details": {"scripts":["start","…（ほか 1 件）"],"commands":{"start":"node src/index.js","test":"node --test"}},
          "executed": false
        }
      ],
      "tests": [
        {
          "type": "command",
          "script": "test",
          "command": "node --test",
          "status": "known",
          "basis": "package.json の scripts",
          "evidence": [{"type":"file","path":"package.json","modified":"2026-10-19T07:37:14.499Z"}],
          "sourceKind": "config",
          "executed": false
        },
        "…（ほか 2 件）"
      ],
      "ci": [
        {
          "kind": "GitHub Actions",
          "count": 1,
          "status": "known",
          "basis": ".github/workflows/ci.yml がある",
          "paths": [".github/workflows/ci.yml"],
          "evidence": [{"type":"file","path":".github/workflows/ci.yml","modified":"2026-10-19T07:37:14.502Z"}],
          "latestModified": "2026-10-19T07:37:14.502Z",
          "sourceKind": "staticAnalysis"
        }
      ],
      "notes": []
    },
    "pastRecords": {
      "found": true,
      "count": 1,
      "records": [
        {
          "kind": "junit",
          "recordedAt": "2026-10-10T08:30:00",
          "recordedAtSource": "recordContent",
          "fileModified": "2026-10-19T07:37:14.502Z",
          "total": 12,
          "passed": 9,
          "failed": 1,
          "skipped": 2,
          "path": "test-results/junit.xml",
          "semantics": "pastRecord",
          "contentRead": true,
          "durationSeconds": 0.8
        }
      ],
      "note": "過去に作られた記録ファイルの内容で、今回の実行結果ではない。"
    },
    "ciRunRecords": {"status":"unknown","note":"CI の実行結果はリモートにあり、このサーバーからは見えません"}
  },
  "inferences": [
    {
      "claim": "記録は過去の実行結果であり、現在の状態を保証しない",
      "basis": "記録の日時以降にコードや設定が変わったかは、このツールでは確かめられない",
      "confidence": "high",
      "evidence": [{"type":"file","path":"test-results/junit.xml","modified":"2026-10-19T07:37:14.502Z"}]
    }
  ]
}
```

#### `get_portfolio_summary`

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `offset` | 整数 ≥ 0 | 0 | ページング |
| `limit` | 整数 1〜50 | 20 | 1 回に返すプロジェクト数 |

- 承認済みのプロジェクトだけを返し、未承認のプロジェクトの存在は明かしません。概要だけを返し、詳細は個別のツールで取得します（`detailTools`）。
- 取得に時間がかかるときは、先頭から順に返して残りを `page.nextOffset` に示します（合計 40 秒を超えたら次のプロジェクトへ進みません）。
- `nextChecks` は「次に確認すべき事項」の**提案**で、すべて「提案: 」で始まります。事実ではありません。
- 各プロジェクトの `collection.status` / `collection.hidden` で、そのプロジェクトの取得状態と隠した項目が分かります。

```json
{
  "tool": "get_portfolio_summary",
  "project": null,
  "meta": {"status":"ok","hidden":[],"warnings":[]},
  "facts": {
    "projectCount": 1,
    "projects": [
      {
        "project": "sample-app",
        "projectName": "sample-app",
        "os": "windows",
        "purpose": {
          "value": "社内向けの小さな予約管理 Web API を提供する。",
          "status": "known",
          "evidence": [{"type":"document","path":"CHATGPT_PROJECT_CONTEXT.md","heading":"目的","line":3}]
        },
        "technologies": [{"name":"JavaScript","status":"known","kind":"language","files":3},"…（ほか 1 件）"],
        "lastActivityAt": "2026-10-13T00:00:00Z",
        "git": {"status":"ok","headState":"branch","currentBranch":"main","uncommittedCount":4,"errorClass":null},
        "implementationStatus": {
          "value": "- 予約の作成・取消 API は実装済み。\n- ログイン機能は feature/login で作業中。",
          "status": "known",
          "templateUnfilled": false,
          "evidence": [{"type":"document","path":"CHATGPT_PROJECT_STATUS.md","heading":"現在状態（CURATED）","line":3}]
        },
        "openIssues": {
          "documentItemCount": 3,
          "blockerCount": 0,
          "codeTodoCount": null,
          "note": "コードの TODO は時間がかかるため数えていません。get_project_tasks で確認できます。文書の項目は今…"
        },
        "testStatus": {
          "level": "pastRecord",
          "lastRecordedAt": "2026-10-10T08:30:00",
          "failedInRecords": 1,
          "summary": "過去の記録ファイルが 1 件ある（記録上の失敗 1 件）。過去の結果で、現在の状態は保証しない。"
        },
        "nextChecks": ["提案: 未コミットの変更が 4 件あります。get_worktree_details で内容を確認してください。","…（ほか 1 件）"],
        "detailTools": ["get_project_overview","…（ほか 6 件）"],
        "collection": {"status":"ok","hidden":[],"errorClass":null,"warnings":[]}
      }
    ]
  },
  "page": {"offset":0,"limit":20,"returned":1,"total":1,"nextOffset":null}
}
```

### エラーの例

存在しないブランチ（`isError: true`）:

```json
{
  "tool": "get_branch_details",
  "meta": {
    "status": "unavailable",
    "errorClass": "ref_not_found",
    "errorReason": "branch に指定したブランチは存在しません。",
    "retryable": false,
    "hidden": []
  }
}
```

権限が無い（`detailExposure.branchNames` が無効）:

```json
{
  "tool": "get_branch_details",
  "meta": {
    "status": "unavailable",
    "errorClass": "permission_denied",
    "errorReason": "ブランチの詳細は、ブランチ名の公開（gitExposure.branchNames）が許可されていないため返せません。",
    "retryable": false,
    "hidden": ["branchNames"]
  }
}
```

引数の不備（`branch` が無い）:

```json
{
  "tool": "get_branch_details",
  "meta": {
    "status": "unavailable",
    "errorClass": "invalid_argument",
    "errorReason": "branch は必須です。",
    "retryable": false,
    "hidden": []
  }
}
```

時間切れ（取得中の失敗。`isError: false` のまま `status` が `unavailable`）:

```json
{
  "tool": "compare_branches",
  "meta": {
    "status": "unavailable",
    "errorClass": "timeout",
    "errorReason": "制限時間内に終わりませんでした。原因（負荷・巨大な履歴・ファイルシステムの遅延など）は特定できません。",
    "retryable": true,
    "hidden": []
  }
}
```

### ChatGPT から使う方法

1. 版を上げたあと、ChatGPT 側のツール定義は自動では更新されません。`https://chatgpt.com/plugins` → 対象のプラグイン（ハブごとに別です。Windows の PC 用と Ubuntu 用のように複数あれば、すべてで行います）→「管理」→「ツールを更新」を実行します。新しいツール（2.5.0 は 10 個、2.6.0 は 6 個、2.7.0 は 5 個、2.9.0 は 1 個。2.9.0 ではハブが 31 個で、ChatGPT の分類は Write 2・Read 29）が一覧に出ます。2.10.0 はツールを足さず、`start_claude_job` の引数 `model`・`effort` を足したので、数は 31 個（Write 2・Read 29）のままです。行わないと、ChatGPT から新ツールが見えません（2.10.0 では、`model`・`effort` を渡せません）。
2. 新しい会話で、たとえば次のように頼みます。
   - 「`list_projects` の承認済みプロジェクトについて `get_portfolio_summary` で全体を教えて」
   - 「`<プロジェクト名>` の全ローカルブランチを `get_git_branches` で一覧して、`main` と各ブランチを `compare_branches` で比べて」
   - 「`<プロジェクト名>` の未コミット変更を `get_worktree_details` で分類して」
   - 「`<プロジェクト名>` の未完了の作業と、テスト結果の記録を、根拠と確認日時つきで教えて」
   2.6.0 のソース読み取りツールでは、たとえば次のように頼みます（`sourceText` と `paths` を許可したプロジェクトで）。
   - 「`<プロジェクト名>` の VoiceConversation の実装を詳しく説明して。まず `find_references` で定義と使用箇所を探し、`read_source` で必要な範囲を読んで」
   - 「`<プロジェクト名>` の `<サブモジュール名>` のアニメーションの処理を、`search_code` と `read_source` で調べて分析して」
   - 「昨日の変更と、現在の未コミットの差分を `get_git_diff`（`since` と `head`）で取得して比べて」
   - 「最新のテストログから、失敗の原因を `read_test_log`（`files` → `search` → `read`）で分析して」（`sourceScope.logDirectories` の設定が必要）
   2.7.0 の Claude Code のジョブでは、たとえば次のように頼みます（`claudeCode` を承認したプロジェクトで）。
   - 「`<プロジェクト名>` の仲間の移動バグを調べて修正方針を立てて。方針がよければ `start_claude_job` で Claude Code に修正とテストをさせ、`get_claude_job` で終わるまで確認して、`get_git_diff`（`unstaged`）で差分をレビューして」
   - 「さっきのジョブの続きとして、レビューの指摘を直すよう `continueJobId` で依頼して」
3. 応答の `meta.status` が `partial` なら、`meta.hidden` を確認します。ブランチ名・差分・ファイル本文が必要なら、利用者がプロジェクトの `.chatgpt-project-bridge.json` の `detailExposure` を許可して承認し直します。ChatGPT が設定を変えることはできません。

### 導入・再起動・設定変更

導入の順は `knowledge/10-silver/areas/release.md` と同じです（コミット → `export-bundle` → 指紋の照合 → Ubuntu は `install.sh --verified`、Windows は `install.ps1 -Verified`）。2.5.0・2.6.0 で増えるファイルは `distribution.json` に載っているので、手順は変わりません（導入のスクリプトも変えていません）。

| 作業 | Windows | Ubuntu |
|---|---|---|
| 導入前の停止 | `project-bridge.ps1 -Action HubStop` | `systemctl --user stop chatgpt-project-bridge-hub.service` |
| 導入 | Bundle の Windows フォルダーをローカルへ写して `install.ps1 -Verified` | `install.sh --verified` のあと `project-bridge.py hub-service-install` |
| 起動 | 自動起動のショートカットを開く、または `-Action HubStart -Service` | `systemctl --user start chatgpt-project-bridge-hub.service` |
| 状態確認 | `-Action HubStatus` | `systemctl --user is-active …`、`healthz` / `readyz` |
| 導入先での点検 | `node scripts/tools-smoke.mjs --hub %APPDATA%\chatgpt-project-bridge\hub.json` | `node scripts/tools-smoke.mjs --hub ~/.config/chatgpt-project-bridge/hub.json` |

- 点検スクリプトは hub.json を書き換えず（通知とアクセスログの項目を外した一時コピーを使う）、承認済みの全プロジェクトに新ツールを読み取りだけで呼んで、状態・隠した項目・サイズ・所要時間の一覧を出します。想定外の失敗があれば `TOOLS_SMOKE FAIL` と終了コード 1 です。
- **既存の承認は無効になりません。** `detailExposure` を足さない限り、公開範囲の指紋は 2.4.x と同じです。`detailExposure` を許可したプロジェクトだけ、`Approve`（Ubuntu は `approve`）で承認し直します。承認の画面には「詳細取得ツール: ブランチ名 公開 / 差分の抜粋 非公開 / …」の行が出ます。
- **2.6.0 の `sourceScope`**: 足さない限り、指紋は 2.5.0 と同じで、承認は有効なままです（`sourceText` と `paths` を許可済みなら、導入と「ツールを更新」だけで新ツールが使えます）。`additionalDirectories` や `logDirectories` を足したプロジェクトだけ、承認し直します（承認の画面と GUI に `sourceScope` の行が出ます）。
- **2.7.0 の `claudeCode`**: 足さない限り、指紋は 2.6.0 と同じで、承認は有効なままです。足したプロジェクトだけ承認し直します（承認の画面と GUI に、許可するコマンドの一覧と警告が出ます）。試験は `node scripts/claude-jobs-selftest.mjs`（偽の Claude Code を使い、本物は起動しない。利用枠も消費しない）。最終行は `CLAUDE_JOBS_SELFTEST PASS (0)` です。
- **2.6.0 を試す手順（利用者が実行する）**:
  1. 導入先（またはリポジトリの写し）で自己試験を実行する: `node scripts/source-tools-selftest.mjs`（新ツール）、`node scripts/tools-selftest.mjs`・`security-selftest.mjs`・`server-boundary-selftest.mjs`・`git-tools-selftest.mjs`・`analysis-selftest.mjs`・`selftest.mjs`（既存）。Windows は PowerShell 7 で `& "<Node のフルパス>" scripts\<試験>.mjs`。Ubuntu は一時コピー（`HOME` も一時にし、`chmod -R go-w`）で実行します（実環境の設定・承認・鍵に触れないため。`knowledge/10-silver/areas/env.md` を参照）。`source-tools-selftest.mjs` の最終行は `SOURCE_TOOLS_SELFTEST PASS (0) SKIP (n)` です。SKIP は、シンボリックリンク・junction・hardlink を作れない環境（Windows の権限）での、リンクの検査です（SKIP は成功扱いにしません。Ubuntu では実行されます）。
  2. 導入先の点検（読み取りだけ）: `node scripts/tools-smoke.mjs --hub <hub.json>`。新ツール 6 個も、プロジェクトごとに最小の引数で 1 回ずつ呼びます（権限が無いプロジェクトは `permission_denied` で、想定内です）。
  3. ChatGPT で「ツールを更新」（両方のプラグイン）→ 新しい会話で、上の「ChatGPT から使う方法」の依頼を試す。
- 新ツールの応答は、終了時保存（オフライン）の対象ではありません。PC が停止している間は、既存の `latest.md` の運用を使います。

### 新ツールの制限

- 取得できるのは、呼び出し時点の Git と、公開許可された範囲の静的な情報だけです。ビルド・テストの実行結果、CI の実行結果、リモートの状態（`fetch` はしません）は分かりません。
- 競合の可能性は、ファイルの重なりに基づく目安です。実際のマージの結果ではありません。
- Markdown と TOML の解析は簡易で、setext 形式の見出しや複数行の文字列などは扱いません。ソースの TODO は、コメントの書き出しの直後にある印だけを拾います。
- 走査は 20000 エントリー、Git 1 回は 15 秒・出力 4 MiB、応答は 256 KiB までです。上限を超えると `partial` で、`warnings` に理由を示します。
- Git が遅い環境では応答に数秒かかります。この版の作成中に、グローバルの Git 設定の `safe.directory` に UNC パスが多数あると、所有者が別のリポジトリでは Git の呼び出しごとに数秒かかる例がありました（同じ呼び出しが UNC を含まない設定では約 0.1 秒。原因の特定まではしていません）。Git 設定の見直しは利用者の判断です。
- Ubuntu（Git 2.34 など古い Git）での動作は、実機で `tools-smoke.mjs` と各自己試験を実行して確認してください（この版の作成時点では Windows だけで実行しています）。

## 2.4.0 で追加した機能（終了時保存）

- Claude Codeの終了時（SessionEnd）に、明示承認した文書とGitメタデータを保存。
- 開始時（SessionStart）にも最新情報を保存して再送。任意で応答完了時（Stop）のチェックポイントを追加。
- 最新情報をJSONと人が読めるMarkdownに保存。通信が失敗してもローカルに残す。
- 別の常時稼働ホストにHTTPSで送信し、元のPCが停止していても読み取り専用MCPで参照。
- 収集日時、文書更新日時、受信日時、期限、未送信、失敗、情報の古さを区別。
- 登録した送信元ごとの専用送信鍵、期限、取り消し、古いデータの再投入防止。

**ZIPを展開しただけでは、フック登録・外部送信・クラウド設置は行いません。**
PCの電源OFF中の参照には、別の稼働ホストへの受信側設置と、ChatGPTの接続設定が必要です。
ChatGPTが終了イベントを自動で記憶する仕組みではなく、必要なときに保存済み情報をツールで読みます。

## 読む順序

1. 新ツールの使い方: このファイルの「2.7.0 で追加した Claude Code のジョブ」「2.6.0 で追加したソース読み取りツール」「2.5.0 で追加した読み取りツール」と、設定の [setup.md](references/setup.md)（詳細取得ツールの公開設定・ソース読み取りツールの公開設定・Claude Code のジョブの設定）
2. [終了時保存の導入手順](references/offline-snapshots.md)
3. [受信サーバーの導入手順](references/offline-relay.md)
4. [改修内容と検証結果](references/CHANGELOG-2.4.0.md)
5. 既存機能の説明: [setup.md](references/setup.md)

## 安全性の修正

中間ディレクトリのリンクによる公開拒否の迂回、FIFOでの停止、走査上限の不備、
単一モードで公開範囲の縮小を即座に反映できない問題を修正しました。
保存機能は既存の文書公開許可に加え、保存対象・送信先・保持期限の独立した承認を必要とします。
本文の秘密検出は完全ではありません。公開する文書自体を確認してください。

## 最小コマンド

```sh
node scripts/offline-bridge.mjs help
```

Node.jsの追加依存パッケージはありません。同梱の依存ロックは変更していません。
2.4.0 の改修の実行試験はLinux / Node.js 24.19.0で実施しています。2.5.0・2.6.0・2.7.0 の実行試験は Windows（Node.js 24.19.0・Git 2.56）で実施し、Ubuntu は実機での確認が別途必要です（上の「2.6.0 を試す手順」）。
Windows実機・Claude Code本体の終了イベント・実サービスのTunnel接続は別途確認が必要です。
