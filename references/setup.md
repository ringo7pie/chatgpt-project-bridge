> 2.4.0追加: Claude Code終了時の保存とPC停止中の参照は [offline-snapshots.md](offline-snapshots.md) を参照してください。新機能は専用CLIで設定します。

# セットアップと別PC移行

色分けした図解は同じフォルダーの `インストールマニュアル.html` を開いてください。

## 公式URL

- Secure MCP Tunnelガイド: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Tunnel作成・管理: https://platform.openai.com/settings/organization/tunnels
- Runtime API Key: https://platform.openai.com/settings/organization/api-keys
- ChatGPT Plugins: https://chatgpt.com/plugins

## 実行前の照合（必須）

インストーラーは自分自身の改ざんを検知できません。コピーしたフォルダーは、実行する前に人が照合します。

照合に使う値は、Bundleとは別の経路（対面、社内チャット、電話など）で受け取ります。

- 署名者の公開鍵を書いた `allowed_signers`（初回に一度だけ受け取る）
- 各OSの `SHA256SUMS.txt` の指紋（`ExportBundle` が最後に表示するSHA-256）

`allowed_signers` は次の1行の形式です。

```text
bridge-maintainer namespaces="chatgpt-project-bridge-bundle" ssh-ed25519 AAAA...
```

### 署名がある場合（`SHA256SUMS.txt.sig` がある）

Windows（OpenSSHクライアントは Windows 10/11 に標準で入っています）:

```powershell
cmd /c "ssh-keygen -Y verify -f allowed_signers -I bridge-maintainer -n chatgpt-project-bridge-bundle -s SHA256SUMS.txt.sig < SHA256SUMS.txt"
```

Ubuntu:

```bash
ssh-keygen -Y verify -f allowed_signers -I bridge-maintainer -n chatgpt-project-bridge-bundle -s SHA256SUMS.txt.sig < SHA256SUMS.txt
```

`Good "chatgpt-project-bridge-bundle" signature` と表示されれば、`SHA256SUMS.txt` は署名者が作ったものです。続けて、各ファイルが一覧と一致することを確かめます。

### 署名がない場合

`SHA256SUMS.txt` の指紋を、別経路で受け取った値と比べます。

```powershell
(Get-FileHash .\SHA256SUMS.txt -Algorithm SHA256).Hash.ToLower()
```

```bash
sha256sum SHA256SUMS.txt
```

### 各ファイルと一覧の照合（両方の場合で行う）

Windows:

```powershell
Get-Content .\SHA256SUMS.txt | ForEach-Object { $hash, $name = $_ -split '\s+', 2; if ((Get-FileHash -LiteralPath $name -Algorithm SHA256).Hash.ToLower() -ne $hash) { throw "不一致: $name" } }; 'OK'
```

Ubuntu:

```bash
sha256sum -c SHA256SUMS.txt
```

## 1コマンドインストール

`ExportBundle`で作った対象OSのフォルダーを丸ごとコピーします。`install`、Skill archive、`SHA256SUMS.txt`、`VERSION.txt`（署名した場合は `SHA256SUMS.txt.sig` も）を同じ場所に保ってください。

Skillのソース（リポジトリ）の `scripts/install-windows.ps1` と `scripts/install-ubuntu.sh` は、そこからは実行しません。Bundleの中の `install.ps1` / `install.sh` として、Skill archiveと同じフォルダーで実行します。Skill archiveも導入済みのSkillも無い場合、インストーラーは照合の確認より前に `Bundle archiveがありません` とBundleの作り方を表示して止まります（何も変更しません）。

インストーラーは最初に「署名または指紋の照合は済みましたか」と確認します。上の照合を済ませてから `yes` と答えてください。照合済みで確認を省く場合は `-Verified` / `--verified` を付けます。

Windows 10/11 x64では、Windows PowerShell 5.1から実行できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

インストーラーは、依存物を取得する前にSkill archiveのSHA-256を照合し、archive内の `dependencies.lock.json` を読みます。

- wingetを確認し、不足時だけ正確なID `Microsoft.PowerShell`、`Git.Git` を導入します。
- Node.js 18以上が無い場合は、`OpenJS.NodeJS.LTS` をロックで固定した版（`--version`）で導入します。
- Tunnel Clientは、ロックで固定した版のURLだけから取得し、固定したSHA-256と必要CLI flagを照合してユーザー領域へ配置します。GitHubの「最新版」は参照しません。
- Skillはlock、stage、timestamp backup、rollback付きで交換されます。
- ランチャー（`chatgpt-project-bridge` / `chatgpt-project-add` / `chatgpt-hub-add` と、管理画面（GUI）の `chatgpt-project-bridge-gui`）を `%LOCALAPPDATA%\ChatGPTProjectBridge\bin` に作ります。ランチャーの中のパスは `%USERPROFILE%` などの環境変数の参照で書くので、ユーザー名が日本語でも動きます（それ以外の場所に英数字以外を含むパスがあると、インストーラーは理由を表示して止まります）。
- ユーザーの `PATH` には、既存の値の型（通常は `%USERPROFILE%` などの参照を残す REG_EXPAND_SZ）を保ったまま、ランチャーの場所を追加します。
- スタートメニューへ、管理画面を開くショートカット `ChatGPT Project Bridge` を作ります（`%APPDATA%\Microsoft\Windows\Start Menu\Programs`）。

Ubuntu LTS 22.04 / 24.04 / 26.04 のamd64またはarm64では次を実行します。

```bash
bash ./install.sh
```

- 不足するapt packageだけを、rootなら直接、一般ユーザーなら`sudo`で導入します。
- 既存のNode.js 18以上は維持します。無い場合は、ロックで固定した版のNode.jsを、固定したSHA-256と照合してユーザー領域へ導入します。
- Tunnel Clientも、ロックで固定した版とSHA-256、必要CLI flagを検証します。
- curlはHTTPS以外への接続とリダイレクトを拒否します。
- ランチャー4つ（`chatgpt-project-bridge` / `chatgpt-project-add` / `chatgpt-hub-add` / 管理画面（GUI）の `chatgpt-project-bridge-gui`）を `~/.local/bin` に作ります。
- アプリメニューへ、管理画面を開く項目 `ChatGPT Project Bridge 管理画面` を作ります（`${XDG_DATA_HOME:-$HOME/.local/share}/applications/chatgpt-project-bridge.desktop`）。
- 管理画面に必要な `python3-gi` と `gir1.2-gtk-3.0` は、自動では導入しません（サーバー用の最小構成にGTKを入れないためです）。不足していれば `WARN: …` と導入コマンドを表示するだけで、インストールは続けます。管理画面を使う場合は `sudo apt install python3-gi gir1.2-gtk-3.0` を実行してください。
- インストーラーが使う Python は `python3 -I` で実行し、Bundle フォルダー（実行したフォルダー）に置かれた偽のモジュールを読みません。アプリメニューの項目（`.desktop`）は、置き場かエントリが symlink のときは作らず、警告を出して続けます。詳しくは「安全のしくみと注意」の「インストーラーの安全策（Ubuntu）」にあります。

両OSとも、Tunnel Clientが動作中ならインストールを安全に拒否するため、停止してから再実行します。installerはRuntime API Key、Tunnel profile、公開範囲の承認、project、scheduled task、systemd unitを作成または変更しません。スタートメニューのショートカットと `.desktop` は、管理画面を開くだけの項目で、自動起動には登録しません。

## プロジェクトを追加する

インストール後、新しい端末で実行します。

```text
chatgpt-project-add
```

対話を減らす例です。公開範囲の承認自体は既定で必須です。

```powershell
chatgpt-project-add -ProjectRoot 'E:\work\MyProject' -ProjectName 'MyProject' -TunnelId 'tunnel_0123456789abcdef0123456789abcdef'
```

```bash
chatgpt-project-add --project-root "$HOME/work/MyProject" --project-name MyProject --tunnel-id tunnel_0123456789abcdef0123456789abcdef
```

追加コマンドは次の順序を保証します。

1. Tunnel URLを表示し、`tunnel_id`を受け取る。別Tunnelや別rootのprofileは、ここで拒否する。
2. 初回だけscaffold（bridge設定と2つの文書）を作る。
3. local test（MCP stdioの自己試験と公開境界の自己試験）を実行する。
4. 公開範囲（公開ファイル、公開ディレクトリ、拒否ディレクトリ、Gitの公開設定、文書の上限）とその指紋を表示し、承認を求める。承認されるまでTunnel profileやkeyを変更しない。
5. 同じTunnel/profileは再利用する。
6. profile設定の成功後だけRuntime API Key URLと非表示入力を案内する。既存keyは内容を読まず存在だけで再利用する。
7. `doctor`を実行し、ChatGPT Plugins URLを表示してからforeground起動する。

共通optionは`NoBrowser` / `--no-browser`、`NoStart` / `--no-start`、`ForceReconfigure` / `--force-reconfigure`、`ReplaceKey` / `--replace-key`、`ExposureSha256` / `--exposure-sha256`です。

- `ForceReconfigure`は同じprojectと同じTunnelのprofile再生成だけに使い、既存設定を広範囲に置換する`Force`は渡しません。
- `ExposureSha256`は非対話で承認するときに使います。表示された指紋と一致した場合だけ承認します。表示内容を人が確認せずに使わないでください。
- foreground起動の終了はCtrl+Cです。

## 複数プロジェクトを1つにまとめる（ハブ方式）

同じPCの複数プロジェクトを、**PCごとに1つ**の Tunnel・ChatGPT App・Runtime API Key で公開できます。プロジェクトが増えても、Tunnel・App・キーを作り足す必要はありません。

