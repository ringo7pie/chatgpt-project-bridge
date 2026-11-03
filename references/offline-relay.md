# PC停止中に参照するための保存サーバー

送信元の承認・snapshot作成・Claude Code hookを含む全体の手順は、[オフラインsnapshotの導入](offline-snapshots.md)を参照してください。

## できることと、必要な常時稼働先

この追加機能は、開発PCで作った公開用スナップショット（snapshot）を別のサーバーへ送り、その保存内容をChatGPTから参照するためのものです。開発PCが停止していても参照できますが、**保存サーバーと、そのサーバーのSecure MCP Tunnelは稼働している必要があります**。

保存先は、常時稼働するLinuxのVPSやNASを想定しています。NASでもNode.jsを実行でき、対象ユーザーの所有権とPOSIXアクセス権が実際に機能することが条件です。Windows版relayはACL検証を実装していないため、起動を拒否します。

この実装は、ChatGPT自体の記憶を書き換えるものではありません。また、ローカルに保存したJSONやMarkdownだけでは、電源を切ったPCの内容をChatGPTが新しく取得することはできません。

| 経路 | 処理 | 認証・公開範囲 |
|---|---|---|
| 開発PC → 保存サーバー | HTTPSで最新snapshotを送信 | sourceごとの専用writer token |
| 保存サーバー内 | 最新1件をprivate directoryへ保存 | 同じユーザーの所有、directory 700・file 600、リンク拒否 |
| 保存サーバー → Secure MCP Tunnel | stdioのMCPツールが保存内容を読む | Tunnelの別Runtime API Key |
| ChatGPT → Tunnel | プロジェクト一覧・本文・状態・検索を取得 | 保存サーバー用に作った別の接続 |

HTTP側には、読み取りMCP、任意ファイル取得、コマンド実行、ブラウザー用画面はありません。stdioのMCPは読み取り専用です。

## 1. 保存サーバー側を初期化する

以下は、保存サーバーへこのパッケージを配置済みで、通常ユーザーとして実行する例です。開発中のプロジェクト、Gitリポジトリ、同期共有フォルダーの中にstateを置かないでください。パッケージ自身の配下も拒否します。

```bash
bridge_root="/opt/chatgpt-project-bridge"
relay_state="$HOME/.local/share/chatgpt-bridge-relay"

node "$bridge_root/scripts/snapshot-relay.mjs" init \
  --state-dir "$relay_state" \
  --source-id desktop
```

作成するファイルは次のとおりです。

| ファイル・ディレクトリ | 内容 |
|---|---|
| `relay.json` | 待受先、source一覧、tokenファイルへの参照、上限設定 |
| `tokens/desktop.token` | 暗号学的乱数48bytesをbase64url化した専用writer token |
| `snapshots/` | source別の最新snapshot、取消後の時刻記録 |

コマンドは作成したパスだけを表示し、tokenの値は表示しません。writer tokenは安全な経路で送信元PCへコピーし、送信元側でもプロジェクト外のprivate fileとして保管します。コマンド引数、URLのクエリ、チャット、公開Git、環境変数一覧、ログへ貼り付けないでください。

別のPCを追加する場合は、同じstateに別のsourceを追加します。

```bash
node "$bridge_root/scripts/snapshot-relay.mjs" init \
  --state-dir "$relay_state" \
  --source-id ubuntu
```

sourceは最大32件です。同じsource名の再初期化、大小文字だけが違う重複、同じtokenファイルの複数sourceへの割当ては拒否します。source名は英数字から始まる英数字・`.`・`_`・`-`、最大63文字です。

## 2. HTTPSの受信先を用意する

### 方式A: HTTPSリバースプロキシを使う

既定の待受先は `127.0.0.1:8787` です。この設定ではrelay自身は同一サーバー内のHTTPだけを受け付けます。

```bash
node "$bridge_root/scripts/snapshot-relay.mjs" serve \
  --config "$relay_state/relay.json"
```

外部からの入口は、利用者が管理するHTTPSリバースプロキシ（reverse proxy）で用意します。送信元の設定例は `https://snapshot.example.net/v1/snapshots/desktop` です。`example.net` は実際の保存先へ置き換えてください。

リバースプロキシには次の条件が必要です。

