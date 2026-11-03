# 終了時保存とPC停止中の参照

## 1. 構成とできること

開発PCの既存MCPは、そのPCが停止すれば応答できません。本機能は、終了前に保存した情報を別の稼働ホストから提供します。

| 場所 | 担当 |
|---|---|
| 開発PC | 文書の安全な読み取り、Git状態の収集、ローカル保存、HTTPS送信 |
| 受信ホスト | 最新snapshotの保存、期限判定、読み取り専用stdio MCP |
| Secure MCP Tunnel | 受信ホストとChatGPTの接続 |
| ChatGPT | 保存日時を確認してプロジェクト情報を取得・検索 |

開発PCと受信ホストを同時に停止すると、この構成では参照できません。受信ホストは別の常時稼働Linux PC、Linux NAS、VPSなどを用意します。このZIPには設置用コードを含みますが、実サービスへの設置や接続は済んでいません。

### 保存する情報

初期化時点で既存ブリッジの公開承認があるプロジェクトだけを候補にします。初期選択は、実在して読み取り許可がある概要文書、状態文書、README.mdです。追加の文書を保存したい場合は、後述の両方の公開範囲へ明示追加します。

Gitは既存の公開設定に従います。変更件数、ブランチ、HEAD、直近14日・最大20件のコミット情報を保存します。変更パスとコミット件名は、既存の gitExposure で許可されている場合だけ含みます。Git自体を保存しない設定もあります。実行プログラムを含み得るGit設定がある場合は従来どおり情報を収集しません。

**会話ログ、transcript_path、プロンプト、環境変数、認証情報、ソースコード全体は自動収集しません。** 終了フックが作業内容を意味的に要約するわけではありません。Claude Codeには、作業中に概要・状態文書を更新してもらってください。収集日時が新しくても、文書の説明が古いことはあります。

## 2. 既存版からの配置

既存ブリッジを停止し、現在のコードを退避したうえで、このZIPの chatgpt-project-bridge フォルダーを従来の配置先へ反映します。プロジェクト直下の公開設定、ユーザー領域の承認、hub.json、TunnelキーはこのZIPに含まず、上書き対象ではありません。

標準配置先の例:

- Windows: `%USERPROFILE%\.codex\skills\chatgpt-project-bridge`
- Ubuntu: `$HOME/.codex/skills/chatgpt-project-bridge`

従来のGUIはライブ接続の管理用です。今回の終了時保存の設定は、新しいCLIを使います。GUIに新ボタンを追加したとは扱わないでください。

Claude Codeの版を `claude --version` で確認します。この導入手順は **2.1.268以上** を前提にします。フックは直接実行形式（exec form）のcommand＋argsを使い、timeoutを20秒にします。実機で `/hooks` を開き、登録が認識されていることを確認してください。古い版で未知のargsフィールドを無視させる運用はしないでください。

## 3. 最初にローカル保存を設定する

送信先をまだ決めていなくても、ここまでは実施できます。

### Windows / PowerShell 7

```powershell
$bridgeRoot = "$env:USERPROFILE\.codex\skills\chatgpt-project-bridge"
$offlineState = "$env:APPDATA\chatgpt-project-bridge\offline\desktop"
$hubFile = "$env:APPDATA\chatgpt-project-bridge\hub.json"
node "$bridgeRoot\scripts\offline-bridge.mjs" init --state-dir "$offlineState" --source-id desktop --hub "$hubFile"
node "$bridgeRoot\scripts\offline-bridge.mjs" review --config "$offlineState\publisher.json"
```

### Ubuntu / Bash

```bash
bridge_root="$HOME/.codex/skills/chatgpt-project-bridge"
bridge_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-project-bridge"
offline_state="$bridge_config_root/offline/ubuntu"
node "$bridge_root/scripts/offline-bridge.mjs" init --state-dir "$offline_state" --source-id ubuntu --hub "$bridge_config_root/hub.json"
node "$bridge_root/scripts/offline-bridge.mjs" review --config "$offline_state/publisher.json"
```

hubを使わない場合は `--hub` の代わりに、`--project-root`、`--approval-file`、`--project-name` を指定します。すべて実際の絶対パスを使います。送信元IDはPCごとに別の名前にしてください。

initは未承認の下書きを作ります。既存publisher.jsonを上書きしません。stateDirはプロジェクトの外のローカルディスクに置きます。Linuxではフォルダー0700、ファイル0600が必要です。Windowsはリンク検査をしますがACLの検証は未実装です。共有フォルダーに置かず、本人のユーザー領域のアクセス権を別途確認してください。

### 保存方針の承認と試行