```text
chatgpt-hub-add
```

```powershell
chatgpt-hub-add -ProjectRoot 'E:\work\ProjectA' -TunnelId 'tunnel_0123456789abcdef0123456789abcdef'
chatgpt-hub-add -ProjectRoot 'E:\work\ProjectB'
```

```bash
chatgpt-hub-add --project-root "$HOME/work/ProjectA" --tunnel-id tunnel_0123456789abcdef0123456789abcdef
chatgpt-hub-add --project-root "$HOME/work/ProjectB"
```

- **1つ目**: scaffold → 自己試験 → 公開範囲の承認 → ハブへ登録 → Tunnel ID の入力 → ハブ用プロファイルの生成 → Runtime API Key の入力 → doctor → 起動、の順に進みます。このPC用に Tunnel・キー・ChatGPT の App を1つずつ作ります。
- **2つ目以降**: scaffold → 自己試験 → 公開範囲の承認 → ハブへ登録、で終わります。Tunnel・キー・App には触れず、起動中のハブにも再起動なしで反映されます。
- ハブ内の名前はプロジェクト名から作ります。変えたいときや重複するときは `-HubName` / `--hub-name` で指定します。

ChatGPT では、最初に `list_projects` を呼び、各ツールの `project` 引数でプロジェクトを指定します。`search` は `project` を省略すると承認済みの全プロジェクトを検索し、文書IDは `プロジェクト名::相対パス` の形になります（`fetch` にそのまま渡します）。

管理コマンド:

```powershell
chatgpt-project-bridge -Action HubList
chatgpt-project-bridge -Action HubStart
chatgpt-project-bridge -Action HubStop
chatgpt-project-bridge -Action HubRestart
chatgpt-project-bridge -Action HubDoctor
chatgpt-project-bridge -Action HubStatus
chatgpt-project-bridge -Action HubRemove -HubName ProjectB
```

```bash
chatgpt-project-bridge hub-list
chatgpt-project-bridge hub-start
chatgpt-project-bridge hub-stop
chatgpt-project-bridge hub-restart
chatgpt-project-bridge hub-doctor
chatgpt-project-bridge hub-status
chatgpt-project-bridge hub-remove --hub-name ProjectB
```

- `HubStart` / `hub-start` は、起動前に全プロジェクトの公開範囲の承認を確認し、変わったプロジェクトだけ承認を求めます。
- `HubStop` / `hub-stop` は、別の端末から動いているハブを止めます。`HubRestart` / `hub-restart` は、止まったことを確かめてから起動し直します。
- `HubRemove` / `hub-remove` はハブから外すだけで、プロジェクトのファイルと承認は残します。

### ハブはいつ動いている必要があるか

ChatGPT は文書を保存せず、質問のたびに Tunnel 経由でこのPCへ取りに来ます。そのため、**ChatGPT がプロジェクトを読む時点で、ハブが起動している必要があります**。止めている間は、プラグインの作成、ツールの再読み込み、文書の取得ができません（そのチャットで既に読んだ内容についての会話だけは続けられます）。

### 自動起動（任意）

ログイン（サインイン）時にハブを自動で起動できます。既定では無効で、次のコマンドを実行したPCだけで有効になります。

```powershell
chatgpt-project-bridge -Action HubServiceInstall
chatgpt-project-bridge -Action HubServiceUninstall
```

```bash
chatgpt-project-bridge hub-service-install
chatgpt-project-bridge hub-service-uninstall
```

- Windows はスタートアップ フォルダーにショートカットを置きます（管理者権限は不要）。登録と同時に、ハブをバックグラウンドで起動します。**サインイン時に起動するため、自動サインインを設定していない PC では、再起動後に人がサインインするまでハブは起動しません。**
- Ubuntu は systemd のユーザーサービス（`~/.config/systemd/user/chatgpt-project-bridge-hub.service`）を登録して起動します。状態は `systemctl --user status chatgpt-project-bridge-hub` で確認できます。
  - ログインしていないときも動くよう、linger（`loginctl enable-linger`）も有効にします。有効にできなかったときは、失敗にせず `sudo loginctl enable-linger <ユーザー名>` を案内します。`--no-enable` のときは linger に触れません。
  - ユーザーサービスからはシステムの `network-online.target` が見えないため、ユニットは `ExecStartPre` で既定経路が付くまで最大 60 秒待ってから起動します（付かなくても起動します）。
- 登録の状態は、Windows は `HubStatus`・`HubDoctor` が、Ubuntu は `hub-doctor` が表示します（未登録・不整合・linger 無効は警告で、操作は失敗にしません）。インストーラーも導入の最後に表示します。**どれも自動では登録しません。**
- 自動起動では入力を求めません（`-Service` / `--service`）。未承認のプロジェクト、設定が変わったプロジェクトは、公開しないまま起動します。`Approve` / `approve` で承認すると、再起動なしで公開されます。
- 手動で起動中のハブがある場合は、先に止めてから登録してください。
- **注意**: 自動起動にすると、ログインしている間（Ubuntu で linger を有効にしたときは、ログインしていないときも）、承認済みのプロジェクトが ChatGPT から常に読める状態になります。

### 通知とアクセスログ

ハブは、次のときにデスクトップ通知を出します（数秒で自動的に消えます）。

- ハブ（MCPサーバー）が起動したとき
- ChatGPT からアクセスがあったとき（プロジェクト名とツール名を表示。同じプロジェクトは60秒に1回まで）

すべてのアクセスは、時刻・プロジェクト名・ツール名・成否をアクセスログに記録します。文書の内容は記録しません。

- Windows: `%APPDATA%\chatgpt-project-bridge\access.log`（通知は Windows のトースト通知）
- Ubuntu: `~/.local/state/chatgpt-project-bridge/access.log`（`0600`。通知は `notify-send`。無ければ `sudo apt install libnotify-bin`）

設定はハブ設定（`hub.json`）の `notifications` で変えられます。`start` と `access` を `false` にすると通知を止め、`intervalSeconds` で通知をまとめる秒数を変えられます。2.2.1 以前に作ったハブには、次回の `HubStart` / `hub-start` で既定値（通知あり）が書き足されます。従来方式（`chatgpt-project-add`）は、2.2.2 以降に作った Tunnel プロファイルで通知とログ（`access-<profile>.log`）が有効になります。
- ハブ設定は `%APPDATA%\chatgpt-project-bridge\hub.json`（Ubuntu は `~/.config/chatgpt-project-bridge/hub.json`、`0600`）です。プロジェクトの外にあるので、プロジェクト側から自分を登録したり、他のプロジェクトを書き換えたりはできません。

**制約と注意**

- 1つの Tunnel ID で同時に動かせる Tunnel Client は1台だけです（OpenAI の tunnel-client README に明記）。複数PCで同じ Tunnel を同時に使わず、PCごとにハブ（Tunnel・App・キー）を作ってください。
- App を使えるチャットからは、承認済みの全プロジェクトが読めます。ある文書に紛れた指示で、ChatGPT が別プロジェクトを読むよう誘導されることがあります。機密度の違うプロジェクトは、従来方式（`chatgpt-project-add`、プロジェクトごとの Tunnel・App）に分けてください。
- ハブを止めると、そのPCの全プロジェクトが止まります。
- 同じプロジェクトを、ハブ方式と従来方式の両方で同時に起動しないでください。従来方式から移す場合は `chatgpt-hub-add` で登録し、不要になった従来の Tunnel と App を Platform と ChatGPT の画面で削除します。

## 管理画面（GUI）

コマンドを覚えなくても、全ての Action（操作）を画面から実行できます。各ボタン・入力欄・チェックにマウスを載せると、何をするか・いつ使うか・注意点が日本語で表示されます。説明文は `assets/gui-help.ja.json` に 1 か所だけ置き、Ubuntu 版と Windows 版で同じものを使います。

画面は、既存のコマンドを子プロセスとして呼ぶだけです。パスの検査・指紋の照合・キーの検査・上書きの確認は、コマンド側が行います。画面自身は `hub.json`・承認ファイル・プロジェクトの設定を書き換えません（ハブの登録一覧と稼働の表示のために、`hub.json` と Tunnel Client の PID ファイルを読むだけです。通信はしません）。

### 起動のしかた

- Ubuntu: アプリメニューの「ChatGPT Project Bridge 管理画面」を選ぶか、端末で `chatgpt-project-bridge-gui` を実行します。`python3-gi` と `gir1.2-gtk-3.0` が必要です（インストーラーは自動では入れません）。
- Windows: スタートメニューの「ChatGPT Project Bridge」を選ぶか、`chatgpt-project-bridge-gui` を実行します（PowerShell 7 と WinForms を使います）。**Windows 版の画面は、実機での確認が済むまで未検証です。** 確認の手順は、同じフォルダーの `gui-windows-check.md` にあります。

### 画面の構成

画面は、上部の「ハブ」の表示、4 つのタブ、下部の共通欄でできています。