- 検証可能なTLS証明書を使い、送信元が接続するURLは最初から `https://` にする。
- `/v1/snapshots/<sourceId>` の `PUT`・`POST`・`DELETE` だけをrelayへ転送する。
- `Authorization` と `Origin` をそのまま転送し、送信bodyを改変しない。
- bodyを最大8MiBに制限し、接続数とタイムアウトを制限する。
- Authorization、request body、response bodyをアクセスログやデバッグログに記録しない。
- キャッシュ、外部ストレージへのbody退避、過剰な再試行を設定しない。プロキシ製品の一時bodyファイルとログの保存動作も確認する。
- relayの8787番ポートを外部へ転送・公開しない。

リバースプロキシの具体的な設定、DNS、証明書、自動更新、VPS側のファイアウォールは、このコードから作成しません。選んだ製品の実際の設定で確認が必要です。

### 方式B: Node.js自身でTLSを終端する

relayは証明書と秘密鍵の両方を指定すればHTTPSで待ち受けます。

```bash
node "$bridge_root/scripts/snapshot-relay.mjs" serve \
  --config "$relay_state/relay.json" \
  --tls-cert "$HOME/.config/bridge-tls/fullchain.pem" \
  --tls-key "$HOME/.config/bridge-tls/privkey.pem"
```

証明書と秘密鍵は、このプロセスのユーザーが所有するdirectory 700・file 600の通常ファイルとして配置します。途中のディレクトリを含め、シンボリックリンクは使用できません。証明書管理ソフトが作るリンクを直接渡す構成は拒否されます。秘密鍵を一般ユーザーへ広く読ませるために権限を緩めないでください。

必要に応じて `relay.json` の `listen.host` と `listen.port` を編集して再起動します。外部へ待ち受けるなら、例えば `host` を `0.0.0.0`、`port` を `8443` とします。**TLSを指定せずに `127.0.0.1` 以外へ待ち受けようとすると起動を拒否します。** TLSは1.2以上を要求します。証明書を交換した際はrelayを再起動します。

いずれの方式でも、writer tokenをRuntime API Keyと兼用しないでください。writer tokenにChatGPT・OpenAI・GitHub等の既存API keyを使う必要はありません。

## 3. 保存サーバー専用のSecure MCP Tunnelを接続する

開発PCのTunnelを停止すると、開発PCへ向いている接続は停止します。保存サーバー用には**別のTunnel、別profile、別Runtime API Key**を用意してください。既存の開発PC用profileは変更しません。

Tunnelが起動するMCPコマンドは次です。ここでは直接実行すると標準入力を待ちます。

```bash
node "$bridge_root/scripts/snapshot-relay.mjs" mcp \
  --config "$relay_state/relay.json"
```

このパッケージの既存管理コードが使用しているTunnel Clientの引数に合わせると、設定例は次の形になります。`tunnel_REPLACE_WITH_REAL_ID` を実際に作成した保存サーバー用Tunnel IDに置換し、Node.jsとスクリプトの絶対パスも配置場所に合わせてください。パスに引用符を含む場合は、そのまま文字列を組み立てず、適切なエスケープが必要です。

```bash
umask 077
mkdir -p "$relay_state/tunnel-profiles"
chmod 700 "$relay_state/tunnel-profiles"

# 保存サーバー用Runtime API Keyをprivate fileへ入力して保存する。
# writer tokenとは別のキー。
nano "$relay_state/runtime.key"
chmod 600 "$relay_state/runtime.key"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile offline-relay \
  --profile-dir "$relay_state/tunnel-profiles" \
  --tunnel-id tunnel_REPLACE_WITH_REAL_ID \
  --control-plane-api-key-ref "file:$relay_state/runtime.key" \
  --health-listen-addr "127.0.0.1:0" \
  --mcp-command "node '$bridge_root/scripts/snapshot-relay.mjs' mcp --config '$relay_state/relay.json'"

tunnel-client doctor \
  --profile-dir "$relay_state/tunnel-profiles" \
  --profile offline-relay \
  --explain

tunnel-client run \
  --profile-dir "$relay_state/tunnel-profiles" \
  --profile offline-relay
```

この接続設定例は、同梱コードの呼び出し方を基にしています。**実際のOpenAIアカウントでのTunnel作成、認証、ChatGPTからの接続は、この変更の自己試験では実行していません。** 使用するTunnel Clientの版で引数を確認し、作成した保存サーバー側の接続をChatGPTに追加して検証してください。

参考の公式ページ:

- [Secure MCP Tunnelガイド](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Tunnelの作成・管理](https://platform.openai.com/settings/organization/tunnels)
- [Runtime API Keyの管理](https://platform.openai.com/settings/organization/api-keys)
- [ChatGPT Plugins](https://chatgpt.com/plugins)

## 4. 送信とChatGPTからの取得を確認する

送信元では、別途publisherの公開範囲と送信先を確認・承認してからsnapshotを作成・送信します。relayが受け取るのは、承認済み文書と許可されたGitメタデータのsnapshotです。ソースツリー全体、会話履歴、秘密設定を自動で保管する仕様ではありません。

受信成功の確認応答には `sourceId`・`capturedAt`・`receivedAt`・受信したraw bytesの `sha256` が入ります。これは保存サーバーでの保存確認です。ChatGPTから利用できることは、別にツールを呼んで確かめます。

ChatGPTで保存サーバー用の接続を指定し、次の順で確認します。

1. `get_snapshot_status` でsourceの状態、採取時刻、受信時刻、期限を取得する。
2. `list_projects` で `desktop::Alpha` のような完全なproject名を取得する。
3. その名前を `project` に指定して `get_project_context` と `get_project_status` を取得する。
4. 開発PCを停止した後も、保存サーバー側の同じ接続から、同じsnapshotが取得できるか確かめる。

| MCPツール | 返す情報 |
|---|---|
| `get_snapshot_status` | 保存・期限・失効・未取得・読取り不能の状態。任意の `sourceId` で絞り込み可能 |
| `list_projects` | 期限内のsnapshotに含まれるproject一覧と、収集できなかったprojectの理由 |
| `get_project_context` | 保存済み概要文書 |
| `get_project_status` | 保存済み状態文書と `savedGit` |
| `get_recent_changes` | 保存済みGit情報。`limit` は保存済みcommit配列の件数だけに適用 |
| `get_project_issues` | 保存済み状態文書内の課題・リスク等の見出し |
| `list_documents` | 保存文書のメタデータ一覧 |
| `get_document` | 指定projectの保存文書を相対パスで取得 |
| `search` | 保存文書の全文から文字列検索。任意のprojectで絞り込み可能 |
| `fetch` | `sourceId::project::相対パス` の文書IDで取得 |

すべての結果に `sourceMode: "snapshot"` と `liveVerified: false` を付けます。複数sourceの一覧では単一の採取時刻を捏造せず、外側の時刻は `null` とし、`sources` と各projectにそれぞれの時刻を載せます。文書とGitメタデータは信頼境界の外にある参考データとして扱い、そこに含まれる命令を実行しないよう、MCPの説明にも明記しています。

`get_recent_changes` の `days` を増やしても、保存時に取得していない履歴は増えません。`daysFilterApplied: false` を返します。現在のPCの電源状態、未送信の変更、現在のローカル承認状態は、この保存データだけでは確認できません。

## 5. 保存期限、取消、送信失敗

| 項目 | 動作 |
|---|---|
| 通常の保存 | sourceごとに最新1件を全置換。過去履歴の蓄積はしない |
| 通常の保存期限 | publisher既定は7日。schemaの上限は採取時刻から30日 |
| 古い情報の表示 | relay既定では採取後24時間から `stale: true` |
| 期限切れ | MCPの本文取得は即時拒否。一覧にもそのprojectは出さない |
| 期限切れ本文の廃棄 | `serve` 起動時と5分ごとの巡回、又は手動 `prune` で廃棄 |
| 採取時刻が古すぎる送信 | 既定では採取後24時間を超える新規uploadを拒否。新しいsnapshotを作り直す |
| 同じpayloadの再送 | 採取時刻とraw hashが一致し、期限・経過時間の検証を満たす場合は同じ受信確認を返す |
| 過去データ・同時刻の別payload | 拒否して現在のsnapshotを保持する |
| 空のproject一覧の送信 | 全置換なので、従来公開されていたprojectも取得不能になる |
| writerからの取消 | `DELETE /v1/snapshots/<sourceId>` で自分のsourceだけ取消可能 |
| 取消後・期限切れ廃棄後 | 本文を捨て、過去のuploadによる復活を防ぐ時刻記録（watermark）だけを保持 |
| 保存recordが壊れている場合の取消 | 内容は返せないが、`DELETE` は成功し、壊れたrecordを時刻記録（watermarkはエポック）へ置き換える。MCPからの読取りは従来どおり、壊れたrecordを返さない |
| 不正なupload・書込み失敗 | 完了前のデータへ切り替えず、以前の完全なsnapshotを保持する |

### 再投入防止の時刻記録（watermark）

relayは、受理済みのsnapshotの `capturedAt` を、そのsourceのwatermarkとして保持します。取消（`DELETE`）や期限切れ廃棄の後も、本文は捨てますがwatermarkは引き継ぎます。

- watermark以下の `capturedAt` を持つsnapshotは、取消・期限切れの後でも再投入できません（`409`）。同じ本文の再送も同様です。
- watermarkより新しい `capturedAt` を持つ正規のsnapshotは、取消・期限切れの後でも受理します。
- **取消の限界**: 取消より前に採取され、まだ受信側へ届いていなかったsnapshot（`capturedAt` がwatermarkより新しいもの）は、取消の後でも受理されます。2.4.0 では、watermarkを取消時刻（受信側の時計）にしていたため拒否されましたが、受信側の時計が進んでいると正規の送信元が長期間締め出されるため、引き継ぐ方式にしました。取り消した内容を再び送らせたくないときは、先に送信元で `uninstall-hook` を実行し、その後の `sync`（未送信の `latest.snapshot.json` をそのまま送る）を実行しないでください。`run` と hook は毎回再収集するため、新しい `capturedAt` で送られます。
- watermarkは受信側の現在時刻には引きずられません。受信側の時計が進んでいても、取消・廃棄の後の新しいsnapshotは拒否されません。取消・廃棄の時刻は `revokedAt` だけに記録します。
- 一度もsnapshotを受理していないsource、又は保存recordが壊れていたsourceの取消では、watermarkはエポック（`1970-01-01T00:00:00.000Z`）になります。

送信元で公開承認を取り消しても、その事実を送信できるまでは保存サーバーへ伝わりません。緊急に公開を止める場合は、保存サーバー側のsourceを設定から外す、保存サーバー側の接続を止める、又は送信元の取消コマンドで受信成功を確認します。単にhookを無効にするだけでは、既に送ったsnapshotは消えません。

手動の保存期限処理:

```bash
node "$bridge_root/scripts/snapshot-relay.mjs" prune \
  --config "$relay_state/relay.json"
```

`prune` は、設定から外したsourceの本文も廃棄します。停電や強制終了で残った正規のatomic-write一時ファイルは、1時間以上古く、所有者・アクセス権・通常ファイル・非リンクの条件を満たすものだけを廃棄します。実行中の短時間の一時ファイルや不明な名前のファイルは消しません。

廃棄はファイルの論理削除・置換です。SSD内部、ファイルシステムのsnapshot、NASの世代管理、VPSのバックアップ、プロキシの一時ファイルからの物理消去は保証しません。それらの保存期間は管理側で別に設定する必要があります。

## 6. 鍵、権限、運用の境界

この実装の防御は次のとおりです。

- writer tokenはsource単位。別sourceの書換えや取消には使えない。
- tokenは固定長digestへ変換してから `timingSafeEqual` で比較する。未知sourceと誤tokenは同じ401応答。
- 認証前はbodyを読み取らず、`100 Continue` も返さない。
- `Origin` 付きの要求を拒否し、CORSを許可しない。
- raw body最大8MiB、同時upload最大4、接続最大64、header最大8KiB、body処理10秒、JSON-RPC行最大64KiB・待ち最大32件。
- strict schema、本文hash、sourceId、採取時刻、保存期限を検証する。不正なuploadで現在のsnapshotを壊さない。
- tokenをupload中に交換・削除した場合にも、保存直前の再確認で送信を拒否する。
- directory 700・file 600、同じ所有者、シンボリックリンクとhardlinkの拒否、fsyncとatomic renameを使う。
- HTTP応答をキャッシュさせず、relay自身はbody、token、任意の入力文字列、生の例外をログへ出さない。
- MCPからwriter token、設定ファイル、任意ディスクパス、シェルへアクセスするツールは提供しない。

writer tokenを知った攻撃者は、そのsourceのsnapshotを差し替えたり取り消したりできます。schemaは送信元PCで本当に公開承認されたかを独立に証明するものではありません。`exposureSha256` は採取時の公開範囲を照合するための情報です。送信元PC、publisher設定、token、実行コードの保護が前提になります。

同じOSユーザーとして任意コードを実行できる相手、root、保存サーバー管理者からの秘匿はこの仕組みでは保証しません。保存本文はアプリケーション層で暗号化していません。ディスク暗号化やVPS/NAS側のバックアップ制御が必要なら、別に設定してください。

### MCPの入力上限

stdioのMCPは、1行が64KiBを超えた場合や、処理待ちが32件を超えた場合でも、プロセスを止めません。

- 改行が来ないまま64KiBを超えた行は、改行まで読み捨てます（メモリを増やしません）。`id: null` のJSON-RPCエラー（`-32600`、固定文言）を1回だけ返し、以降の要求は通常どおり処理します。
- 処理待ちが32件を超えた要求は、`id` を取り出せれば `id` つきで、取り出せなければ `id: null` で、`-32000` の固定文言のエラーを返して捨てます。
- 標準出力にはJSON-RPC以外を出さず、標準出力・標準エラーとも入力の内容を含めません。

### lockが残った場合

relayはsourceごとの短いlock（`snapshots/<sourceId>.lock`）を使用します。処理がSIGKILLや停電で中断された場合はlockが残り、該当sourceへの変更を拒否する（`409`）ことがあります。

- `snapshots/<sourceId>.lock` は、`PUT`・`POST`・`DELETE` のときに、次の条件をすべて満たす場合だけrelayが回収し、1回だけ再試行します。作成（最終更新）から60秒を超えている。通常ファイル・自分の所有・hardlinkなしである。lockにPIDが書かれていれば、そのPIDのプロセスが存在しない（PIDが無い、又は読めない場合は、60秒超だけで足りる）。
- 生存プロセスのPIDが書かれているlock、60秒以内のlockは奪いません。PIDが別のプロセスへ再利用されている場合も、生存として扱い、回収しません。
- stateDir直下の `configuration.lock` は、`init` が `relay.json` と `tokens/` を更新する間だけ使うlockです。自動では回収しません。`init` が `state_locked` で失敗し続ける場合だけ、手動で復旧します。
- 手動の復旧は、relayと同じstateを使うすべての管理処理（`serve`・`mcp`・`init`・`prune`）を止め、`ps` などでlockに書かれたPID（`cat` で確認）が生きていないことを確かめたうえで、対象のlockファイルだけを管理者が取り除いて再起動します。`snapshots/<sourceId>.json` や `relay.json`、tokenファイルを一緒に消さないでください。

### 送信元の鍵（writer token）の期限・交換・失効

- writer tokenに**期限はありません**。期限があるのはsnapshotの `expiresAt` だけです。tokenは、交換するか、sourceを外すまで有効です。
- 交換: `tokens/<sourceId>.token` の中身を、新しい乱数（英数字・`-`・`_`の43〜128文字）へ置き換えます。relayは要求ごとにtokenファイルを読むため、relayの再起動は不要です。ファイルは所有者のみ・600・通常ファイル（hardlinkなし）のままにし、同じdirectory内の一時ファイルへ書いてから `mv` で置換してください。置換後は旧tokenでの送信が `401` になるため、送信元の設定も更新します。tokenを新規生成・交換する専用コマンドはありません。
- 失効: `relay.json` の `sources` から該当sourceを外します。以後の `PUT`・`DELETE` は `401` になり、`serve` 起動時・5分ごとの巡回・手動 `prune` で本文が廃棄されます（watermarkは残ります）。`tokens/<sourceId>.token` は自動では消えないため、不要なら手動で削除してください。同じsource名を `init` で作り直す場合は、残ったtokenファイルを先に削除する必要があります（上書きせず失敗します）。`sources` を空にはできず、その場合relayは設定エラーで拒否します。
- できないこと: tokenに失効日時を設定すること、複数のtokenを同じsourceへ同時に有効にすること（交換の瞬間の新旧併用）、送信元PC側のtokenの遠隔消去。

常駐サービスへの登録は自動では行いません。まずforegroundでHTTPS送信とMCP取得を確認し、その後に通常のサービス管理機構でrelayとTunnelを常駐させます。専用の権限の低いユーザーを使い、debug/payload loggingを有効にしない運用を想定しています。

## 検証範囲

```bash
node "$bridge_root/scripts/snapshot-relay-selftest.mjs"
```

この自己試験は一時ディレクトリとlocalhostだけで動きます。HTTP実通信、token分離、認証前拒否、upload中の取消、bodyとprotocolの上限、replay、raw hash、期限、全置換、取消、MCP stdio、権限・symlink・hardlink、廃棄処理を検証します。

実際のVPS/NAS、Windows ACL、リバースプロキシ、証明書自動更新、電源断、Claude Code本体の終了hook、Secure MCP Tunnelの実アカウント接続、ChatGPTからの取得は別の実環境確認です。自己試験が通ったことを、それらが成功したという意味には扱わないでください。