reviewが表示する全項目、特に `projects[].files`、Git保存の可否、送信先、保持期限を読みます。内容を確認した本人が、表示された64桁の `policySha256` を指定します。

```text
node <bridge>/scripts/offline-bridge.mjs approve --config <絶対パスのpublisher.json> --fingerprint <確認した64桁のSHA256>
node <bridge>/scripts/offline-bridge.mjs capture --config <絶対パスのpublisher.json>
node <bridge>/scripts/offline-bridge.mjs status --config <絶対パスのpublisher.json>
```

stateDirに `latest.snapshot.json` と `latest.md` ができます。latest.mdは人による確認やChatGPTへの手動添付にも使えます。**このローカル保存だけでは、PC停止後の自動取得はできません。** 手動添付した文書は、その会話で参照可能な資料になります。

## 4. 受信ホストへの送信を設定する

[受信側の導入手順](offline-relay.md)に従って、別ホストにsnapshot-relay.mjsと専用Tunnelを設置します。書き込み用の鍵は受信側のinitが生成します。既存のOpenAI Runtime API Keyとは別物です。

受信側で生成した送信元専用tokenファイルを、信頼できるファイル転送経路で開発PCのプロジェクト外へ置きます。鍵の値を会話、Git、コマンドライン、URLに貼り付けないでください。ファイルのパスを設定します。

publisher.jsonの次の項目を設定して、もう一度review→approveを実行します。

```json
{
  "endpoint": "https://your-owned-host.example/v1/snapshots/desktop",
  "tokenFile": "送信鍵ファイルの絶対パス",
  "caFile": null
}
```

上記は設定の抜粋であり、この3項目だけでpublisher.json全体を置き換える例ではありません。sourceIdがubuntuならURL末尾もubuntuです。URLは自分が管理する実在の受信先へ変更してください。公開HTTP、URL内認証情報、URLクエリー、フラグメント、リダイレクトは使いません。私設CAを使う場合だけ、caFileへ信頼するCA証明書の保護された絶対パスを指定して再承認します。TLS検証を無効にする設定はありません。

```text
node <bridge>/scripts/offline-bridge.mjs run --config <絶対パスのpublisher.json>
```

送信先の正当な証明書と、応答のsourceId・収集日時・SHA-256が一致した場合だけ送信成功とします。この成功は受信側の保存確認であって、ChatGPT側の接続成功を意味しません。

## 5. Claude Code終了時のフック登録

保存と送信を手動で確認した後、次を実行します。

```text
node <bridge>/scripts/offline-bridge.mjs install-hook --config <絶対パスのpublisher.json>
```

既定はユーザーの `.claude/settings.json` です。CLAUDE_CONFIG_DIRがある場合はそちらを使います。必要な場合だけ `--settings <絶対パス>` で変更できます。他の設定や他のフックを保持し、変更前の内容をstateDir/hook-backupsへ保存します。組織の管理設定やdisableAllHooksを解除しません。

| イベント | 処理 |
|---|---|
| SessionEnd | 最新情報を保存し、設定済みなら送信。直近30秒以内に収集済みなら再収集しない |
| SessionStart | 最新情報を保存して再送。古い未送信データの権限を無条件には信用しない。起動理由（source）が clear / compact / fork のときは何もしない |
| Stop（任意） | 応答完了時にも保存。既定は5分間隔。収集が失敗し続けても、最後の試行から間隔が空くまで再試行しない |

応答完了時にも保存する場合は、install-hookに `--checkpoints` を付けます。これは電源断前に保存される機会を増やしますが、停電や強制終了での実行保証はありません。

フックが入力から読むのは、cwd、イベント名、起動理由（SessionStart の source）、終了理由（SessionEnd の reason。許可リストの値だけ）です。transcript_path・プロンプト・応答本文は開きません。フックのcwdは登録済みルートに一致するかだけを検査し、入力のパスから送信先や公開権限を作りません。登録プロジェクトのどれかで発火した場合、この送信元に明示登録した全プロジェクトを更新します。未登録のworktreeを自動追加しません。

## 6. 確認と失敗時の扱い

Claude Codeで通常終了した後、statusを確認します。

| 項目 | 意味 |
|---|---|
| capturedAt | スナップショットを収集した時刻 |
| documents[].modified | それぞれの文書の更新時刻 |
| lastSuccessAt | 受信側が保存確認を返した時刻 |
| currentPolicyMatches | 現在の保存設定と保存時の設定が一致するか |
| currentSnapshotMatches | ローカル本文と状態記録のハッシュが一致するか |
| currentSnapshotSynced | 現在の設定・本文で確認済みの同期か |
| pending / lastErrorCode | 未送信または失敗の記録 |
| stale / expired | 情報が古いか、有効期限を過ぎたか |