- 上部の「ハブ」の表示（どのタブを開いていても見えます）: この PC のハブ（Tunnel Client）のプロセスが動いているかを、3 秒ごとに調べて表示します。表示は `ハブ: ● 実行中（PID …）`・`ハブ: ○ 停止中`・`ハブ: 未設定`・`ハブ: 確認できません` のどれかで、右に Tunnel ID・プロファイル名・登録の件数が出ます。この画面の外（別の端末や自動起動）で起動したハブも表示します。「実行中」が示すのは、「確認の 5 段階」のうち 3 の Tunnel Client のプロセスの有無だけです。
- 「かんたん」: 「プロジェクトを追加」「ハブを起動」「ハブを停止」「ハブの稼働状態」「登録一覧を表示」「権限を確認（ソース・Claude Code）」。上部に、ハブに登録済みのプロジェクトの一覧（「一覧を更新」で `hub.json` を読み直します。2.8.0 から、「ソースの読み取り」「Claude Code」「承認」の列と、権限を確認・切り替えるボタンがあります。下の「権限の切り替え」）と「確認の 5 段階」があります。
- 「ハブ方式」: 「ハブから外す」「ハブを再起動」「ハブを診断」「自動起動を登録」「自動起動を解除」。
- 「従来方式」: 1 プロジェクトに 1 つの Tunnel を使う方式の操作（「プロジェクトを初期化」「Tunnel を設定」「キーを保存」「状態文書を更新」「自己試験」「診断」「Tunnel を起動」「稼働状態を表示」「プロジェクトを追加（従来方式）」）と、「公開範囲を承認」「公開範囲を確認」。
- 「保守者向け」: 「Skill を書き出し」「配布 Bundle を作成」「依存物ロックを更新」。署名鍵や `gh`（GitHub CLI）を使う、配布物の作成者向けの操作です。
- 下部の共通欄: 「実行されるコマンド」（画面がコマンドへ渡す引数を 1 行に整えて表示します。裏のコマンドを学ぶのにも使えます）と、「出力ログ」（コマンドの標準出力と標準エラー。「消去」「コピー」ボタンがあります）。

### 分かっている値の自動入力

起動したときと、「一覧を更新」を押したとき（操作が終わったときも同じ）に、分かっている値を空の入力欄へ入れます。

- 「プロジェクトを追加」の「Tunnel ID」: ハブに記録済みの Tunnel ID。
- 「Tunnel Client の場所」: 見つかった Tunnel Client のパス（コマンドが探すのと同じ順番で探します）。

入力済みの値は書き換えません。「プロジェクトを追加」の Tunnel ID は、従来方式の「Tunnel を設定」「プロジェクトを追加（従来方式）」の Tunnel ID とは別の欄として扱います（従来方式はプロジェクトごとに別の Tunnel を使うため、ハブの ID は入れません）。プロジェクトのフォルダーや名前は、候補が 1 つに決まらないので入れません。

### マウスオーバーの説明の見かた

- Action のボタンには、概要・いつ使う・事前に必要・実行すると・次にすること・注意が出ます。
- 入力欄とチェックには、概要・入力例・既定・注意が出ます。
- 「確認の 5 段階」の各行にも、その段階で何を確かめるかが出ます。

### 「プロジェクトを追加」の流れ

1. 「かんたん」タブで「プロジェクトのフォルダー」を指定します。設定ファイル（`.chatgpt-project-bridge.json`）がまだ無いときは「プロジェクト名」も入力します。初回は「Tunnel ID」も入力できます（入力しなければ、端末窓で聞かれます）。2 回目以降は、ハブに記録済みの Tunnel ID が入っています。
2. 「プロジェクトを追加」を押します。足場（設定ファイルと文書 2 つ）が無ければ、先に「プロジェクトを初期化」が自動で実行されます。
3. 公開範囲の確認ダイアログ（承認ダイアログ）が開きます。見かたは次の「承認ダイアログの見かた」にあります。詳細を末尾まで読み、「内容を読みました」にチェックして「この内容で承認」を押します（読み終えてチェックするまで押せません）。すでに承認済みで内容が変わっていなければ、ダイアログは出ません。承認しなかった場合（「キャンセル」を押した場合と、閉じた場合）は何も実行せず、そのプロジェクトは公開されません。設定に制御文字などが含まれているときは承認できません（公開範囲の確認の段階でサーバーが拒否して、ログにメッセージが出るか、ダイアログに「承認できません」と赤字で出て、承認ボタンは押せません）。
4. 別の端末窓（Windows は別のコンソール窓）が開き、コマンドが自動で実行されます。Runtime API Key を求められたら、**その窓に貼り付けます**（キーは画面には入力しません）。2 つ目以降のプロジェクトは、キーを求められずに登録だけで終わります。コマンドが終わると、その窓は終了コードを表示して、Enter キーを待ちます。結果を読んでから Enter キーで閉じ、画面の「一覧を更新」を押します。
5. 「ハブを起動」でハブを起動します（次の節）。

端末窓を開くときは、`--no-start` が付くため、ここでは起動しません。起動は「ハブを起動」で別に行います。

端末窓では、この画面のプログラム自身を補助役として起動し、補助役がコマンドを 1 回だけ実行します（Ubuntu は `--terminal-helper`、Windows は `-ConsoleHelper`）。コマンドの終了後に対話のプロンプトを残さず、終了コードを表示して Enter キーを待つだけなので、貼り付けたキーがコマンドとして実行されることはありません。Enter キーの待ち受けでは、入力した内容を表示せず、待つ前に溜まっていた入力は捨てます。Windows の別のコンソール窓は、実機では未確認です。

### 承認ダイアログの見かた

承認ダイアログは、上から次の順に並びます。Ubuntu 版と Windows 版は、同じ規則で作ってあります（Windows 版は実機では未確認です）。

1. **固定の見出し**（スクロールしません）: 承認状態（未承認、または前回の承認から変更あり）、プロジェクトルート、プロファイル（承認の保存先の名前）、ハブの警告（ハブ方式のとき）。
2. **詳細**（スクロールします）: 前回の承認から変わった項目（変更ありのとき）、概要文書、状態文書、公開ファイル、公開ディレクトリ（「配下すべて」か「直下だけ」）、拒否ディレクトリ。1 項目を 1 行に、番号をつけて、値を二重引用符で囲み、**全件を省略せずに**表示します。改行・タブ・行区切り・双方向制御文字・ゼロ幅文字などと、半角空白以外の空白類（全角空白など）は、`\uXXXX` の形（BMP の外の文字は `\UXXXXXXXX`）で見えるようにします。1 つの名前の中にラテン文字とキリル文字（またはギリシャ文字）が混ざっていると、行の後ろに「⚠ 混在した文字種」の印が付きます（見た目が似た別の文字による偽装の疑いです）。
3. **固定の要約**（スクロールしません）: 公開ファイル・公開ディレクトリ（うち配下すべて）・拒否ディレクトリの件数、Git のファイル名と Git のコミット件名を公開するか（「公開」は赤の太字）、文書 1 件の上限、公開範囲の指紋（SHA-256）の 64 桁すべて。件数は、公開範囲の配列の長さから数えます（値の文字列からは作りません）。
4. **「内容を読みました」**: 詳細を末尾までスクロールすると、チェックできるようになります。詳細が全部収まる短い内容のときは、最初からチェックできます。
5. **「この内容で承認」**: 「内容を読みました」にチェックするまで押せません。既定のボタン（Enter キーで押されるボタン）は「キャンセル」です。

押したあとも、画面は同じ条件を確かめ直します。承認すると、表示した指紋だけをコマンドへ渡し、コマンドが現在の公開範囲と照合して、一致したときだけ承認を保存します。

特別な場合は、次のように表示が変わります。

- **「承認できません」（赤字）**: 公開範囲の確認の段階では、サーバーが使えない文字を含む設定を拒否します（ログに「公開範囲の設定に使えない文字が含まれています」と出て中止します）。画面はそれとは別に、受け取った内容そのものも確かめ、承認の対象（プロジェクトのフォルダー・プロファイル名・公開範囲の各項目・前回からの差分）に、制御文字・行区切り・双方向制御文字・不可視文字があるとき（表示の偽装の可能性）と、公開範囲の形式が想定と違うときに、承認を止めます。そのときは、赤字に理由と該当項目（値は引用符つきで、見えない文字は `\uXXXX` の形）が出て、「この内容で承認」は常に押せません（押せるのは「キャンセル」だけです）。対処は「困ったとき」にあります。
- **別のフォルダーの承認を上書きするとき（赤字の警告）**: 承認状態が「変更あり」で、承認ファイルに記録されたプロジェクトルート（`approvedProjectRoot`）が今のフォルダーと違うとき、つまり同じプロファイル名で別のフォルダーが承認済みのときです。承認すると、そのフォルダーの承認が置き換わります。赤字の警告と、追加のチェック「別のフォルダーの承認を上書きしてよいことを理解しました」が出て、追加のチェックを入れるまで「この内容で承認」は押せません。プロファイル名の取り違えや、設定の偽装でないかを確かめてから承認します。

### ハブの起動と停止

- 「ハブを起動」: 登録プロジェクトごとに公開範囲を確認し、未承認のもの・変更があったものは承認ダイアログを出します。承認したものだけ承認が保存されます。承認しなかったプロジェクトは公開されず、ほかのプロジェクトでハブが起動します。そのあと `--service` 付きでハブを起動します。
- 起動中は、カードに「停止」ボタンが出ます。ハブでは `hub-stop` を実行して止めます。従来方式の「Tunnel を起動」では、コマンドと Tunnel Client のプロセスグループへ終了の合図（SIGTERM）を送ります。
- **画面を閉じると、画面から起動したハブ（または Tunnel Client）は止まります。** 起動中に閉じようとすると確認が出ます。ChatGPT から読ませている間は、画面を開いたままにしてください。ログインするたびに自動で起動したい場合だけ、「ハブ方式」タブの「自動起動を登録」を使います（承認済みのプロジェクトが、ログインしている間は ChatGPT から常に読める状態になります）。
- 「ハブを再起動」は、「ハブを起動」と同じ確認をしてから起動し直します。

### 権限の切り替え（ソースの読み取り・Claude Code の起動。2.8.0 以降）

「かんたん」タブのハブの一覧で、プロジェクトごとに、ChatGPT からソースの本文を読めるか、Claude Code を起動できるかを確かめ、On / Off を切り替えられます。

- **「権限を確認」**: ハブの全プロジェクトの状態を調べ、一覧の列を埋めます（`hub-permissions`。読み取り専用で、何も書きません。プロジェクト 1 件につき Node.js を 2 回起動するので、数秒かかります。画面を開いたときは自動では調べません）。列の見かたは次のとおりです。
  - 「ソースの読み取り」: **On**（`detailExposure.sourceText` と `gitExposure.paths` が両方許可）、**Off**、**一部のみ（使えません）**（本文だけ許可されていてファイル名が許可されていない）。
  - 「Claude Code」: **On**（`claudeCode.enabled: true`。許可コマンドの件数も出ます）、**Off**、**設定なし**（`claudeCode` のキーが無い）。
  - 「承認」: **承認済み**、**変更あり（再承認が必要）**、**未承認**、**確認できません（理由）**。「変更あり」「未承認」のプロジェクトは、承認し直すまで ChatGPT から使えません。
- **「ソースの読み取りを切り替え」「Claude Code の起動を切り替え」**: 選んだ行の、いまの値の逆にします（On なら Off、Off・一部のみ・設定なしなら On）。流れは次のとおりです。
  1. 変更後の公開範囲を確かめます（`set-permission` を指紋なしで実行。**何も書きません**）。
  2. 承認ダイアログが開きます。上部に「この承認で、プロジェクトの設定ファイル（.chatgpt-project-bridge.json）も書き換わります」の注記が出ます。Claude Code を On にするときは、既存の警告（ChatGPT が作業ツリーを書き換えさせられる）も出ます。
  3. 「この内容で承認」を押したときだけ、変更と承認が **1 つの操作として** 書かれます（指紋が一致したときだけ設定を書き、書いた実物の指紋を確かめてから承認を保存します。途中で失敗したら設定を元に戻します）。「キャンセル」や閉じた場合は、何も変わりません。
  4. 終わると、一覧の列が更新されます。ハブの再起動は要りません（サーバーは呼び出しごとに設定を読み直します）。
- Off にする（狭める）ときも、承認の指紋が変わるので、承認ダイアログを経ます。キャンセルすると「Off にしたつもりが、まだ On のまま」になるだけで、承認が失効して ChatGPT から使えなくなることはありません。
- ソースの読み取りを Off にしても、ファイル名の公開（`gitExposure.paths`）は残ります（既存の Git の詳細ツールが使うため）。ファイル名も止めたいときは、設定ファイルを手で直して承認し直します。Claude Code を Off にしても、許可コマンドなどの設定は残ります（On に戻すと同じ設定で再開します）。
- 許可コマンド（`claudeCode.allowedCommands`）は、この画面では編集しません。設定ファイルを直すか、`set-permission`（`SetPermission`）の `--allowed-command`（複数は 1 つの値に改行で区切って渡せます）を使います。Claude Code を On にするとき、`claudeCode` が無いプロジェクトでは、許可コマンドなし（ファイルの編集だけ）から始まります。
- 承認のファイルの場所が標準（Windows は `%APPDATA%\chatgpt-project-bridge\approvals\<プロファイル名>.json`、Ubuntu は `$XDG_CONFIG_HOME/chatgpt-project-bridge/approvals/<プロファイル名>.json`）と違う登録は、この画面からは切り替えられません（CLI は標準の場所にしか承認を書かず、サーバーが読む承認とずれるため）。

### 画面が異常終了したとき

画面が止めるのは、画面が起動したハブ（または Tunnel Client）です。止まる場合と、止まらない場合があります。

- **止まる場合（Ubuntu）**: 画面を閉じるとき（動いている処理があれば、確認のあと）と、SIGHUP（端末を閉じた）・SIGTERM・SIGINT（Ctrl+C）・SIGQUIT を受けたときは、起動したコマンドとその子のプロセスグループ（ハブ・Tunnel Client）に終了の合図（SIGTERM）を送ります。最大 5 秒待ち、残っていれば強制終了（SIGKILL）して、画面を終えます。
- **止まらない場合（Ubuntu）**: SIGKILL（`kill -9`）・画面のクラッシュ・電源断では、止める処理が動かないため、ハブ（または Tunnel Client）が動いたまま残ることがあります。
- **Windows**: 画面を閉じるとき、動いている子プロセスがあれば確認を出し、「はい」なら子プロセスをプロセスツリーごと止めます。強制終了を受けて子を止める処理は、コードにありません。Windows 版は実機では未確認です。
- **Windows で、画面を起動したコンソールの Ctrl+C・Ctrl+Break**: 画面を閉じるときと同じ扱いにします。前面にダイアログ（承認ダイアログなど）があれば、まず「キャンセル」と同じ扱いで閉じ（承認はしません）、そのあと画面を閉じます。動いている子プロセスがあれば、上と同じ確認を出します（「いいえ」なら閉じません。もう一度 Ctrl+C を押すと、また確認を出します）。メッセージボックスやファイル選択が開いている間は、それを閉じるまで待ちます。ランチャー（`chatgpt-project-bridge-gui.cmd`）から起動したときは、画面が閉じたあとに cmd が「バッチ ジョブを終了しますか (Y/N)?」と聞きます（どちらを答えても終わります）。
- **残ったか確かめる方法**: 画面を開き直し、「かんたん」タブの「ハブの稼働状態」で確かめます。動いていれば「ハブを停止」を押します。Ubuntu 版の「かんたん」タブの上部にも、同じ案内が出ます。

### 読み取り専用の確認

「ハブの稼働状態」「登録一覧を表示」「権限を確認」「稼働状態を表示」（従来方式）は、何も書き換えません。ハブや Tunnel を起動している間も実行できます。「公開範囲を確認」は、公開範囲・指紋・承認状態・前回の承認からの変更点を表示するだけで、承認を保存しません。出力の JSON には、承認ファイルに記録されたプロジェクトルート `approvedProjectRoot` も含まれます（承認ファイルが無い・壊れている・文字列でないときは `null`）。画面は、承認状態が「変更あり」でこの値が今のフォルダーと違うときに、別のフォルダーの承認を上書きする警告を出します。この欄が無い古いコマンドでは、`null` と同じに扱います。

### 上書き系のチェック

「上書きを許可（force）」「プロファイルを作り直す」「キーを置き換える」は、既定でオフです。オンにするたびに確認ダイアログが出ます（既定のボタンは「キャンセル」で、「それでも有効にする」を押したときだけ有効になります）。この設定は保存されません。

### 確認の 5 段階

ChatGPT から読めるまでの確認は、次の 5 段階に分かれています。1 つの成功表示で、全部が済んだことにはなりません。

1. 足場の作成: 設定ファイルと文書 2 つがある。
2. 自己試験: 「自己試験」で確かめる（「プロジェクトを追加」の途中でも実行されます）。
3. Tunnel Client の稼働: 「ハブの稼働状態」（従来方式は「稼働状態を表示」）で確かめる。プロセスが動いているかだけなら、画面の上部の「ハブ」の表示でも分かります（OpenAI とつながっているかは「ハブの稼働状態」で確かめます）。
4. ChatGPT のツール検出: この画面からは確かめられません。ChatGPT 側で確かめます。
5. 実際のツール呼び出し: この画面からは確かめられません。新しいチャットで `list_projects` などを呼んで確かめます。

画面の「CLI の処理は成功しました」は、コマンドの終了コードが 0 だったことを表すだけです。ChatGPT からの呼び出しの確認は別の段階です。

### 困ったとき

- メニューから起動しても何も出ない（Ubuntu）: 端末で `chatgpt-project-bridge-gui` を実行すると、理由が表示されます。`python3-gi と gir1.2-gtk-3.0 が必要です` と出たら、`sudo apt install python3-gi gir1.2-gtk-3.0` を実行します。SSH 接続だけの端末など、デスクトップのセッションが無い場所では開けません。
- キー入力用の端末が開かない（Ubuntu）: 画面が端末を探します（`x-terminal-emulator`、`gnome-terminal`、`ptyxis`、`konsole`、`xfce4-terminal`、`xterm` の順）。`PATH` の絶対パスの要素だけを探し、`x-terminal-emulator` は、実体が既知の端末（`gnome-terminal`・`konsole`・`xfce4-terminal`・`xterm`・`ptyxis` など）のときだけ使います。見つからないときは「端末が見つかりません」と表示され、実行するコマンドが出ます。「コマンドをコピー」を押して、端末に貼り付けて実行してください。キーはその端末に入力します。
- 「公開範囲を確認できなかったため、中止しました」と出た: 公開範囲の確認（`show-exposure`）には、設定ファイルがあること（初期化済み）と Node.js 18 以上が必要です。原因は出力ログ欄に出ます。ログに「公開範囲の設定に使えない文字が含まれています: 項目名 = "値"」と出ているときは、次の項目へ進みます。
- 承認ダイアログに「承認できません」（赤字）と出た、またはログに「公開範囲の設定に使えない文字が含まれています」と出た: 設定ファイル（`.chatgpt-project-bridge.json`）の項目か、プロジェクトのフォルダーのパスに、使えない文字（制御文字・行区切り・双方向制御文字・不可視文字。書式文字を含む名前も同じです）があります。パスの項目では、区切りごとの末尾の `.` と空白、`:` も同じ扱いです（Windows ではさらに、`~` と数字を含む名前（8.3 短縮名）も）。メッセージの「項目名 = "値"」で、どの項目かが分かります（見えない文字は `\uXXXX` の形で見えます）。ファイルやフォルダーの名前を変え、設定を直してから、もう一度実行してください。この表示を回避して承認する方法はありません。心当たりのない文字が入っていたら、そのプロジェクトを疑い、承認しないでください。詳しくは「安全のしくみと注意」の「設定に使えない文字」にあります。
- Git の情報（ブランチ・変更の件数・コミット件名）が出ない: ChatGPT の応答、または「状態文書を更新」の出力に、「Git の情報を取得しません: .git/config に実行を伴いうる設定があります: キー名」と出ています。プロジェクトの `.git/config` に、プログラムを実行しうる設定があるためです。文書の公開は止まりません。`.git/config`（`.git` がファイルのときは、その中の `gitdir:` が指す場所の設定）をテキストエディターで開き、そのキーに心当たりがなければ消します。直すと、次の呼び出し（「状態文書を更新」も）から元に戻ります。詳しくは「安全のしくみと注意」の「Git 情報の取得を止める条件」にあります。
- 画面を異常終了したあと、ハブが動いたままになっている: 画面を開き直し、上部の「ハブ」の表示（または「ハブの稼働状態」）で確かめ、動いていれば「ハブを停止」を押します（上の「画面が異常終了したとき」）。
- Windows 版が正しく動くかは、実機で確認するまで分かりません。動作がおかしいときは、`gui-windows-check.md` の項目番号と、画面下部の「コピー」で取ったログを添えて報告してください。