- 通信失敗: ローカルの最新snapshotを保持。`run`で最新情報を再収集して送信できます。
- 公開承認の変更: 保存や再送を拒否。保存対象や送信先を確認し、必要な承認をやり直します。
- 各プロジェクトの承認失効: その本文を新snapshotへ含めず、受信側の旧本文も次の成功した全置換で消します。通信できない間は、受信側取消または期限切れまで旧情報が残り得ます。
- 古い未送信データ: 受信側の既定は収集から24時間を超える新規uploadを拒否します。`run`で更新してください。
- 重いプロジェクト: フックからの実行は、収集子プロセスが9秒、ネットワークが6.5秒の期限です。手動の `capture` は45秒、手動の `sync` / `run` / `revoke-remote` はネットワークが30秒の期限です。処理が期限に間に合わなければ、成功扱いしません。
- 通信失敗のバックオフ: 直前の送信が通信の失敗（network_error / network_timeout / http_rejected / invalid_receipt）で終わり、その試行から600秒以内なら、フックは収集とローカル保存だけを行い送信を省きます。手動の `sync` / `run` には適用しません。
- busy: 別の保存処理が稼働中です。同じ送信元では並行書き込みを行いません。終了したプロセスのロックは、作成から20秒を超えると再試行で回復します。稼働中のプロセスのロックは回復しません。

受信側MCPの `get_snapshot_status` と `list_projects` を確認し、さらに実際に `get_project_status` を呼びます。その後に元のPCを停止し、同じ受信側の接続から再度取得できることを確認してください。

## 7. 情報を増やす方法

projects[].filesに相対パスを追加するだけでは、既存ライブブリッジの公開許可を広げられません。

1. 対象文書をレビューする。
2. 必要なら既存 `.chatgpt-project-bridge.json` のallowFilesへ明示追加し、既存コマンドで公開範囲を承認する。
3. publisher.jsonのfilesとexposureSha256を更新する。ライブ側ShowExposure/show-exposureのSHA-256を使う。
4. オフライン側review→approveを実施する。
5. captureしたlatest.mdの内容を確認し、runで送る。

作業の引き継ぎ用には同梱の `assets/CHATGPT_PROJECT_HANDOFF.template.md` を利用できます。APIキーや顧客情報を入れず、実施内容・未解決事項・次の作業・検証済み/未検証を記録します。このテンプレートを自動的に公開許可へ追加することはありません。

## 8. 保存期限と解除

既定は24時間でstale、7日でexpiresです。publisherのttlHoursは1〜720時間で設定でき、変更には再承認が必要です。受信側は期限切れ本文を返しません。受信データの削除・一時ファイルの扱いは[受信側手順](offline-relay.md)を参照してください。

ローカルのlatest.md/latest.snapshot.jsonは確認・再送のため保存するため、期限による自動消去はしません。OSのバックアップや手動コピー、強制終了時に残った一時ファイルにも情報が残る可能性があります。承認や期限を、第三者の記憶や保存済みコピーまで消す仕組みとは扱わないでください。

```text
node <bridge>/scripts/offline-bridge.mjs uninstall-hook --config <絶対パスのpublisher.json>
node <bridge>/scripts/offline-bridge.mjs revoke-remote --config <絶対パスのpublisher.json>
```

登録状況は、次の読み取り専用コマンドで確認できます。設定やディレクトリを作らず、Node・スクリプトの存在と現在のNodeとの一致を警告コードで示します。Claude Code が実際にフックを実行したかは確認しません（claudeHookExecutionVerified は常に false）。

```text
node <bridge>/scripts/offline-bridge.mjs hook-status --config <絶対パスのpublisher.json> [--settings <絶対パス>]
```

順番はフック解除→受信側取消です。フックを残したまま取消だけ行うと、次回に再公開されます。Nodeや配置先を変えた場合は旧登録が完全一致しなくなるため、警告を確認し `/hooks` で旧登録を手動確認してください。

## 9. 検証範囲と一次資料

自己試験の結果と未検証項目は[変更履歴](CHANGELOG-2.4.0.md)に記載します。スキーマ検証とパターン置換は、あらゆる秘密情報の検出や同一OSユーザー権限の攻撃者に対する防御を保証するものではありません。受信ホスト管理者は保存本文を読めます。

Claude Codeのイベント、exec form、終了時制限の確認元（2026-10-10参照）:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/settings
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

OpenAI側の接続は、既存のSecure MCP Tunnel手順と受信側手順を参照してください。外部サービスの接続設定や認証鍵は本改修で変更していません。