## 公開範囲の承認

公開範囲の設定（`.chatgpt-project-bridge.json`）はプロジェクト内にありますが、承認はプロジェクトの外に保存します。

- Windows: `%APPDATA%\chatgpt-project-bridge\approvals\<profile>.json`
- Ubuntu: `${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-project-bridge/approvals/<profile>.json`（`0600`）

MCPサーバーは、現在の公開範囲の指紋が承認と一致しない限り、ChatGPTからのツール呼び出しをすべて拒否します。`git pull` などで設定が変わった場合も、承認し直すまで公開されません。

- `Start` / `start` は起動前に承認を確認し、変わっていれば前回からの変更点を表示して承認を求めます。
- `Doctor` / `doctor` は承認状態を表示します（承認は求めません）。
- 設定を変えた後に明示的に承認する場合は `Approve` / `approve` を使います。

この仕組みは、同じユーザー権限で動いているソフトウェアによる承認ファイルの書き換えまでは防げません。

承認ファイルが他のユーザーに書き込める状態のときや、シンボリックリンクのときなどは、未承認として扱います（「安全のしくみと注意」の「承認ファイルの権限」）。

## Gitの公開設定

既定では、Gitのファイル名とコミット件名をChatGPTへ渡しません。件数、ブランチ名、HEADのハッシュと日時だけを返します。

```json
"gitExposure": { "paths": false, "commitSubjects": false }
```

- `paths`: 変更中・未追跡のファイル名とサブモジュールのパス。`true` にしても、`denyDirectories` 配下と機微な名前（`.env*`、鍵ファイルなど）は返しません。
- `commitSubjects`: HEADと直近コミットの件名。

状態文書のAUTO Gitブロック（`Update` / `update`）も同じ設定に従います。変更したら承認し直してください。

## 詳細取得ツールの公開設定（2.5.0 以降）

2.5.0 で、Git の詳細とプロジェクトの分析を返すツールを 10 個追加しました（一覧と使い方は [README](../README.ja.md)）。これらは、文書の公開許可（`allowFiles` など）と `gitExposure` を超えて情報を返しません。それに加えて、次の設定で **個別に** 許可したときだけ、対応する情報を返します。**既定はすべて非公開**で、キーが無ければ非公開です。

```json
"detailExposure": { "branchNames": false, "diffExcerpts": false, "sourceText": false }
```

| キー | 許可すると返すもの | あわせて必要な設定 |
|---|---|---|
| `branchNames` | 現在以外のブランチ名の一覧、`get_branch_details`・`compare_branches` の利用 | ファイル名は `gitExposure.paths`、コミット件名は `gitExposure.commitSubjects` |
| `diffExcerpts` | `get_worktree_details` の差分の抜粋（1 ファイル 40 行まで・最大 20 ファイル・合計 64 KiB まで。バイナリと秘密値は出さない） | `gitExposure.paths` |
| `sourceText` | 文書の許可リストに無いファイルの本文の分析（`package.json` などの設定、ソースの TODO / FIXME、テスト結果の記録） | ファイル名を根拠に出すには `gitExposure.paths` |

- 許可していない項目は、応答の `meta.hidden` に項目名を載せ、`meta.status` を `partial` にします。件数・言語別のファイル数・現在のブランチ名・HEAD のハッシュと日時は、許可がなくても返します（現在のブランチ名と HEAD は 2.4.x までも返していました）。
- `denyDirectories` 配下、機微な名前（`.env*`、鍵ファイル、名前に `credential` / `secret` を含むもの）、`.git` などは、許可しても返しません。リンク・hardlink・別マウント・バイナリ・256 KiB を超える部分も読みません。
- **既存の承認は、この版へ上げても無効になりません。** `detailExposure` が無い（またはすべて `false` の）設定は、2.4.x と同じ指紋になります。1 つでも `true` にすると指紋が変わり、承認し直すまですべてのツールが応答しなくなります。
- 承認の画面（CLI は「詳細取得ツール: …」の行、GUI は「その他の項目」）に、許可した内容が出ます。承認の前に確認してください。
- この設定は、ChatGPT へ渡るブランチ名・差分・ソースの本文を増やします。公開してよいかをプロジェクトごとに判断してください。設定の編集は手作業です（管理画面にはまだ項目がありません）。

## ソース読み取りツールの公開設定（2.6.0 以降）

2.6.0 で、ソースコード・設定・文書・Git の差分・テストログを検索して必要な範囲だけ読むツールを 6 個追加しました（`list_source_files`・`search_code`・`read_source`・`find_references`・`get_git_diff`・`read_test_log`。一覧と使い方は [README](../README.ja.md)）。**すべて読み取り専用で、ChatGPT からファイルを書き換えること・コマンドを実行することはできません**（例外は、下の「Claude Code のジョブの設定」で有効にしたプロジェクトだけです）。

**新しい権限のキーはありません。** 上の詳細取得ツールと同じ設定を使います。

| ツール | 必要な設定（すべて `true`） |
|---|---|
| `list_source_files`・`search_code`・`read_source`・`find_references` | `detailExposure.sourceText` と `gitExposure.paths` |
| `get_git_diff` | 上に加えて `detailExposure.diffExcerpts`。ブランチ名で指定するときは `detailExposure.branchNames` も（コミットの SHA 指定は不要） |
| `read_test_log` | 上の `sourceText` と `paths` に加えて、次の `sourceScope.logDirectories` に読む場所を明示 |

> **注意: 2.6.0 を導入して ChatGPT で「ツールを更新」すると、`sourceText` と `gitExposure.paths` を許可済みのプロジェクトでは、承認し直さなくても、ソース全体を検索・読み取りできるようになります。** 既存の承認は有効なままです。これは、新しい権限を足さず既存の設定を使う設計のためです。止めたいプロジェクトは `detailExposure.sourceText` を `false` にして承認し直してください（`gitExposure.paths` を `false` にしても止まります）。

### 範囲を広げる設定 `sourceScope`（任意）

標準では、生成物・依存・キャッシュ・同梱した第三者のコード（`node_modules`・`build`・`bin`・`obj`・`dist`・`out`・`.venv`・`vendor`・`third_party`・`godot-cpp`・`Saved`・`Logs`・`.godot` など）は、一覧・検索の対象にも、`read_source` の対象にもしません。調べたい第三者のコードや、ログの場所があるときだけ、次の設定を足します。**どちらも「広げる」設定なので、足すと承認の指紋が変わり、承認し直すまでそのプロジェクトは応答しません**（足さない設定の指紋は 2.5.0 と同じで、既存の承認は有効なままです）。

```json
"sourceScope": {
  "additionalDirectories": ["game/addons/my_addon/third_party/clipper"],
  "logDirectories": [{ "path": "Saved/Logs/tests", "recursive": true }]
}
```

- `additionalDirectories`: 上の標準の除外に当たるディレクトリを、明示的に開けます。ツールの `scope: "extended"` のときだけ、この配下が一覧・検索の対象になります（`read_source` は配下のファイルを直接読めます）。指定したディレクトリの中の、さらに別の除外ディレクトリ（`build` など）は開きません。
- `logDirectories`: `read_test_log` が読んでよい場所です。`recursive: true` で配下も、`false` で直下のファイルだけです。**これを設定しないと `read_test_log` は使えません**（ログ専用の明示許可）。標準の除外（`Saved`・`Logs` など）は、ここで明示した場所には掛けません。
- **`denyDirectories` が常に優先されます。** `additionalDirectories` と `logDirectories` に書いても、`denyDirectories` の配下は読めません。たとえば `denyDirectories` に `Saved` があると、`Saved/Logs/tests` は読めません（`read_test_log` の `directories` が `status: "denied"` を返します）。ログを読むには、`denyDirectories` の `Saved` を、読ませたくない場所だけを指す指定（`Saved/CodexAgents` など）に直してから承認し直してください。
- 設定の形が不正（配列でない、パスが文字列でない、使えない文字を含む）なときは、一部だけを捨てず、設定全体を使いません（単一モードは起動に失敗し、ハブではそのプロジェクトだけが応答しません）。
- 承認の画面（CLI・GUI）に、`sourceScope` の内容が出ます。承認の前に確認してください。

### 常に読まないもの（新ツール）

次は、設定にかかわらず、一覧・検索・読み取り・差分のどれにも出しません。

- `denyDirectories` の配下、`.git`、`.ssh`、`.aws`、`.azure`、`.gnupg`、`.kube`、この橋渡し自身の設定ファイル（`.chatgpt-project-bridge.json`）
- `knowledge/00-system/`・`knowledge/20-bronze/`・`knowledge/30-gold/`、`Prompts/Prompt.txt`
- 名前: `.env*`、鍵ファイル（`*.pem`・`*.key`・`*.pfx`・`*.p12`・`*.ppk`・`id_*`）、`credential` / `secret` を含む名前、`secrets/` 配下、`.envrc`、`.htpasswd`、`.pgpass`、`*.tfstate`・`*.tfvars`・`*.p8`・`*.keystore`・`*.jks`・`*.ovpn`・`*.dpapi`・`*.gpg`、`.mcp.json`、`settings.local.json`、`authorized_keys`・`known_hosts`
- 本文が秘密らしいファイル: PEM の秘密鍵を先頭 64 KiB に含むファイル、`KEY=値` 形式の秘密らしい行（値が 8 文字以上）が 3 行以上あるファイル（プログラムのソースは、値が引用符で囲まれた行だけを数える）
- バイナリ（拡張子がソースでも、本文に NUL・既知のバイナリの署名・制御文字が多いものは返さない）、リンク・junction・hardlink・別マウント経由のファイル

読んでよいファイルの本文は、行ごとに秘密値（トークン・パスワード・秘密鍵のブロックなど）、メールアドレス、ユーザーフォルダー名（`C:\Users\<名前>`・`/home/<名前>`）を伏せてから、照合・返却します。伏せた値は検索の照合にも使えないので、値を当てずっぽうに探る使い方はできません。ただし、伏せ方は完全ではありません（README.ja.md の「公開権限」）。

### 文字コード

BOM 付き UTF-8・BOM 付き UTF-16（LE/BE）・BOM なしの UTF-8 を読めます。BOM がなく UTF-8 として復号できないファイル（Shift_JIS など）は、文字化けした本文を返さず `unsupported_encoding` を返し、検索ではスキップした件数を示します。`read_source` の `encoding`（`shift_jis`・`euc-jp`・`utf-16le`・`utf-16be`・`windows-1252`）を明示したときだけ、その指定で読みます（自動判定ではないことを警告に出します）。

## Claude Code のジョブの設定（2.7.0 以降）

2.7.0 で、ChatGPT からこの PC の Claude Code を起動するツールを 5 個追加しました（`start_claude_job`・`get_claude_job`・`read_claude_job_log`・`cancel_claude_job`・`list_claude_jobs`。仕組みと残るリスクは [README](../README.ja.md) の「2.7.0 で追加した Claude Code のジョブ」）。**読み取り専用ではない、強い権限です。** 既定では使えず、プロジェクトごとに利用者が有効にして承認したときだけ使えます。

1. この PC に Claude Code（ネイティブ版）が入っていて、利用者がログインしていることを確かめます（Windows は `%USERPROFILE%\.local\bin\claude.exe`、Ubuntu は `~/.local/bin/claude`。`claude --version`）。
2. プロジェクトの `.chatgpt-project-bridge.json` に `claudeCode` を足します。

   ```json
   "claudeCode": {
     "enabled": true,
     "allowedCommands": ["node scripts/*-selftest.mjs", "git status", "git diff *"],
     "model": "sonnet",
     "maxMinutes": 30
   }
   ```

   - `allowedCommands` は、Claude Code に確認なしで実行させてよいコマンドです（`*` は任意の文字列）。書かなければ、Claude Code はファイルの編集だけを行います。シェル（`bash`・`pwsh`・`cmd` など）・通信（`curl`・`ssh` など）・`npx`・`claude`・git の書き込み系（`commit`・`push`・`reset` など）は書けません（書くと設定全体が無効になります）。
   - **許可したコマンドがプロジェクトの中のスクリプトを実行するなら、Claude Code はそのスクリプトを書き換えてから実行できます（実質的に任意のコードの実行）。** 許可するコマンドは最小限にしてください。
   - `model`・`effort` を省くと、Claude Code の既定（利用者の設定の `model`）で動きます。上位のモデルほど利用枠を多く消費します。ここに書くのはプロジェクトの既定で、2.10.0 以降は、ChatGPT が `start_claude_job` の引数 `model`・`effort` でジョブごとに上書きできます（引数で渡せる値はコードで固定しているので、この設定に項目を足す必要も、再承認も要りません。`sonnet[1m]` のような添え字つきの名前は、ここでだけ書けます）。
3. 指紋を出して承認し直します（Windows は `project-bridge.ps1 -Action Approve -ExposureSha256 <sha256>`、Ubuntu は `project-bridge.py approve --exposure-sha256 <sha256>`。`sha256` は `server.mjs --print-exposure` の出力）。承認の画面（CLI・GUI）に、許可するコマンドの一覧と警告が出ます。
4. ChatGPT で「ツールを更新」を行います（2.7.0・2.9.0・2.10.0 を導入した直後。両方のプラグインで。2.10.0 は `start_claude_job` に `model`・`effort` の引数を足したので、行わないと ChatGPT はモデルを指定できません）。

管理画面の「かんたん」タブの一覧で、On / Off を切り替えられます（上の「権限の切り替え」。許可コマンドの編集を除く）。コマンドで行うときは、`SetPermission`（Ubuntu は `set-permission`）を使います。指紋なしで実行すると、変更後の公開範囲を表示するだけで何も書かず、`-ExposureSha256`（`--exposure-sha256`）にその指紋を付けて実行すると、設定の変更と承認が 1 つの操作で行われます。

```powershell
# Windows: 確認だけ（何も書かない）。許可コマンドは 1 つの値に改行で区切って渡せる。
& "$env:USERPROFILE\.codex\skills\chatgpt-project-bridge\scripts\project-bridge.ps1" -Action SetPermission -ProjectRoot E:\work\Example -ClaudeCode on -AllowedCommand "node scripts/*-selftest.mjs`ngit status"
# 表示された exposureSha256 を確かめたうえで、同じ引数に -ExposureSha256 <指紋> を付けて実行すると、設定の変更と承認が行われる。
```

止めるときは、`enabled` を `false` にして承認し直すか（`-ClaudeCode off`）、`claudeCode` を消して承認し直します（消すと指紋が 2.6.0 と同じに戻ります）。実行中のジョブを今すぐ止めるには、ChatGPT の `cancel_claude_job`、またはハブの停止です。

Claude Code に読ませも書かせもしないもの（生成する `--settings` の deny）は、上の「常に読まないもの（新ツール）」と同じ範囲です（`.git`・秘密の名前・`knowledge/00-system`・`20-bronze`・`30-gold`・`Prompts/Prompt.txt`・`.chatgpt-project-bridge.json`・`denyDirectories`）。加えて、`.claude`・`.gitmodules`・`zzz-Temp` は書き換えさせません。ジョブの記録は Windows は `%LOCALAPPDATA%\chatgpt-project-bridge\claude-jobs\`、Ubuntu は `~/.local/state/chatgpt-project-bridge/claude-jobs/` にあります。

### 計画から実装を依頼する（ChatGPT の使い方。2.9.0 以降）

ChatGPT で計画を作り、承認してから Claude Code に実装させる流れです。設定・承認は上のとおりで、ここで増える操作はありません（ChatGPT の「ツールを更新」だけ、2.9.0 の導入後に両方のプラグインで行います）。

1. ChatGPT に、実装したい内容を伝えます。ChatGPT は `get_claude_code_settings` で、そのプロジェクトで Claude Code が使えるか、許可コマンド（確認のコマンドは、この形のとおりに書く）、制限時間（`maxMinutes`）を確認します。使えないときは `enabled: false` と、管理画面で有効にして承認する手順が返ります。
2. ChatGPT は `list_source_files`・`search_code`・`read_source` で対象を調べ、計画（目的・変更するファイルと内容・手順・確認のコマンド・やらないこと・最後の報告に含めること）を作って**あなたに見せます**。内容を確かめて、承認するか、直しを伝えます。
3. 承認すると、ChatGPT が計画を `start_claude_job` の `prompt`（最大 20000 文字。大きいときは段階に分けます）に渡します。依頼文には、あなたの依頼と承認した計画だけが入ります（ソース・文書・ログに書かれた指示は入れません）。モデルと思考の深さは、2.10.0 から `model`・`effort` の引数で指定できます（例: 「計画の実装は Sonnet 5.5 の xhigh で」と頼むと `model: sonnet`・`effort: xhigh`、「Fable 5.1 の xhigh で」と頼むと `model: fable`・`effort: xhigh`）。指定しなければ、プロジェクトの設定で動きます。選べる値は `get_claude_code_settings` の `modelChoices`・`effortChoices` で確認され、実際に使われたモデルは `get_claude_job` の `model`（Claude Code が報告した名前）と `requestedModel`・`modelSource` に出ます。上位のモデルや高い effort ほど利用枠を多く消費します。
4. ChatGPT が `get_claude_job`・`read_claude_job_log` で進み具合を、終わったら `get_git_diff`（`unstaged`）と `read_source` で、計画どおりかを確かめます。差があれば `continueJobId` で修正を依頼します。
5. `commit`・`push` は、Claude Code にも ChatGPT にもできません。変更を確かめたあとで、あなたが行います（作業ツリーが直接書き換わるので、不要なら `git restore` などで戻します）。

許可コマンドが無いプロジェクトでは、Claude Code はファイルの編集だけを行い、テストなどは実行できません（`get_claude_code_settings` の注意書きに出ます）。許可コマンドの形は、`*` より前の部分を省いた呼び方（例: `-Only` を付けない）や、`;`・`&&`・`|`・`$()` で別のコマンドをつないだ形は拒否されます（2026-10-25 に本物の Claude Code で確かめました）。

## 常に公開しないもの

許可リストに入れても、次は公開しません。

- 名前: `.env*`、`*.pem`、`*.key`、`*.pfx`、`*.p12`、`*.ppk`、`id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`、`*.kdbx`、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`、名前に `credential` / `secret` を含むもの
- ディレクトリ: `.git`、`.ssh`、`.aws`、`.azure`、`.gnupg`、`.kube` の配下
- NULバイトを含むファイル（バイナリ）

公開した文書の中の秘密情報（秘密鍵のブロック、GitHub・GitLab・npm・Stripe・Google・Slack などのトークンと Webhook URL、AWS のキー、JWT、`Authorization: Basic …`、URL内のパスワード、`password: …` や `access_key: …` などの値）は伏せ字にしますが、これは最後の防御です。秘密情報を公開文書に書かないでください。

## 安全のしくみと注意

承認の表示の偽装、名前の正規化による機微な名前の拒否の回避、プロジェクトの `.git` に仕込まれた設定の実行を防ぐしくみです。ここに書いたことは、コードを読んで確かめたものです。Windows 版の画面と別のコンソール窓は、実機では未確認です。

### 設定に使えない文字

次の項目に使えない文字があると、**設定全体を不正として拒否します**（1 件だけ黙って捨てると、公開範囲が意図せず変わるためです）。MCP サーバー（`--print-exposure`・通常の起動・ハブの各プロジェクトの読み込み）とコマンドは設定全体を拒否し、画面は承認を止めます。ハブでは、そのプロジェクトだけが公開されず、ほかのプロジェクトとハブは動き続けます。

- 使えない文字: 制御文字（C0・DEL・C1 制御）、書式文字（ゼロ幅文字・双方向制御文字・BOM・タグ文字など）、行区切りと段落区切り（U+2028・U+2029）、対にならないサロゲート。対象は、`projectName`・`contextFile`・`statusFile`・`allowFiles`・`allowDirectories` の `path`・`denyDirectories`・プロジェクトのフォルダーのパスです。ペルシャ語の ZWNJ（U+200C）のように、言語の表記に使う書式文字を含む名前も、同じく拒否します。その名前が必要なときは、ファイルやフォルダーの名前を変えてください。
- 使えない名前: パスの項目（`contextFile`・`statusFile`・`allowFiles`・`allowDirectories` の `path`・`denyDirectories`）の、区切りごとの名前が、末尾が `.` か空白のもの、`:` を含むもの。Windows では、`~` と数字を含む名前（8.3 短縮名）も拒否します。Windows が名前を正規化したり（末尾の `.` や空白を無視する）、代替データストリーム（`:`）や 8.3 短縮名で別の名前として開いたりして、機微な名前の拒否（`.env*` など）をすり抜けるのを防ぐためです。
- 許可ディレクトリの中で見つけた Markdown の名前が同じ条件に当たるときは、設定の不正にはせず、その文書だけを公開しません。
- 承認ダイアログに出す値の偽装（改行で偽の行を作る、右から左への上書きで順序を変える、など）を防ぐ目的もあります。承認の画面では、見えない文字を `\uXXXX` の形で見えるようにし、設定にそれがあれば承認できません。

拒否のメッセージは「公開範囲の設定に使えない文字が含まれています: 項目名[番号] = "値"」の形で、見えない文字は `\uXXXX` の形で見えます。

### リンク・一覧の上限・機微な名前のディレクトリ（2.4.0 以降）

- プロジェクト内のシンボリックリンク（symlink）とジャンクション（junction）は、ファイルでもディレクトリでも公開できません。途中のディレクトリがリンクのときも拒否し、メッセージは「途中のディレクトリを含め、リンクされた公開パスは使用できません: <プロジェクト内の相対パス>」の形です（絶対パスは出しません）。2.3.0 では、プロジェクト内を指すディレクトリのリンクは通っていました。公開したい内容は、リンクではなく実体のフォルダーに置いてください。
- 一覧が上限（文書 1000 件、走査 10000 エントリー）で途中までのとき、`list_documents` は `truncated`・`limits`・`truncatedBy`（`documents` か `directoryEntries`）と日本語の `notice` を返します。何を列挙するかは従来と同じで、通知が加わるだけです。通知が無いときの応答は従来と同じ形です（単一モードは文書の配列、ハブは `{ project, items }`）。通知があるときは、単一モードでは配列が `documents` に入ります。
- 機微な名前のディレクトリ（`.git`・`.ssh`・`.aws` など、名前に `secret` / `credential` を含むものを含む）は、一覧に出ず、中も列挙しません。除外したディレクトリは `skippedSensitiveDirectories`（最大 20 件）と `notice` で知らせます。個別の取得（`get_document`）は、これまでどおり許可設定と機微な名前の規則に従います（機微な名前の配下は取得できません）。

### Git 情報の取得を止める条件

Git の情報（ブランチ・変更の件数・コミット件名）を集める前に、`git config --list --show-scope -z` で設定を**読むだけ**で確かめます（何も実行しません）。プロジェクトの `.git` の `local` または `worktree` の設定に、プログラムを実行しうるキーがあると、`git status`・`log`・`diff` を実行せず、**Git の情報を取得しません**。文書の公開は止めません。`global` と `system` の設定は、確かめる対象ではありません。

止めるキー（大文字小文字は区別しません）:

- `core.fsmonitor`・`core.hooksPath`・`core.sshCommand`・`core.pager`・`core.editor`・`core.askpass`・`core.gitProxy`・`core.alternateRefsCommand`・`core.worktree`
- `filter.*`・`diff.*`・`merge.*` の、コマンドを指定するキー（`clean`・`smudge`・`process`・`command`・`textconv`・`driver`・`cachetextconv`）と、`diff.external`
- `alias.`・`include.`・`includeif.`・`url.`・`credential.`・`protocol.`・`gpg.`・`http.`・`sendemail.`・`uploadpack.`・`receive.` で始まるキー
- `submodule.<名前>.update`、`remote.<名前>.receivepack`・`uploadpack`・`vcs`・`proxy`

例外（止めません）:

- Git LFS が書く標準の設定値。`filter.lfs.clean` が `git-lfs clean -- %f`、`filter.lfs.smudge` が `git-lfs smudge -- %f` か `git-lfs smudge --skip -- %f`、`filter.lfs.process` が `git-lfs filter-process` か `git-lfs filter-process --skip` のとき（値が完全に一致したときだけ）。
- サブモジュールのデータ用のキー（`submodule.<名前>.url` など）。止めるのは `submodule.<名前>.update` だけです。

止めたときは、「Git の情報を取得しません: .git/config に実行を伴いうる設定があります: キー名」を、ChatGPT への応答（`get_project_status`・`get_recent_changes` の `gitUnavailableReason`）と、コマンドの警告（「状態文書を更新」）に出します。出すのは**キー名だけ**で、値は出しません（MCP サーバーは、`url.*.insteadof` のように、URL や名前を含みうる中間の部分を `*` で伏せます）。Git の設定を読めなかったときも、同じ書き出しで止めます。直し方は、`.git/config` を見直して、そのキーを消すことです（「困ったとき」を参照）。

Git の呼び出しには、いつも `-c core.fsmonitor=false` と `--no-optional-locks` を付け、`GIT_TERMINAL_PROMPT=0` を設定します。`log` には `--no-ext-diff --no-textconv` も付けます。

**信頼できない（インターネットから入手した、他人から受け取った）プロジェクトには注意してください。** `.git` ごと配られたプロジェクトは、`.git/config` に実行される設定が仕込まれている疑いがあります。この確認は、その被害を減らすためのものです。止まったときは、設定を緩めずに、`.git/config` の中身を確かめてください。

### 承認ファイルの権限

承認ファイルが次のどれかに当たるときは、**未承認として扱います**。MCP サーバーは、すべてのツール呼び出しを拒否し、理由（場所と内容は出しません）を返します。

- シンボリックリンクである、通常のファイルではない
- 所有者が自分ではない
- 所有者以外（group・other）に書き込み権がある
- 置き場所のディレクトリの所有者が自分ではない、または group・other に書き込み権がある

直し方の例は、ファイルを `chmod 600`、ディレクトリを `chmod 700` にすることです（Linux・macOS 相当の検査です）。Windows は、シンボリックリンクの拒否だけを行い、ACL は検査しません（未対応）。

Ubuntu のコマンド（`chatgpt-project-bridge`）も同じ検査をします。承認ファイルの所有者・権限・種類に問題があるときは未承認として扱い、シンボリックリンクはエラーで止まります。「公開範囲を確認」（`show-exposure`）は、承認ディレクトリの所有者・権限に問題があるときにエラーで止まります。Windows のコマンドは、承認ファイルまたはその保存フォルダーが再解析ポイント（シンボリックリンクやジャンクション）のときに、エラーで止まります。

### インストーラーの安全策（Ubuntu）

- インストーラーが実行する Python（ロックの読み取り・Tunnel Client の展開・Skill の導入）は、`python3 -I` で実行します。実行したフォルダー（Bundle フォルダー）に置かれた `json.py` などの偽のモジュールと、`PYTHON*` 環境変数を読みません。
- アプリメニューの項目（`.desktop`）は、置き場（`applications` フォルダー）か項目のファイルが symlink のときは作らず、警告（`WARN`）を出して、導入の残りを続けます（リンク先へ書かないためです）。`XDG_DATA_HOME` が相対パスのときは無視し、`~/.local/share` を使います。
- 管理画面に必要な `python3-gi` と `gir1.2-gtk-3.0` が無いときは、警告を出すだけで、自動では入れません。

### 公開範囲の出力の大きさ

公開範囲が大きくても（数千件の公開ファイルなど）、`--print-exposure` と `show-exposure` は全量を返します。以前は出力が 64 KiB で切れ、JSON として読めずに、ハブが起動できなくなる場合がありました。

### 信頼できないプロジェクトを追加・承認するとき

他人から受け取った、またはインターネットから入手したプロジェクトを追加・承認するときは、次を守ってください。

- 承認ダイアログを、末尾まで読みます。公開ファイル・公開ディレクトリ・拒否ディレクトリに、心当たりのない項目がないかを確かめます。
- 赤字の警告（「承認できません」、別のフォルダーの承認の上書き）が出たら、承認しません。
- `.git` ごと配られたものを疑います。Git の情報の取得が止まる表示が出たら、`.git/config` を確かめます。
- Git のファイル名やコミット件名が「公開」（赤の太字）になっていないかを確かめます。

## 手動管理コマンド

Windows:

```powershell
chatgpt-project-bridge -Action Update  -ProjectRoot 'E:\work\MyProject'
chatgpt-project-bridge -Action Approve -ProjectRoot 'E:\work\MyProject'
chatgpt-project-bridge -Action Doctor  -ProjectRoot 'E:\work\MyProject'
chatgpt-project-bridge -Action Start   -ProjectRoot 'E:\work\MyProject'
```

Ubuntu:

```bash
chatgpt-project-bridge update  --project-root "$HOME/work/MyProject"
chatgpt-project-bridge approve --project-root "$HOME/work/MyProject"
chatgpt-project-bridge doctor  --project-root "$HOME/work/MyProject"
chatgpt-project-bridge start   --project-root "$HOME/work/MyProject"
```

`SaveKey` / `save-key`は既存keyを上書きしません。意図的な交換時だけ`ReplaceKey` / `--replace-key`を指定します。`ConfigureTunnel` / `configure-tunnel`も既存configと異なるTunnel、または別rootを参照するprofileを既定で拒否します。

## 2.0.0からの移行

2.0.0で作ったTunnel profileは、MCPサーバーへ承認ファイルを渡さないため拒否されます。プロジェクトごとに一度だけ、同じTunnel IDで次を実行してprofileを再生成し、公開範囲を承認してください。

```powershell
chatgpt-project-add -ProjectRoot 'E:\work\MyProject' -TunnelId 'tunnel_...' -ForceReconfigure
```

```bash
chatgpt-project-add --project-root "$HOME/work/MyProject" --tunnel-id tunnel_... --force-reconfigure
```

## Bundle作成（保守者向け）

依存物の版を上げるときは、Skillのソース上で先にロックを更新し、表示された版とハッシュの差分を確認してからコミットします。

```powershell
& .\scripts\project-bridge.ps1 -Action UpdateLock
& .\scripts\project-bridge.ps1 -Action UpdateLock -TunnelClientVersion v0.0.15 -NodeVersion v24.19.0
```

```bash
./scripts/project-bridge.sh update-lock
```

`UpdateLock` は、Tunnel Clientの3アセット（Windows amd64、Linux amd64 / arm64）とNode.jsの2アセット（Linux x64 / arm64）を実際にダウンロードし、公開されたSHA-256と一致したものだけをロックに書きます。Windowsではwingetに固定版があることも確認します。

Tunnel Clientは、さらにリリースに付いているSLSA来歴証明（`tunnel-client-<版>-provenance.sigstore.json`）を GitHub CLI の `gh attestation verify` で検証します。3アセットとも、次の条件をすべて満たさなければロックを書きません。

- リポジトリ `openai/tunnel-client` のワークフロー `.github/workflows/release.yml` が署名した
- ビルド元がそのタグ（`refs/tags/<版>`）と、タグが指すコミットである
- 証明の種類が SLSA provenance v1 である

検証条件、来歴証明のSHA-256、使った `gh` の版はロックの `tunnelClient.provenance` に記録されます。`gh` が見つからない場合や検証に失敗した場合は、必ず止まります（省略するオプションはありません）。

`gh` は保守者のPCにだけ必要で、導入先には不要です。Windowsではユーザー領域に置きます（PATHは変えません。`UpdateLock` は `%LOCALAPPDATA%\Programs\gh\bin\gh.exe` を探します。別の場所なら `-GhPath` で指定します）。

```powershell
$ghVersion = '2.102.0'
$ghRoot = "$env:LOCALAPPDATA\Programs\gh"
$download = Join-Path $env:TEMP "gh_$ghVersion"
New-Item -ItemType Directory -Force $download | Out-Null
Invoke-WebRequest -UseBasicParsing "https://github.com/cli/cli/releases/download/v$ghVersion/gh_${ghVersion}_windows_amd64.zip" -OutFile "$download\gh.zip"
Invoke-WebRequest -UseBasicParsing "https://github.com/cli/cli/releases/download/v$ghVersion/gh_${ghVersion}_checksums.txt" -OutFile "$download\checksums.txt"
$expected = ((Get-Content "$download\checksums.txt" | Where-Object { $_ -match "  gh_${ghVersion}_windows_amd64\.zip$" }) -split '\s+')[0]
if ((Get-FileHash "$download\gh.zip" -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'ハッシュが一致しません。' }
Expand-Archive "$download\gh.zip" -DestinationPath $ghRoot -Force
```

`$expected` は、GitHubのリリースページでアセットの横に表示されるSHA-256とも比べてください。Ubuntuでは、同じリリースの `gh_<版>_linux_amd64.tar.gz` を同じ手順で照合し、中の `bin/gh` を `~/.local/bin` に置きます（`update-lock` は PATH と `~/.local/bin/gh` を探します。別の場所なら `--gh-path` で指定します）。

Node.jsは、wingetに登録済みの版を選んでください。nodejs.orgの最新LTSは、wingetへの登録が遅れることがあります。wingetの無いPCで `UpdateLock` を実行した場合は確認が行われないため、次のページで版のフォルダーがあることを確かめてから固定します。

```text
https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS
```

WindowsとUbuntuの両フォルダーを一度に作ります。署名する場合はSSH秘密鍵を指定します。

```powershell
chatgpt-project-bridge -Action ExportBundle -OutputPath 'D:\Transfer\ChatGPT' -Force -SigningKey "$env:USERPROFILE\.ssh\id_ed25519"
```

```bash
chatgpt-project-bridge export-bundle --output-path "$HOME/Transfer/ChatGPT" --force --signing-key "$HOME/.ssh/id_ed25519"
```

- `SHA256SUMS.txt` には、archive、installer、`VERSION.txt` のSHA-256が入ります。
- `-SigningKey` を指定すると `ssh-keygen -Y sign`（名前空間 `chatgpt-project-bridge-bundle`）で `SHA256SUMS.txt.sig` を作ります。
- 最後に各OSの `SHA256SUMS.txt` の指紋が表示されます。この指紋と公開鍵は、Bundleとは別の経路で導入先へ伝えます。

後方互換の単一archiveが必要な場合は`ExportSkill` / `export-skill`を使います。全exporterとinstallerは`distribution.json`のfile list、mode、versionを正本にします。

## 保存場所と秘密情報

Windows:

- Skill: `%USERPROFILE%\.codex\skills\chatgpt-project-bridge`
- launcher / Tunnel Client: `%LOCALAPPDATA%\ChatGPTProjectBridge\bin`
- 管理画面（GUI）のショートカット: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ChatGPT Project Bridge.lnk`
- profile / DPAPI key: `%APPDATA%\tunnel-client`
- 公開範囲の承認: `%APPDATA%\chatgpt-project-bridge\approvals`

Ubuntu:

- Skill: `~/.codex/skills/chatgpt-project-bridge`
- launcher / Tunnel Client: `~/.local/bin`
- 管理画面（GUI）のメニュー項目: `${XDG_DATA_HOME:-$HOME/.local/share}/applications/chatgpt-project-bridge.desktop`
- profile: `${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client/profiles`
- key: `${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client/secrets/<profile>.key`（`0600`、暗号化なし）
- 公開範囲の承認: `${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-project-bridge/approvals`（`0700` / `0600`）
- log / PID / health URL: `${XDG_STATE_HOME:-$HOME/.local/state}/tunnel-client`

API Keyをproject、Git、YAML、shell history、チャットへ入れないでください。WindowsのDPAPI暗号文は別PC・別ユーザーへコピーせず、Ubuntuのkey fileもコピーせず、移行先で再入力します。

## 検証ゲート

次は独立した判定です。後段の成功を前段から推測しません。

1. Local test: MCP stdioと公開境界の自己試験が成功した。
2. Approval: 現在の公開範囲が承認済みである。
3. Doctor: profile、key参照、MCP commandの静的・ローカル診断が成功した。
4. Running: Tunnel Clientがhealthy / readyでpollingしている。
5. Tool discovery: ChatGPT App設定でtool一覧を検出した。
6. End-to-end: ChatGPTが実際にtoolを呼び、現在のproject dataを返した。

最後のtool call成功だけがEnd-to-end接続完了です。
