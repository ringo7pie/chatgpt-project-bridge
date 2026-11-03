#Requires -Version 7
<#
.SYNOPSIS
  ChatGPT Project Bridge の管理画面（Windows 版 GUI）。

.DESCRIPTION
  project-bridge.ps1 を子プロセスで呼ぶだけの画面。パス・指紋・キー・上書きの安全検査は CLI に任せ、ここでは再実装しない。
  説明文は assets/gui-help.ja.json を Ubuntu 版と共有する。
  公開範囲の承認はこの画面の承認ダイアログで行い、Runtime API Key は別のコンソール窓で CLI が受け取る（この画面はキーを扱わない）。
  別のコンソール窓では、このスクリプト自身を補助役（-ConsoleHelper）として起動し、補助役が CLI を 1 回だけ実行して Enter を待って終わる（対話プロンプトを残さない）。
  画面の上のハブの稼働表示は、ハブ設定（hub.json）・Tunnel Client の PID ファイル・その PID のプロセスを読むだけで調べる（何も書かず、子プロセスを起動せず、通信もしない）。
  ドットソースしたときは画面を出さず、関数だけを読み込む（Windows 側で Pester から純粋な関数を試すため）。
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    # STA で起動し直した 2 回目であることを示す（起動し直しを 1 回に限るため。利用者は指定しない）。
    [switch]$StaRelaunched,
    # 別のコンソール窓の補助役として起動する（この画面がキーを聞く Action のために付ける。利用者は指定しない）。
    # 以下の引数は補助役のときだけ受け付け、CLI（project-bridge.ps1）の同名のパラメーターへそのまま渡す。
    [switch]$ConsoleHelper,
    [string]$Action,
    [string]$ProjectRoot,
    [string]$ProjectName,
    [string]$Profile,
    [string]$HubName,
    [string]$TunnelId,
    [string]$TunnelClientPath,
    [string]$ExposureSha256,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [switch]$ForceReconfigure,
    [switch]$ReplaceKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:GuiScriptPath = $PSCommandPath # この画面のスクリプト。STA で起動し直すときと、別コンソールの補助役を起動するときに使う。
$script:IsStaRelaunch = [bool]$StaRelaunched # STA で起動し直した 2 回目か。
$script:IsConsoleHelper = [bool]$ConsoleHelper # 別コンソールの補助役として起動したか。
$script:LaunchParameters = @{} # 起動時に指定された引数（名前 → 値）。画面と補助役の入口で形を確かめる。
foreach ($launchEntry in $PSBoundParameters.GetEnumerator()) { $script:LaunchParameters[[string]$launchEntry.Key] = $launchEntry.Value }
$script:CliPath = Join-Path $PSScriptRoot 'project-bridge.ps1' # 呼び出す CLI。
$script:HelpPath = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets') 'gui-help.ja.json' # 説明文の共有データ。
$script:BridgeConfigName = '.chatgpt-project-bridge.json' # プロジェクト側の公開範囲設定名（足場の有無の判定に使う）。
$script:ToolTipMaxLength = 1000 # ツールチップ本文の上限文字数。超えると表示が切れるため。
$script:ToolTipEllipsis = '…（続きは README・マニュアル）' # 上限で切ったときに末尾へ付ける案内。
$script:ToolTipColumns = 64 # ツールチップ本文を改行する表示幅（半角 1・全角 2 で数える。Ubuntu 版の TOOLTIP_COLUMNS と同じ。WinForms の ToolTip は長い行を折り返さないため）。
$script:WrapBreakAfter = '。、，．）」』】・ /\' # この文字の直後なら行を分けてよい（Ubuntu 版の BREAK_AFTER と同じ）。
$script:WrapNoLineStart = '。、，．）」』】ー：:,.)' # 行頭に置かない文字（Ubuntu 版の NO_LINE_START と同じ）。
# 表示幅を 2 と数える文字の範囲（開始, 終了 の組の並び）。Ubuntu 版の East Asian Width（W・F）の主な範囲の近似（.NET には表が無いため）。
# CJK・かな・ハングル・全角形は Unicode の表どおり。絵文字（U+1F300〜U+1F64F・U+1F900〜U+1F9FF）は範囲でまとめた近似。
$script:WideCharacterRanges = @(
    0x1100, 0x115F, 0x2E80, 0x303E, 0x3041, 0x3247, 0x3250, 0x4DBF, 0x4E00, 0xA4CF, 0xA960, 0xA97F, 0xAC00, 0xD7A3,
    0xF900, 0xFAFF, 0xFE10, 0xFE19, 0xFE30, 0xFE6F, 0xFF00, 0xFF60, 0xFFE0, 0xFFE6, 0x1F300, 0x1F64F, 0x1F900, 0x1F9FF,
    0x20000, 0x2FFFD, 0x30000, 0x3FFFD
)
$script:ToolTipTextCache = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal) # 折り返したツールチップ本文（上限で切った本文 → 折り返した本文。同じ本文を何度も折り返さないため）。
$script:GuiManagedOptions = @('exposure-sha256', 'service') # 入力欄に出さず、この画面が決めるオプション。
$script:GuiManagedParameters = @('Action', 'ExposureSha256', 'Service') # 欄の値やチェックからは作らない CLI のパラメーター（名前の書き方を変えても受け付けない）。
$script:KeyConsoleActions = @('SaveKey', 'AddProject', 'HubAdd') # 別のコンソール窓で実行する Action（キーを CLI が直接受け取る）。
# 別コンソールの補助役が CLI へ渡してよいパラメーター（Action ごと）。説明データの options のうち、Windows の画面に出るものと指紋・-NoStart。
$script:ConsoleHelperParameters = @{
    SaveKey = @('ProjectRoot', 'Profile', 'ReplaceKey')
    AddProject = @('ProjectRoot', 'ProjectName', 'Profile', 'TunnelId', 'TunnelClientPath', 'NoBrowser', 'NoStart', 'ForceReconfigure', 'ReplaceKey', 'ExposureSha256')
    HubAdd = @('ProjectRoot', 'ProjectName', 'HubName', 'TunnelId', 'TunnelClientPath', 'NoBrowser', 'NoStart', 'ForceReconfigure', 'ReplaceKey', 'ExposureSha256')
}
$script:ConsoleHelperSwitches = @('NoBrowser', 'NoStart', 'ForceReconfigure', 'ReplaceKey') # 補助役が受け付けるチェック（値を取らない）パラメーター。
# 何も書き換えない Action（説明データの effect が「書き換えません」「書き込みません」「読み取り専用」のもの。HubStop は Tunnel Client を止めるため含めない）。
# 別のコンソール窓が開いている間は、これ以外の「実行」を押せなくする（hub.json・承認・キーを同時に変えないため）。
$script:ReadOnlyActions = @('Test', 'Doctor', 'Status', 'ShowExposure', 'HubList', 'HubDoctor', 'HubStatus', 'HubPermissions')
$script:ForcedNoStartActions = @('AddProject', 'HubAdd') # 別コンソールで必ず -NoStart を付ける Action（起動は別のボタンで行う）。
$script:HubApprovalActions = @('HubStart', 'HubRestart') # 登録プロジェクトを 1 つずつ承認してから -Service で起動する Action。
$script:ManagedForegroundActions = @('Start', 'HubStart', 'HubRestart') # この画面が子プロセスとして持ち続け、停止ボタンを出す Action。
$script:AuxiliaryActions = @('Status', 'HubStatus', 'HubList') # 前面の子プロセスが動いている間も実行できる、読み取りだけの短い Action（補助の子プロセス。同時に 1 つまで）。
$script:GuiPlatform = 'windows' # 説明データの platformOnly で、この画面に出すオプションを決める OS 名。
$script:DashCharacters = @('-', [string][char]0x2013, [string][char]0x2014, [string][char]0x2015) # 値の先頭に来ると pwsh がパラメーター名と見なしうる文字（- と、PowerShell が - と同じに扱うダッシュ 3 種）。
$script:LayoutTypeNames = @('Panel', 'FlowLayoutPanel', 'TableLayoutPanel', 'TabControl') # 説明を付けない、配置だけを受け持つコンテナー。
$script:ComponentTypeNames = @('Form', 'ToolTip', 'Timer', 'FolderBrowserDialog', 'OpenFileDialog', 'SaveFileDialog') # コントロール以外に作る部品。
# 共通仕様 S1 の禁止文字にあたる Unicode の一般カテゴリ（制御・書式・行区切り・段落区切り・対にならないサロゲート）。
$script:ForbiddenCategories = @(
    [System.Globalization.UnicodeCategory]::Control,
    [System.Globalization.UnicodeCategory]::Format,
    [System.Globalization.UnicodeCategory]::LineSeparator,
    [System.Globalization.UnicodeCategory]::ParagraphSeparator,
    [System.Globalization.UnicodeCategory]::Surrogate
)
$script:CliOutputMark = '│ ' # ログ欄で CLI の出力行の先頭に付ける印（この画面自身のお知らせと見分けるため）。
$script:MixedScriptMark = '  ⚠ 混在した文字種' # 1 区切りの中でラテン文字とキリル文字・ギリシャ文字が混ざる値に付ける印（同形異字の疑い）。
$script:DisplayLineWidth = 200 # 承認ダイアログの一覧で 1 行に出す最大の文字数（超える行は続きの行に分ける）。
$script:ContinuationMark = '      （続き）' # 一覧で長い行を分けたとき、続きの行の先頭に付ける印。
$script:KnownExposureFields = @('schemaVersion', 'projectRoot', 'contextFile', 'statusFile', 'allowFiles', 'allowDirectories', 'denyDirectories', 'maxDocumentBytes', 'gitExposure', 'detailExposure', 'sourceScope', 'claudeCode') # 承認ダイアログが個別に表示する公開範囲の欄（これ以外は「その他の項目」に出す）。
$script:HubStatusToolTip = 'この PC のハブ（Tunnel Client）のプロセスが動いているかを、3 秒ごとに調べて表示します。調べるのは、Tunnel Client が書く PID ファイルと、その PID のプロセスだけです（読み取りだけで、通信はしません。ハブ設定も読むだけです）。この画面の外（別の端末や自動起動）で起動したハブも表示します。「実行中」が示すのは、5 段階のうち 3 の「Tunnel Client の稼働」だけです。OpenAI とつながっているかは「ハブの稼働状態」で、ChatGPT から読めるかは ChatGPT の画面で確かめます。起動したときと「一覧を更新」のときには、分かっている値（「プロジェクトを追加」の Tunnel ID と、Tunnel Client の場所）を空の入力欄に入れます。入力済みの値は書き換えません。' # 画面の上のハブの稼働表示（状態と詳細の 2 つのラベル）の説明（Ubuntu 版と同じ文）。
# 他のカードと値を共有しない入力欄（Action 名 → オプション名）。「プロジェクトを追加」（HubAdd）の Tunnel ID には、ハブ設定の Tunnel ID を自動で入れる。
# その値が従来方式（ConfigureTunnel・AddProject）の Tunnel ID 欄へ写ると、プロジェクトごとに別の Tunnel を使う決まりに反する設定を誘うため、共有しない。
# ConfigureTunnel と AddProject の 2 つは、これまでどおり互いに共有する。
$script:UnsharedInputOptions = @{
    HubAdd = @('tunnel-id')
}

# 画面の部品と状態。キーは先に全部作っておく（StrictMode で未定義の参照にしないため）。
$script:Ui = @{
    Form = $null # 主画面。
    ToolTip = $null # 全コントロールで共有する説明表示。
    Timer = $null # 子プロセスの出力を読む UI スレッドのタイマー。
    LogBox = $null # 出力ログ欄。
    CommandBox = $null # 「実行されるコマンド」欄。
    HubListView = $null # かんたんタブの登録一覧。
    MonoFont = $null # 等幅フォント。
    Help = $null # gui-help.ja.json の内容。
    CliParameters = $null # CLI が受け付けるパラメーター名の集合。
    PwshPath = '' # 子プロセスに使う pwsh のフルパス。
    WorkingDirectory = '' # 子プロセスの作業フォルダー（相対パスの基準）。
    Cards = [System.Collections.Generic.List[object]]::new() # 全カード。
    SharedInputs = @{} # オプション名 → 同じ値を共有する入力欄の一覧。
    Jobs = [System.Collections.Generic.List[object]]::new() # 実行中の子プロセス。
    Flow = $null # 実行中の操作（1 つだけ）。
    AuxJob = $null # 前面の子プロセスと並行して動かす補助の子プロセス（同時に 1 つまで）。
    ConsoleProcess = $null # 別のコンソール窓（キーを聞く Action の補助役）のプロセス。終わるまで設定を変える Action を押せなくする。
    SyncingInput = $false # 入力欄の値を他のカードへ写している最中か（再入防止）。
    SuppressDangerConfirm = $false # 上書き系のチェックを戻している最中か（確認ダイアログの再入防止）。
    InTick = $false # タイマーの処理中か（モーダルダイアログ中の再入防止）。
    HubStateLabel = $null # 画面の上のハブの稼働表示のうち、状態のラベル（実行中・停止中・未設定・確認できません）。
    HubDetailLabel = $null # 画面の上のハブの稼働表示のうち、詳細のラベル（Tunnel ID・プロファイル・登録件数、または理由）。
    HubTimer = $null # ハブの稼働表示を 3 秒ごとに調べ直す UI スレッドのタイマー（主画面を閉じるときに止める）。
    HubProbe = $null # コマンドラインを最後に確かめたプロセス（PID・開始時刻・プロファイル名の組）と、その結果。組が変わるまで問い合わせ直さない。
    InHubUpdate = $false # ハブの稼働表示の更新中か（再入防止）。
    AutoFilled = @{} # 自動入力した値（欄の名前 → 最後に入れた値）。欄がこの値のままのときだけ、次の自動入力で書き換える。
    ConsoleTimer = $null # コンソールの Ctrl+C・Ctrl+Break を受けたかを 200 ms ごとに調べる UI スレッドのタイマー（受けたら画面を閉じる）。
    ConsoleSignal = $null # コンソールの Ctrl+C・Ctrl+Break を受けたことを、信号の処理（別のスレッド）から UI スレッドへ知らせる印（ManualResetEventSlim）。
    ConsoleRegistrations = [System.Collections.Generic.List[System.IDisposable]]::new() # コンソールの信号を pwsh より先に受け取る登録（PosixSignalRegistration）。画面を閉じたあとで外す。
    ConsoleCloseRequested = $false # コンソールの Ctrl+C・Ctrl+Break を受けて、画面を閉じる途中か（前面のダイアログを閉じてから主画面を閉じる）。
    InConsoleClose = $false # コンソールの Ctrl+C・Ctrl+Break で主画面を閉じている最中か（閉じる確認の間の再入防止）。
    PermissionJob = $null # 権限（ソースの読み取り・Claude Code の起動）の確認・切り替えの子プロセス（同時に 1 つまで。Flow・AuxJob とは別に持つ）。
    PermissionToggle = $null # 進行中の切り替え（On/Off）の状態（切り替え先・対象の行・まだ権限を確認していない間は Direction が $null）。無ければ $null。
    PermissionCheckButton = $null # かんたんタブの「権限を確認」ボタン。
    PermissionSourceButton = $null # かんたんタブの「ソースの読み取りを切り替え」ボタン。
    PermissionClaudeButton = $null # かんたんタブの「Claude Code の起動を切り替え」ボタン。
}

# ---------------------------------------------------------------------------
# 純粋な処理（画面を作らない。Pester から呼べる）
# ---------------------------------------------------------------------------

# kebab-case の名前（hub-add、exposure-sha256）を、CLI の PascalCase（HubAdd、ExposureSha256）へ変換する。
# 規則は「- で区切った各語の先頭 1 文字だけを大文字にして連結する」だけ。対応表は持たない（静的試験が Python の写しと突き合わせる）。
function ConvertTo-PascalName {
    param([Parameter(Mandatory)][string]$Name)
    $words = $Name -split '-' # - で区切った語。
    $converted = foreach ($word in $words) {
        if ($word.Length -eq 0) { continue }
        $word.Substring(0, 1).ToUpperInvariant() + $word.Substring(1)
    }
    return (@($converted) -join '')
}

# JSON のオブジェクトから文字列の項目を取り出す。項目が無いか null なら空文字を返す（StrictMode で例外にしないため）。
# 項目の有無は PSObject.Properties[名前] で調べる（項目が 1 つも無い {} に .PSObject.Properties.Name を読むと、StrictMode では例外になるため）。
function Get-EntryText {
    param([object]$Entry, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Entry) { return '' }
    if ($null -eq $Entry.PSObject.Properties[$Name]) { return '' }
    $value = $Entry.$Name # 取り出した値。
    if ($null -eq $value) { return '' }
    return [string]$value
}

# JSON のオブジェクトから配列の項目を、要素ごとにパイプラインへ出す。無ければ何も出さない。呼び出し側は @() で受ける。
function Get-EntryList {
    param([object]$Entry, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Entry) { return }
    if ($null -eq $Entry.PSObject.Properties[$Name]) { return }
    $value = $Entry.$Name # 取り出した値。
    if ($null -eq $value) { return }
    foreach ($item in @($value)) { $item }
}

# JSON の真偽値の項目が true かを返す。項目が無ければ false。
function Test-EntryFlag {
    param([object]$Entry, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Entry) { return $false }
    if ($null -eq $Entry.PSObject.Properties[$Name]) { return $false }
    return ($Entry.$Name -eq $true)
}

# JSON のオブジェクトから、1 つの値（文字列・数・真偽値）を型を変えずに返す。項目が無ければ $null。配列には使わない（Get-EntryList を使う）。
function Get-EntryValue {
    param([object]$Entry, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Entry) { return $null }
    if ($null -eq $Entry.PSObject.Properties[$Name]) { return $null }
    return $Entry.$Name
}

# JSON の真偽値の項目が「false と明示されている」とき以外は $true を返す。
# 項目が無い・真偽値でないときは、広い側（公開・配下すべて）として表示するため（表示が実際より狭く見えないようにする）。
function Test-EntryNotFalse {
    param([object]$Entry, [Parameter(Mandatory)][string]$Name)
    $value = Get-EntryValue -Entry $Entry -Name $Name # 項目の値。
    return (-not ($value -is [bool] -and $value -eq $false))
}

# 共有データ gui-help.ja.json を読む。groups・actions・options が揃っていなければ止める。
function Read-GuiHelp {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "説明文のデータがありません: $Path" }
    $help = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json # 読み込んだ説明文。
    foreach ($name in @('groups', 'actions', 'options')) {
        if ($null -eq $help.PSObject.Properties[$name]) { throw "説明文のデータに $name がありません: $Path" }
    }
    return $help
}

# 説明文のデータから、オプション 1 つ分の項目を返す。無ければ $null。
function Get-OptionEntry {
    param([Parameter(Mandatory)][object]$Help, [Parameter(Mandatory)][string]$OptionName)
    if ($null -eq $Help.options.PSObject.Properties[$OptionName]) { return $null }
    return $Help.options.$OptionName
}

# ツールチップの本文が長すぎると表示が切れるため、上限で切って末尾に案内を付ける。
function Limit-ToolTipText {
    param([AllowEmptyString()][AllowNull()][string]$Text, [int]$MaxLength = $script:ToolTipMaxLength)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    if ($Text.Length -le $MaxLength) { return $Text }
    $keepLength = $MaxLength - $script:ToolTipEllipsis.Length # 本文として残す文字数。
    if ($keepLength -lt 0) { $keepLength = 0 }
    return $Text.Substring(0, $keepLength).TrimEnd() + $script:ToolTipEllipsis
}

# 1 コードポイント（1 文字。サロゲートペアは 2 つの UTF-16 で 1 文字）の表示幅を返す。$script:WideCharacterRanges の範囲なら 2、それ以外は 1。
# Ubuntu 版の character_width（East Asian Width が W・F なら 2）の近似（静的試験が、説明データと画面の文に出る全ての文字で突き合わせる）。
function Get-DisplayCharacterWidth {
    param([Parameter(Mandatory)][string]$Character)
    $codePoint = if ($Character.Length -ge 2 -and [char]::IsSurrogatePair($Character, 0)) { [char]::ConvertToUtf32($Character, 0) } else { [int]$Character[0] } # 文字のコードポイント（対にならないサロゲートはその値のまま）。
    if ($codePoint -lt 0x1100) { return 1 }
    $ranges = $script:WideCharacterRanges # 表示幅 2 の範囲（開始, 終了 の組の並び）。
    for ($rangeIndex = 0; $rangeIndex -lt $ranges.Count; $rangeIndex += 2) {
        if ($codePoint -lt $ranges[$rangeIndex]) { return 1 }
        if ($codePoint -le $ranges[$rangeIndex + 1]) { return 2 }
    }
    return 1
}

# 行を分ける位置（Line の要素の番号。その前までを 1 行にする）を、行末に近い句読点・空白の直後から選ぶ。英数字の並びの途中はなるべく避ける。
# Ubuntu 版の choose_break と同じ規則（行末から Window 文字の範囲で探し、見つからなければ行の終わりで分ける）。Line は 1 要素 1 文字の並び。
function Get-WrapBreakIndex {
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Line, [int]$Window = 12)
    $lower = [Math]::Max(1, $Line.Count - $Window) # これより前では分けない。
    for ($position = $Line.Count - 1; $position -ge $lower; $position--) {
        if ($script:WrapBreakAfter.Contains($Line[$position])) { return $position + 1 }
    }
    $position = $Line.Count # 英数字の並びの始まりを探す位置。
    while ($position -gt $lower) {
        $code = [int]$Line[$position - 1][0] # 直前の文字の先頭の UTF-16（ASCII かどうかだけを見る。サロゲートは 0x80 以上）。
        # ASCII の空白類（Python の str.isspace と同じ: タブ・改行類・U+001C〜U+001F・空白）以外の ASCII 文字の並びをさかのぼる。
        if ($code -ge 0x80 -or ($code -ge 0x09 -and $code -le 0x0D) -or ($code -ge 0x1C -and $code -le 0x20)) { break }
        $position--
    }
    if ($lower -lt $position -and $position -lt $Line.Count) { return $position }
    return $Line.Count
}

# 本文に改行を入れて、1 行の表示幅（半角 1・全角 2）を Columns 程度に収める。既存の改行（CR LF・LF）は残し、段落ごとに折り返す。
# Ubuntu 版の wrap_display_text と同じ規則: 次の文字で幅を超えるとき、その文字が行頭に置かない文字でなければ、Get-WrapBreakIndex の位置で分ける
# （分けた前の行の末尾の空白と、次の行の先頭の空白は除く）。文字はコードポイントごとに扱い、サロゲートペアの途中では分けない。行は CR LF でつなぐ。
function Format-WrappedText {
    param([AllowEmptyString()][AllowNull()][string]$Text, [int]$Columns = $script:ToolTipColumns)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $output = [System.Collections.Generic.List[string]]::new() # 折り返した行。
    foreach ($paragraph in @($Text -split "`r?`n")) {
        $line = [System.Collections.Generic.List[string]]::new() # 組み立て中の行（1 要素 1 文字）。
        $lineWidth = 0 # 組み立て中の行の表示幅。
        $index = 0 # 段落の中で見ている UTF-16 の位置。
        while ($index -lt $paragraph.Length) {
            $unitCount = if ([char]::IsSurrogatePair($paragraph, $index)) { 2 } else { 1 } # この文字の UTF-16 の数。
            $character = $paragraph.Substring($index, $unitCount) # この文字。
            $index += $unitCount
            $step = Get-DisplayCharacterWidth -Character $character # この文字の表示幅。
            if (($lineWidth + $step) -gt $Columns -and $line.Count -gt 0 -and -not $script:WrapNoLineStart.Contains($character)) {
                $cut = Get-WrapBreakIndex -Line $line # 分ける位置。
                $output.Add((($line.GetRange(0, $cut)) -join '').TrimEnd(' '))
                $rest = $line.GetRange($cut, $line.Count - $cut) # 次の行へ送る文字。
                $line = [System.Collections.Generic.List[string]]::new()
                $lineWidth = 0
                foreach ($restCharacter in $rest) {
                    if ($line.Count -eq 0 -and $restCharacter.Equals(' ')) { continue }
                    $line.Add($restCharacter)
                    $lineWidth += Get-DisplayCharacterWidth -Character $restCharacter
                }
            }
            $line.Add($character)
            $lineWidth += $step
        }
        $output.Add(($line -join ''))
    }
    return ($output -join "`r`n")
}

# ツールチップに出す本文を返す（Format-WrappedText で折り返したもの）。上限で切った後の本文を渡す。
# 同じ本文（見出しと概要、ラベルと入力欄など）は何度も出るため、折り返した結果を覚えておく（大文字小文字も区別して照合する）。
function Get-WrappedToolTipText {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    $key = [string]$Text # 覚えておくときのキー（null は空文字）。
    $wrapped = $null # 覚えておいた結果。
    if ($script:ToolTipTextCache.TryGetValue($key, [ref]$wrapped)) { return $wrapped }
    $wrapped = Format-WrappedText -Text $key
    $script:ToolTipTextCache[$key] = $wrapped
    return $wrapped
}

# Action の説明（概要・いつ使う・事前に必要・実行すると・次にすること・注意）を 1 つの本文にする。空の項目は出さない。
# GuiNote を渡すと、この画面での動き方を【この画面では】として末尾に足す。
function Get-ActionToolTipText {
    param([Parameter(Mandatory)][object]$Action, [AllowEmptyString()][string]$GuiNote = '')
    $lines = [System.Collections.Generic.List[string]]::new() # 本文の行。
    $summary = Get-EntryText -Entry $Action -Name 'summary' # 概要。
    if ($summary -ne '') {
        $lines.Add($summary)
        $lines.Add('')
    }
    $sections = @(
        @('when', '【いつ使う】'),
        @('requires', '【事前に必要】'),
        @('effect', '【実行すると】'),
        @('next', '【次にすること】'),
        @('caution', '【注意】')
    ) # 項目名と見出しの組。
    foreach ($section in $sections) {
        $value = Get-EntryText -Entry $Action -Name $section[0]
        if ($value -ne '') { $lines.Add($section[1] + $value) }
    }
    if ($GuiNote -ne '') { $lines.Add('【この画面では】' + $GuiNote) }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    return Limit-ToolTipText -Text ($lines -join "`r`n")
}

# オプションの説明（概要・入力例・既定・注意）を 1 つの本文にする。空の項目は出さない。
# GuiNote を渡すと、この画面での扱いを【この画面では】として末尾に足す。
function Get-OptionToolTipText {
    param([Parameter(Mandatory)][object]$Option, [AllowEmptyString()][string]$GuiNote = '')
    $lines = [System.Collections.Generic.List[string]]::new() # 本文の行。
    $summary = Get-EntryText -Entry $Option -Name 'summary' # 概要。
    if ($summary -ne '') { $lines.Add($summary) }
    $sections = @(
        @('example', '【入力例】'),
        @('default', '【既定】'),
        @('caution', '【注意】')
    ) # 項目名と見出しの組。
    foreach ($section in $sections) {
        $value = Get-EntryText -Entry $Option -Name $section[0]
        if ($value -ne '') { $lines.Add($section[1] + $value) }
    }
    if ($GuiNote -ne '') { $lines.Add('【この画面では】' + $GuiNote) }
    return Limit-ToolTipText -Text ($lines -join "`r`n")
}

# Action ごとの、この画面での動き方の説明。CLI をそのまま呼ぶ Action は空文字。
function Get-ActionGuiNote {
    param([Parameter(Mandatory)][string]$ActionName)
    switch ($ActionName) {
        'HubAdd' { return '足場（.chatgpt-project-bridge.json）が無ければ、先に「プロジェクトを初期化」（Init）を実行します。続けて公開範囲を表示して承認を求め、承認したら別のコンソール窓で CLI を -NoStart 付きで実行します。キーはその窓に入力します。ハブの起動は「ハブを起動」で別に行います。その窓は CLI が終わると Enter キーで閉じます（閉じるまで、設定を変える操作の「実行」は押せません）。' }
        'AddProject' { return '足場（.chatgpt-project-bridge.json）が無ければ、先に「プロジェクトを初期化」（Init）を実行します。続けて公開範囲を表示して承認を求め、承認したら別のコンソール窓で CLI を -NoStart 付きで実行します。キーと Tunnel ID の入力はその窓で行います。起動は「Tunnel を起動」で別に行います。その窓は CLI が終わると Enter キーで閉じます（閉じるまで、設定を変える操作の「実行」は押せません）。' }
        'SaveKey' { return '別のコンソール窓で CLI を実行します。キーはその窓に入力します。この画面はキーを読みません。その窓は CLI が終わると Enter キーで閉じます（閉じるまで、設定を変える操作の「実行」は押せません）。' }
        'Start' { return '公開範囲を表示し、未承認・変更ありなら承認を求めます。承認すると起動し、この画面が動かし続けます。「停止」は CLI を Tunnel Client ごと（プロセスツリーごと）止めます。' }
        'Approve' { return '公開範囲を表示し、未承認・変更ありなら承認ダイアログを出します。承認済みなら、ダイアログを出さずに CLI を実行します。' }
        'HubStart' { return '登録プロジェクトを 1 つずつ確認し、未承認・変更ありのものは承認ダイアログを出します。そのあと -Service を付けて起動します（承認しなかったプロジェクトは公開しません）。「停止」は「ハブを停止」（HubStop）を実行します。' }
        'HubRestart' { return '登録プロジェクトを 1 つずつ確認し、未承認・変更ありのものは承認ダイアログを出します。そのあと -Service を付けて再起動します（承認しなかったプロジェクトは公開しません）。「停止」は「ハブを停止」（HubStop）を実行します。' }
        { $script:AuxiliaryActions -contains $_ } { return "読み取りだけの短い操作のため、ハブや Tunnel Client をこの画面で動かしている間も実行できます（同時に 1 つまで）。そのときの出力は、行の先頭に $(Get-LogLinePrefix -ActionName $ActionName)が付きます。" }
        default { return '' }
    }
}

# CLI（project-bridge.ps1）の param ブロックが受け付けるパラメーター名の集合を返す（大文字小文字を区別しない）。
# Get-Command -Name <パス> はパスをワイルドカードとして扱い、[ ] を含むフォルダーでは CLI を見つけられないか、別のファイルを指すため使わない
# （WildcardPattern::Escape で逃がしても見つからない）。CommandMetadata はパスをそのまま読み、param で宣言した名前だけを返す（共通パラメーターは含まない）。
function Get-CliParameterSet {
    param([Parameter(Mandatory)][string]$CliPath)
    $metadata = [System.Management.Automation.CommandMetadata]::new($CliPath) # CLI の param の情報（スクリプトは実行しない）。
    $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase) # パラメーター名の集合。
    foreach ($key in $metadata.Parameters.Keys) { [void]$names.Add([string]$key) }
    return , $names
}

# 説明データの platformOnly に従い、オプションをこの OS の画面に出してよいかを返す。
# platformOnly に載っていないオプションは両 OS で出す。載っていれば、値が Platform と同じときだけ出す。
function Test-PlatformOption {
    param(
        [Parameter(Mandatory)][object]$Action,
        [Parameter(Mandatory)][string]$OptionName,
        [string]$Platform = $script:GuiPlatform
    )
    if ($null -eq $Action.PSObject.Properties['platformOnly']) { return $true }
    $platformOnly = $Action.platformOnly # この Action の OS 専用オプション（オプション名 → OS 名）。
    if ($null -eq $platformOnly) { return $true }
    # 説明データの platformOnly は多くが {}（項目なし）のため、.PSObject.Properties.Name ではなく Properties[名前] で調べる（StrictMode で例外にしない）。
    if ($null -eq $platformOnly.PSObject.Properties[$OptionName]) { return $true }
    return ([string]$platformOnly.$OptionName -ceq $Platform)
}

# Action のカードに出すオプション名（kebab-case）を、JSON の並び順で出す。
# 出さないもの: この画面が決めるもの（指紋・-Service・追加系の -NoStart）、platformOnly で他の OS 専用のもの、
# CLI の param に無いもの（platformOnly と二重の安全策）。
function Get-VisibleOptionName {
    param(
        [Parameter(Mandatory)][string]$ActionKey,
        [Parameter(Mandatory)][object]$Action,
        [Parameter(Mandatory)][object]$CliParameters
    )
    $actionName = ConvertTo-PascalName -Name $ActionKey # CLI の Action 名。
    foreach ($optionName in @(Get-EntryList -Entry $Action -Name 'options')) {
        $optionText = [string]$optionName # オプション名（kebab-case）。
        if ($script:GuiManagedOptions -contains $optionText) { continue }
        if ($optionText -eq 'no-start' -and $script:ForcedNoStartActions -contains $actionName) { continue }
        if (-not (Test-PlatformOption -Action $Action -OptionName $optionText)) { continue }
        if (-not $CliParameters.Contains((ConvertTo-PascalName -Name $optionText))) { continue }
        $optionText
    }
}

# 欄の名前（kebab-case）を、CLI のパラメーター名（PascalCase）にする。CLI の param の名前と名前全体が一致したときだけ返す。
# 前方一致にはしない（pwsh は一意な前方一致もパラメーター名として受け付けるため、短い名前が別のパラメーターへ化けないようにする）。
# この画面が決めるパラメーター（Action・指紋・-Service）は、欄の名前の書き方を変えても（例: exposure-sha-256）受け付けない。
function Resolve-CliParameterName {
    param([Parameter(Mandatory)][string]$OptionName, [Parameter(Mandatory)][object]$CliParameters)
    if ($OptionName -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*\z') { throw "オプション名の形式が不正です: $OptionName" }
    $parameterName = ConvertTo-PascalName -Name $OptionName # CLI のパラメーター名。
    if ($script:GuiManagedParameters -contains $parameterName) { throw "この画面が決めるパラメーターは、欄の値やチェックとして渡せません: $parameterName" }
    if (@($CliParameters) -cnotcontains $parameterName) { throw "CLI に無いパラメーターです（名前全体の一致で照合）: $parameterName" }
    return $parameterName
}

# CLI の子プロセスへ渡す引数配列を組み立てる。1 要素ずつ追加し、1 つの文字列には連結しない。
# Values は kebab-case のオプション名 → 値（text・path・number）。値が空のものは出さない。
# Flags はオンになっている flag のオプション名。パラメーター名だけを出す。
# この画面が決めるオプション（指紋・-Service）はここでは受け付けない。パラメーター名は CLI の param と名前全体で照合する。
# ConsoleHelper を付けると、CliPath（この画面のスクリプト）を別コンソールの補助役として起動する形にする（-File の直後に -ConsoleHelper）。
# この画面が管理する子プロセス（ConsoleHelper なし）には -NonInteractive を付ける。窓を出さず入力も閉じるため、CLI が入力を求めたら
# 待ち続けずにエラーで終わらせる。別コンソールの補助役には付けない（その窓で CLI がキーや Tunnel ID の入力を受けるため）。
function New-CliArgumentList {
    param(
        [Parameter(Mandatory)][string]$CliPath,
        [Parameter(Mandatory)][string]$ActionName,
        [System.Collections.IDictionary]$Values = @{},
        [string[]]$Flags = @(),
        [object]$CliParameters = $script:Ui.CliParameters,
        [switch]$ConsoleHelper
    )
    if ($null -eq $CliParameters) { throw 'CLI のパラメーター一覧が読み込まれていません。' }
    if ($ActionName -cnotmatch '^[A-Z][A-Za-z]*\z') { throw "Action 名の形式が不正です: $ActionName" }
    $arguments = [System.Collections.Generic.List[string]]::new() # pwsh へ渡す引数。
    $arguments.Add('-NoLogo')
    $arguments.Add('-NoProfile')
    if (-not $ConsoleHelper) { $arguments.Add('-NonInteractive') }
    $arguments.Add('-File')
    $arguments.Add($CliPath)
    if ($ConsoleHelper) { $arguments.Add('-ConsoleHelper') }
    $arguments.Add('-Action')
    $arguments.Add($ActionName)
    foreach ($key in @($Values.Keys)) {
        $optionName = [string]$key # オプション名（kebab-case）。
        if ($script:GuiManagedOptions -contains $optionName) { throw "この画面が決めるオプションは値として渡せません: $optionName" }
        $value = [string]$Values[$key] # 渡す値。
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $parameterName = Resolve-CliParameterName -OptionName $optionName -CliParameters $CliParameters # CLI のパラメーター名。
        # 実行ボタンでも止めているが、どの経路からも - で始まる値を CLI へ渡さないよう、ここでも止める。
        if (Test-DashLeadingValue -Value $value) { throw "値が - で始まるため渡せません: $optionName" }
        # 制御文字・行区切り・双方向制御文字などを含む値は、表示と実際の値がずれるため渡さない（共通仕様 S1）。
        if (Test-ForbiddenCharacter -Text $value) { throw "値に制御文字・書式文字・行区切りが含まれるため渡せません: $optionName" }
        $arguments.Add('-' + $parameterName)
        $arguments.Add($value)
    }
    foreach ($flag in $Flags) {
        if ([string]::IsNullOrWhiteSpace($flag)) { continue }
        if ($script:GuiManagedOptions -contains $flag) { throw "この画面が決めるオプションはチェックとして渡せません: $flag" }
        $arguments.Add('-' + (Resolve-CliParameterName -OptionName $flag -CliParameters $CliParameters))
    }
    return , $arguments
}

# 承認ダイアログで利用者が承認した結果だけを受け取り、その指紋を引数配列へ加える。
# 指紋を引数に加える箇所は、この関数だけにする（利用者の操作なしに承認を済ませる経路を作らないため。静的試験が確かめる）。
function Add-ApprovedExposureArgument {
    param(
        # 呼び出し側の List へ直接追加するため、引数変換で写しが作られないよう [object] で受けて型を確かめる。
        [Parameter(Mandatory)][object]$ArgumentList,
        [Parameter(Mandatory)][object]$Approval
    )
    if ($ArgumentList -isnot [System.Collections.Generic.List[string]]) { throw '引数配列の型が想定と違います。' }
    # 真偽値でないもの（文字列 'True' など）は、比較で真と見なされうるため受け付けない。
    if ($null -eq $Approval.PSObject.Properties['ApprovedByUser'] -or $Approval.ApprovedByUser -isnot [bool] -or -not $Approval.ApprovedByUser) {
        throw '承認ダイアログで承認されていないため、指紋を渡しません。'
    }
    if ($null -eq $Approval.PSObject.Properties['Sha256'] -or $Approval.Sha256 -isnot [string]) { throw '承認した指紋がありません。' }
    $sha256 = $Approval.Sha256 # 利用者が承認した公開範囲の指紋。
    if ($sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw '承認した指紋の形式が不正です。' }
    $ArgumentList.Add('-ExposureSha256')
    $ArgumentList.Add($sha256)
}

# 引数 1 つを、Windows のコマンドライン規則（CommandLineToArgvW）で元どおりに読み戻せる形に引用する。
# 空でなく、空白・タブ・二重引用符を含まなければそのまま返す。そうでなければ二重引用符で囲み、
# 二重引用符の直前のバックスラッシュ列は 2 倍にしてから \" にし、末尾のバックスラッシュ列も 2 倍にする。
function ConvertTo-QuotedArgument {
    param([AllowEmptyString()][AllowNull()][string]$Argument)
    if ($null -eq $Argument) { $Argument = '' }
    if ($Argument.Length -gt 0 -and $Argument.IndexOfAny([char[]]@(' ', "`t", '"')) -lt 0) { return $Argument }
    $builder = [System.Text.StringBuilder]::new() # 引用した結果。
    [void]$builder.Append('"')
    $backslashCount = 0 # 直前に続いているバックスラッシュの数。
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq [char]'\') {
            $backslashCount++
            continue
        }
        if ($character -eq [char]'"') {
            # 二重引用符の直前のバックスラッシュ列は 2 倍にし、さらに 1 つ足して引用符そのものを \" にする。
            [void]$builder.Append('\' * ($backslashCount * 2 + 1))
            [void]$builder.Append('"')
        } else {
            # 二重引用符が続かないバックスラッシュ列は、そのまま残す。
            [void]$builder.Append('\' * $backslashCount)
            [void]$builder.Append($character)
        }
        $backslashCount = 0
    }
    # 末尾のバックスラッシュ列は、閉じる二重引用符の前で 2 倍にする。
    [void]$builder.Append('\' * ($backslashCount * 2))
    [void]$builder.Append('"')
    return $builder.ToString()
}

# 引数配列を、ConvertTo-QuotedArgument で 1 つずつ引用して空白で連結した 1 つの文字列にする（別コンソールの起動と表示用）。
function Join-CommandLine {
    param([AllowEmptyCollection()][string[]]$ArgumentList)
    $quoted = foreach ($argument in $ArgumentList) { ConvertTo-QuotedArgument -Argument $argument } # 引用済みの引数。
    return (@($quoted) -join ' ')
}

# ShowExposure の標準出力全体を JSON として読み、承認に使う項目が揃っているかを確かめて返す。読めなければ例外にする。
function ConvertFrom-ExposureReport {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    $trimmed = ([string]$Text).TrimStart([char]0xFEFF).Trim() # 先頭の BOM と前後の空白を除いた出力。
    if ($trimmed -eq '') { throw 'ShowExposure の出力が空です。' }
    $report = $trimmed | ConvertFrom-Json # 読み込んだ結果。
    if ($null -eq $report -or $report -is [array]) { throw 'ShowExposure の出力が JSON のオブジェクト 1 つではありません。' }
    foreach ($name in @('schemaVersion', 'projectRoot', 'profile', 'exposureSha256', 'approvalState', 'approvedSha256', 'exposure', 'changes')) {
        if ($null -eq $report.PSObject.Properties[$name]) { throw "ShowExposure の出力に $name がありません。" }
    }
    if ([string]$report.exposureSha256 -cnotmatch '^[0-9a-f]{64}\z') { throw '公開範囲の指紋の形式が不正です。' }
    if (@('approved', 'unapproved', 'changed') -cnotcontains [string]$report.approvalState) { throw "承認状態が想定外です: $($report.approvalState)" }
    # approvedProjectRoot（共通仕様 S4）は文字列か null。欄が無い古い CLI は null と同じに扱う。
    if ($null -ne $report.PSObject.Properties['approvedProjectRoot'] -and $null -ne $report.approvedProjectRoot -and $report.approvedProjectRoot -isnot [string]) { throw 'ShowExposure の approvedProjectRoot の型が不正です。' }
    return $report
}

# 承認状態（approved / unapproved / changed）を、画面に出す日本語にする。
function Get-ApprovalStateText {
    param([AllowEmptyString()][string]$State)
    switch ($State) {
        'approved' { return '承認済み' }
        'unapproved' { return '未承認' }
        'changed' { return '変更あり（前回の承認から公開範囲が変わった）' }
        default { return "不明（$($State)）" }
    }
}

# ---------------------------------------------------------------------------
# 表示の無害化（共通仕様 S1・S2）と、承認ダイアログの中身。画面を作らない純粋な処理（静的試験が Python へ写して突き合わせる）
# ---------------------------------------------------------------------------

# 文字列を 1 コードポイントずつ見て、共通仕様の規則で退避した文字列を返す（3 つの表示関数の共通部分）。
# Style が Quote なら S2 のとおり（二重引用符で囲み、\ と " を退避し、S1 の禁止文字と U+0020 以外の空白類を \u / \U にする）。
# Plain は Quote から引用符と \ " の退避を除いたもの（変更点の行のように、値が JSON の文字列として既に退避されているものに使う）。
# Log は S1 の禁止文字だけを \xNN（U+00FF まで）・\uXXXX・\UXXXXXXXX にする（ログ欄用。空白類と \ はそのまま）。
# サロゲートペアは [char]::ConvertToUtf32 で 1 コードポイントにまとめ、種類は CharUnicodeInfo で判定する（対にならないサロゲートは Surrogate）。
function Format-EscapedText {
    param(
        [AllowEmptyString()][AllowNull()][string]$Text,
        [Parameter(Mandatory)][ValidateSet('Quote', 'Plain', 'Log')][string]$Style
    )
    if ($null -eq $Text) { $Text = '' }
    $builder = [System.Text.StringBuilder]::new() # 組み立て中の文字列。
    if ($Style -eq 'Quote') { [void]$builder.Append('"') }
    $index = 0 # 見ている UTF-16 の位置。
    while ($index -lt $Text.Length) {
        $width = 1 # このコードポイントが占める UTF-16 の数。
        $codePoint = [int]$Text[$index] # このコードポイントの値（対にならないサロゲートはその値のまま）。
        if ([char]::IsSurrogatePair($Text, $index)) {
            $codePoint = [char]::ConvertToUtf32($Text, $index)
            $width = 2
        }
        $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($Text, $index) # Unicode の一般カテゴリ。
        $forbidden = $script:ForbiddenCategories -contains $category # S1 の禁止文字か。
        $otherSpace = ($category -eq [System.Globalization.UnicodeCategory]::SpaceSeparator) -and ($codePoint -ne 0x20) # U+0020 以外の空白類か。
        if ($Style -eq 'Quote' -and $codePoint -eq 0x5C) {
            [void]$builder.Append('\\')
        } elseif ($Style -eq 'Quote' -and $codePoint -eq 0x22) {
            [void]$builder.Append('\"')
        } elseif ($forbidden -or ($Style -ne 'Log' -and $otherSpace)) {
            if ($Style -eq 'Log' -and $codePoint -le 0xFF) {
                [void]$builder.Append('\x' + $codePoint.ToString('x2'))
            } elseif ($codePoint -le 0xFFFF) {
                [void]$builder.Append('\u' + $codePoint.ToString('x4'))
            } else {
                [void]$builder.Append('\U' + $codePoint.ToString('x8'))
            }
        } else {
            [void]$builder.Append($Text.Substring($index, $width))
        }
        $index += $width
    }
    if ($Style -eq 'Quote') { [void]$builder.Append('"') }
    return $builder.ToString()
}

# 値を画面へ出す形にする（共通仕様 S2。Node の quoteForDisplay、Python の quote_for_display と同じ出力）。
function ConvertTo-DisplayQuoted {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    return (Format-EscapedText -Text $Text -Style Quote)
}

# 引用符を付けずに、S1 の禁止文字と U+0020 以外の空白類だけを \u / \U にする（既に JSON として退避された値に使う）。
function ConvertTo-DisplayEscaped {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    return (Format-EscapedText -Text $Text -Style Plain)
}

# ログ欄・タイトル・一覧へ出す 1 行を無害化する（S1 の禁止文字を \xNN / \uXXXX / \UXXXXXXXX にする。改行も含む）。
function ConvertTo-SafeLogLine {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    return (Format-EscapedText -Text $Text -Style Log)
}

# 文字列に S1 の禁止文字（制御・書式・行区切り・段落区切り・対にならないサロゲート）が 1 つでも含まれるかを返す。
function Test-ForbiddenCharacter {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    for ($index = 0; $index -lt $Text.Length; $index++) {
        $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($Text, $index) # Unicode の一般カテゴリ（ペアならまとめた値）。
        if ($script:ForbiddenCategories -contains $category) { return $true }
        if ([char]::IsSurrogatePair($Text, $index)) { $index++ }
    }
    return $false
}

# パスの 1 区切り（/ と \ で分けたもの）の中に、ラテン文字とキリル文字（またはギリシャ文字）が混ざっているかを返す（同形異字の疑い）。
# .NET には文字名の表が無いため、文字種は符号位置の範囲で決める（Ubuntu 版の文字名による判定の近似。印を付けるだけで承認は止めない）:
# ラテン文字 A-Z・a-z・U+00C0〜U+02AF（× ÷ を除く）・U+1E00〜U+1EFF・U+2C60〜U+2C7F・U+A720〜U+A7FF、
# キリル文字 U+0400〜U+052F・U+1C80〜U+1C8F・U+A640〜U+A69F、ギリシャ文字 U+0370〜U+03FF・U+1F00〜U+1FFF。
function Test-MixedScriptText {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    foreach ($segment in $Text.Split([char[]]@('/', '\'))) {
        $hasLatin = $false # ラテン文字があるか。
        $hasCyrillic = $false # キリル文字があるか。
        $hasGreek = $false # ギリシャ文字があるか。
        foreach ($character in $segment.ToCharArray()) {
            $code = [int]$character # 文字の符号位置。
            if (($code -ge 0x41 -and $code -le 0x5A) -or ($code -ge 0x61 -and $code -le 0x7A) -or ($code -ge 0xC0 -and $code -le 0x2AF -and $code -ne 0xD7 -and $code -ne 0xF7) -or ($code -ge 0x1E00 -and $code -le 0x1EFF) -or ($code -ge 0x2C60 -and $code -le 0x2C7F) -or ($code -ge 0xA720 -and $code -le 0xA7FF)) {
                $hasLatin = $true
            } elseif (($code -ge 0x400 -and $code -le 0x52F) -or ($code -ge 0x1C80 -and $code -le 0x1C8F) -or ($code -ge 0xA640 -and $code -le 0xA69F)) {
                $hasCyrillic = $true
            } elseif (($code -ge 0x370 -and $code -le 0x3FF) -or ($code -ge 0x1F00 -and $code -le 0x1FFF)) {
                $hasGreek = $true
            }
        }
        if ($hasLatin -and ($hasCyrillic -or $hasGreek)) { return $true }
    }
    return $false
}

# 値を S2 で引用し、後ろに Suffix を付ける。同形異字の疑いがあれば、さらに印を付ける。
function Format-DisplayValue {
    param([AllowEmptyString()][AllowNull()][string]$Text, [string]$Suffix = '')
    $display = (ConvertTo-DisplayQuoted -Text $Text) + $Suffix # 表示する文字列。
    if (Test-MixedScriptText -Text $Text) { $display += $script:MixedScriptMark }
    return $display
}

# 長い 1 行を、最大 Width 文字ずつの行に分ける（一覧の 1 項目が極端に長くならないように）。続きの行の先頭には印を付ける。
# サロゲートペアの途中では分けない。Width 以下ならそのまま 1 行を返す。
function Split-DisplayLine {
    param([AllowEmptyString()][AllowNull()][string]$Text, [int]$Width = $script:DisplayLineWidth)
    if ($null -eq $Text) { $Text = '' }
    if ($Width -lt 2) { $Width = 2 }
    if ($Text.Length -le $Width) { return $Text }
    $position = 0 # 次の行の始まり。
    $isFirst = $true # 最初の行か。
    while ($position -lt $Text.Length) {
        $length = [Math]::Min($Width, $Text.Length - $position) # この行の文字数。
        if (($position + $length) -lt $Text.Length -and [char]::IsHighSurrogate($Text[$position + $length - 1])) { $length-- }
        $piece = $Text.Substring($position, $length) # この行の文字列。
        if ($isFirst) { $piece } else { $script:ContinuationMark + $piece }
        $isFirst = $false
        $position += $length
    }
}

# 承認済みとして承認ダイアログを省いてよいかを返す。
# 承認状態が approved で、かつ承認済みの指紋が現在の指紋と完全に一致する（大文字小文字も区別する）ときだけ $true。
function Test-ExposureApproved {
    param([Parameter(Mandatory)][object]$Report)
    $state = Get-EntryValue -Entry $Report -Name 'approvalState' # 承認状態。
    $approvedSha = Get-EntryValue -Entry $Report -Name 'approvedSha256' # 承認済みの指紋。
    $currentSha = Get-EntryValue -Entry $Report -Name 'exposureSha256' # 現在の指紋。
    if ($state -isnot [string] -or $state -cne 'approved') { return $false }
    if ($approvedSha -isnot [string] -or $currentSha -isnot [string]) { return $false }
    return ($approvedSha -ceq $currentSha)
}

# 承認ダイアログの見出しに出す承認状態の文。approved なのに指紋が一致しないときは、その旨を出す。
function Get-ApprovalHeaderStateText {
    param([Parameter(Mandatory)][object]$Report)
    $state = Get-EntryText -Entry $Report -Name 'approvalState' # 承認状態。
    if ($state -ceq 'approved' -and -not (Test-ExposureApproved -Report $Report)) { return '承認済みと報告されましたが、承認済みの指紋が現在の指紋と一致しません（内容を確かめて承認し直してください）' }
    return (Get-ApprovalStateText -State $state)
}

# 公開されるプロジェクトルート（サーバーが正規化した exposure.projectRoot）を返す。無ければ CLI が解決した projectRoot。
function Get-ExposureRootValue {
    param([Parameter(Mandatory)][object]$Report)
    $exposureRoot = Get-EntryValue -Entry (Get-EntryValue -Entry $Report -Name 'exposure') -Name 'projectRoot' # サーバーが正規化したルート。
    if ($exposureRoot -is [string]) { return $exposureRoot }
    return (Get-EntryText -Entry $Report -Name 'projectRoot')
}

# 見出しと一覧に出すプロジェクトルートの文。CLI が解決した projectRoot が公開されるルートと違えば、それも引用して添える。
# 違いは序数（Ordinal。1 文字ずつの符号の比較）で見る。-cne はカルチャの比較で、NFC と NFD・ゼロ幅文字だけの違いを同じと見なすため使わない。
function Get-ApprovalRootText {
    param([Parameter(Mandatory)][object]$Report)
    $root = Get-ExposureRootValue -Report $Report # 公開されるルート。
    $text = 'プロジェクトルート: ' + (Format-DisplayValue -Text $root) # 表示する文。
    $cliRoot = Get-EntryValue -Entry $Report -Name 'projectRoot' # CLI が解決したルート。
    if ($cliRoot -is [string] -and -not [string]::Equals($cliRoot, $root, [System.StringComparison]::Ordinal)) { $text += '（CLI が示したフォルダー: ' + (ConvertTo-DisplayQuoted -Text $cliRoot) + '）' }
    return $text
}

# 承認すると別のフォルダーの承認を上書きするか（共通仕様 S4）を返す。
# 承認状態が changed で、前回の承認に記録されたフォルダー（approvedProjectRoot）が null でなく、今回のフォルダーのどれとも違うとき $true。
# 今回のフォルダーは、CLI が解決した projectRoot と、サーバーが正規化した exposure.projectRoot（承認ファイルと同じ表記）の両方を見る（Ubuntu 版と同じ）。
# Windows の NTFS は通常、大文字小文字を区別しないため、大文字小文字だけが違うものは同じフォルダーとして比べる（OrdinalIgnoreCase）。
# -inotcontains などのカルチャの比較は使わない（NFC と NFD・ゼロ幅文字の有無・ケルビン記号 U+212A と K を同じと見なし、別のフォルダーを同じとして警告を出さないため）。
# 承認の指紋の照合は完全一致のまま（指紋には projectRoot が入るため、承認の対象は完全一致で縛られる）。
# 欄が無い古い CLI は null と同じ。approvedProjectRoot が文字列でない（形式が想定外）ときは、安全側（上書きの確認を求める）に倒す。
function Test-ForeignApprovalOverwrite {
    param([Parameter(Mandatory)][object]$Report)
    if ((Get-EntryText -Entry $Report -Name 'approvalState') -cne 'changed') { return $false }
    $approvedRoot = Get-EntryValue -Entry $Report -Name 'approvedProjectRoot' # 前回の承認に記録されたフォルダー。
    if ($null -eq $approvedRoot) { return $false }
    if ($approvedRoot -isnot [string]) { return $true }
    $currentRoots = @(
        (Get-EntryValue -Entry $Report -Name 'projectRoot'),
        (Get-EntryValue -Entry (Get-EntryValue -Entry $Report -Name 'exposure') -Name 'projectRoot')
    ) | Where-Object { $_ -is [string] } # 今回のフォルダー（文字列のものだけ）。
    foreach ($currentRoot in @($currentRoots)) {
        if ([string]::Equals($currentRoot, $approvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    return $true
}

# 公開範囲の主な欄の形（型）を確かめ、想定と違う欄の名前を返す（要約の件数・真偽値を構造から数える前提。Ubuntu 版と同じ規則）。
# projectRoot・contextFile・statusFile は文字列、allowFiles・denyDirectories は文字列の配列、allowDirectories は
# path（文字列）と recursive（真偽値）を持つオブジェクトの配列、maxDocumentBytes は 0 以上の整数、gitExposure は paths と commitSubjects（真偽値）。
# 1 つでもあれば承認できない。List[string] を返す。
function Get-ExposureShapeProblem {
    param([Parameter(Mandatory)][object]$Report)
    $problems = [System.Collections.Generic.List[string]]::new() # 形が想定と違う欄。
    $exposure = Get-EntryValue -Entry $Report -Name 'exposure' # 公開範囲。
    if ($exposure -isnot [System.Management.Automation.PSCustomObject]) {
        $problems.Add('公開範囲（exposure）')
        return , $problems
    }
    # 公開範囲の欄の名前。名前全体を序数（大文字小文字も区別）で照合する（-ccontains はカルチャの比較で、ゼロ幅文字などだけが違う名前を同じと見なすため）。
    # 項目が 1 つも無い {} でも例外にしないよう、.PSObject.Properties.Name ではなく、項目を 1 つずつ読む。
    $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($property in $exposure.PSObject.Properties) { [void]$names.Add([string]$property.Name) }
    foreach ($name in @('projectRoot', 'contextFile', 'statusFile')) {
        if (-not $names.Contains($name) -or $exposure.$name -isnot [string]) { $problems.Add((Get-ExposureFieldLabel -Name $name) + '（' + $name + '）') }
    }
    foreach ($name in @('allowFiles', 'denyDirectories')) {
        $isValid = $names.Contains($name) -and $exposure.$name -is [System.Collections.IList] # 文字列の配列か。
        if ($isValid) {
            foreach ($item in $exposure.$name) {
                if ($item -isnot [string]) { $isValid = $false }
            }
        }
        if (-not $isValid) { $problems.Add((Get-ExposureFieldLabel -Name $name) + '（' + $name + '）') }
    }
    $directoriesValid = $names.Contains('allowDirectories') -and $exposure.allowDirectories -is [System.Collections.IList] # 規則の配列か。
    if ($directoriesValid) {
        foreach ($rule in $exposure.allowDirectories) {
            if ($rule -isnot [System.Management.Automation.PSCustomObject] -or (Get-EntryValue -Entry $rule -Name 'path') -isnot [string] -or (Get-EntryValue -Entry $rule -Name 'recursive') -isnot [bool]) { $directoriesValid = $false }
        }
    }
    if (-not $directoriesValid) { $problems.Add((Get-ExposureFieldLabel -Name 'allowDirectories') + '（allowDirectories）') }
    $limit = Get-EntryValue -Entry $exposure -Name 'maxDocumentBytes' # 文書 1 件の上限。
    if (-not (($limit -is [int] -or $limit -is [long]) -and $limit -ge 0)) { $problems.Add((Get-ExposureFieldLabel -Name 'maxDocumentBytes') + '（maxDocumentBytes）') }
    $git = Get-EntryValue -Entry $exposure -Name 'gitExposure' # Git 情報の公開設定。
    if ($git -isnot [System.Management.Automation.PSCustomObject] -or (Get-EntryValue -Entry $git -Name 'paths') -isnot [bool] -or (Get-EntryValue -Entry $git -Name 'commitSubjects') -isnot [bool]) { $problems.Add((Get-ExposureFieldLabel -Name 'gitExposure') + '（gitExposure）') }
    # 2.5.0 の詳細取得ツールの公開設定（ソースの本文・差分の抜粋・ブランチ名）。省略されていれば無効（検査しない）。
    $detail = Get-EntryValue -Entry $exposure -Name 'detailExposure' # 詳細取得ツールの公開設定（JSON object）。
    if ($null -ne $detail) {
        $detailValid = $detail -is [System.Management.Automation.PSCustomObject]
        if ($detailValid) {
            foreach ($name in @('sourceText', 'branchNames', 'diffExcerpts')) {
                if ((Get-EntryValue -Entry $detail -Name $name) -isnot [bool]) { $detailValid = $false }
            }
        }
        if (-not $detailValid) { $problems.Add((Get-ExposureFieldLabel -Name 'detailExposure') + '（detailExposure）') }
    }
    # 2.6.0 のソース読み取り範囲を広げる設定。省略されていれば広げない（検査しない）。
    # 配列は Get-EntryValue では受け取らない（要素が 1 つだけの配列を関数の戻り値にすると、PowerShell が配列を外して値そのものにしてしまうため）。
    # allowFiles・denyDirectories と同じく、PSObject.Properties で項目の有無を確かめたうえで直接読む。
    $scope = Get-EntryValue -Entry $exposure -Name 'sourceScope' # ソース読み取り範囲を広げる設定（JSON object）。
    if ($null -ne $scope) {
        $scopeValid = $scope -is [System.Management.Automation.PSCustomObject]
        if ($scopeValid) {
            $scopeNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal) # $scope の項目名。
            foreach ($property in $scope.PSObject.Properties) { [void]$scopeNames.Add([string]$property.Name) }
            $scopeValid = $scopeNames.Contains('additionalDirectories') -and $scope.additionalDirectories -is [System.Collections.IList]
            if ($scopeValid) {
                foreach ($item in $scope.additionalDirectories) {
                    if ($item -isnot [string]) { $scopeValid = $false }
                }
            }
        }
        if ($scopeValid) {
            $scopeValid = $scopeNames.Contains('logDirectories') -and $scope.logDirectories -is [System.Collections.IList]
            if ($scopeValid) {
                foreach ($rule in $scope.logDirectories) {
                    if ($rule -isnot [System.Management.Automation.PSCustomObject] -or (Get-EntryValue -Entry $rule -Name 'path') -isnot [string] -or (Get-EntryValue -Entry $rule -Name 'recursive') -isnot [bool]) { $scopeValid = $false }
                }
            }
        }
        if (-not $scopeValid) { $problems.Add((Get-ExposureFieldLabel -Name 'sourceScope') + '（sourceScope）') }
    }
    # 2.7.0 のClaude Codeのジョブ実行を許可する設定。省略されていれば無効（検査しない）。
    $claudeCode = Get-EntryValue -Entry $exposure -Name 'claudeCode' # Claude Codeのジョブ実行を許可する設定（JSON object）。
    if ($null -ne $claudeCode) {
        $claudeCodeValid = $claudeCode -is [System.Management.Automation.PSCustomObject]
        if ($claudeCodeValid) {
            $claudeCodeNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal) # $claudeCode の項目名。
            foreach ($property in $claudeCode.PSObject.Properties) { [void]$claudeCodeNames.Add([string]$property.Name) }
            $claudeCodeValid = $claudeCodeNames.Contains('enabled') -and $claudeCode.enabled -is [bool]
        }
        if ($claudeCodeValid) {
            $claudeCodeValid = $claudeCodeNames.Contains('allowedCommands') -and $claudeCode.allowedCommands -is [System.Collections.IList]
            if ($claudeCodeValid) {
                foreach ($item in $claudeCode.allowedCommands) {
                    if ($item -isnot [string]) { $claudeCodeValid = $false }
                }
            }
        }
        if ($claudeCodeValid) {
            $claudeModel = Get-EntryValue -Entry $claudeCode -Name 'model' # 使うモデル（null のことがある）。
            $claudeCodeValid = ($null -eq $claudeModel -or $claudeModel -is [string])
        }
        if ($claudeCodeValid) {
            $claudeEffort = Get-EntryValue -Entry $claudeCode -Name 'effort' # 思考の強さ（null のことがある）。
            $claudeCodeValid = ($null -eq $claudeEffort -or $claudeEffort -is [string])
        }
        if ($claudeCodeValid) {
            $claudeMinutes = Get-EntryValue -Entry $claudeCode -Name 'maxMinutes' # 1 ジョブの制限時間（分）。
            $claudeCodeValid = ($claudeMinutes -is [int] -or $claudeMinutes -is [long])
        }
        if ($claudeCodeValid) {
            $claudeBudget = Get-EntryValue -Entry $claudeCode -Name 'maxBudgetUsd' # 推定コストの上限（null のことがある）。
            $claudeCodeValid = ($null -eq $claudeBudget -or $claudeBudget -is [int] -or $claudeBudget -is [long] -or $claudeBudget -is [double] -or $claudeBudget -is [decimal])
        }
        if (-not $claudeCodeValid) { $problems.Add((Get-ExposureFieldLabel -Name 'claudeCode') + '（claudeCode）') }
    }
    return , $problems
}

# 承認できない理由の文を返す（禁止文字・公開範囲の形の崩れ）。空なら承認できる。赤字で一覧の下に出す。
function Get-ApprovalBlockReason {
    param([AllowEmptyCollection()][string[]]$ForbiddenField = @(), [AllowEmptyCollection()][string[]]$ShapeProblem = @())
    if ($ForbiddenField.Count -gt 0) {
        $shownCount = [Math]::Min(3, $ForbiddenField.Count) # 赤字に並べる項目の数（全件は一覧の先頭）。
        $reason = '設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。該当項目: ' + ($ForbiddenField[0..($shownCount - 1)] -join '、') # 禁止文字の理由。
        if ($ForbiddenField.Count -gt $shownCount) { $reason += "、ほか $($ForbiddenField.Count - $shownCount) 件（全件は一覧の先頭）" }
        $reason
    }
    if ($ShapeProblem.Count -gt 0) {
        '公開範囲の形式が想定と違うため承認できません（件数を構造から確かめられません）。該当する欄: ' + ($ShapeProblem -join '、')
    }
}

# 値（JSON から読んだ入れ子の値）をたどり、S1 の禁止文字を含む文字列を「項目名 = 引用した値」の形で Found へ加える。
# オブジェクトは項目名も調べる。配列は [番号]、オブジェクトは .項目名 で項目名をつなぐ。入れ子が深すぎるものは確かめられないとして加える。
function Add-ForbiddenField {
    param(
        [AllowNull()][object]$Value,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Found,
        [int]$Depth = 0
    )
    if ($null -eq $Value) { return }
    if ($Depth -gt 16) {
        $Found.Add($Path + '（入れ子が深すぎるため確かめられません）')
        return
    }
    if ($Value -is [string]) {
        if (Test-ForbiddenCharacter -Text $Value) { $Found.Add($Path + ' = ' + (ConvertTo-DisplayQuoted -Text $Value)) }
        return
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            $propertyName = [string]$property.Name # 項目名。
            $childPath = $Path + '.' + (ConvertTo-DisplayEscaped -Text $propertyName) # 子の項目名。
            if (Test-ForbiddenCharacter -Text $propertyName) { $Found.Add($childPath + '（項目名）') }
            Add-ForbiddenField -Value $property.Value -Path $childPath -Found $Found -Depth ($Depth + 1)
        }
        return
    }
    if ($Value -is [System.Collections.IList]) {
        for ($itemIndex = 0; $itemIndex -lt $Value.Count; $itemIndex++) {
            Add-ForbiddenField -Value $Value[$itemIndex] -Path ($Path + '[' + $itemIndex + ']') -Found $Found -Depth ($Depth + 1)
        }
    }
}

# 承認ダイアログに出す値のうち、S1 の禁止文字を含むものの一覧を返す（1 つでもあれば承認できない）。
# 対象は projectRoot・profile・exposure（入れ子の全ての文字列と項目名）・changes。List[string] を返す。
function Get-ForbiddenFieldList {
    param([Parameter(Mandatory)][object]$Report)
    $found = [System.Collections.Generic.List[string]]::new() # 禁止文字を含む項目。
    foreach ($name in @('projectRoot', 'profile', 'exposure', 'changes')) {
        if ($null -eq $Report.PSObject.Properties[$name]) { continue }
        Add-ForbiddenField -Value $Report.$name -Path $name -Found $found -Depth 0
    }
    return , $found
}

# 承認ダイアログの固定の要約を、構造化データ（配列の長さ・真偽値）から作る。値の文字列からは作らない。
function Get-ApprovalSummary {
    param([Parameter(Mandatory)][object]$Report)
    $exposure = Get-EntryValue -Entry $Report -Name 'exposure' # 公開範囲。
    $files = @(Get-EntryList -Entry $exposure -Name 'allowFiles') # 明示許可ファイル。
    $directories = @(Get-EntryList -Entry $exposure -Name 'allowDirectories') # 明示許可ディレクトリ。
    $recursiveCount = @($directories | Where-Object { Test-EntryNotFalse -Entry $_ -Name 'recursive' }).Count # 配下すべてのディレクトリの数。
    $denied = @(Get-EntryList -Entry $exposure -Name 'denyDirectories') # 拒否ディレクトリ。
    $git = Get-EntryValue -Entry $exposure -Name 'gitExposure' # Git 情報の公開設定。
    $gitPathsPublic = Test-EntryNotFalse -Entry $git -Name 'paths' # Git のファイル名を公開するか。
    $gitSubjectsPublic = Test-EntryNotFalse -Entry $git -Name 'commitSubjects' # Git のコミット件名を公開するか。
    $gitPathsWord = if ($gitPathsPublic) { '公開' } else { '非公開' } # Git のファイル名の表示。
    $gitSubjectsWord = if ($gitSubjectsPublic) { '公開' } else { '非公開' } # Git のコミット件名の表示。
    $limitText = [string](Get-EntryValue -Entry $exposure -Name 'maxDocumentBytes') # 文書 1 件の上限。
    if ($limitText -cnotmatch '^[0-9]{1,12}\z') { $limitText = ConvertTo-DisplayQuoted -Text $limitText }
    return [pscustomobject]@{
        AllowFileCount = $files.Count
        AllowDirectoryCount = $directories.Count
        RecursiveDirectoryCount = $recursiveCount
        DenyDirectoryCount = $denied.Count
        GitPathsPublic = $gitPathsPublic
        GitCommitSubjectsPublic = $gitSubjectsPublic
        CountLine = "公開ファイル $($files.Count) 件 / 公開ディレクトリ $($directories.Count) 件（うち配下すべて $($recursiveCount) 件） / 拒否ディレクトリ $($denied.Count) 件"
        GitPathsText = 'Git のファイル名: ' + $gitPathsWord
        GitCommitSubjectsText = 'Git のコミット件名: ' + $gitSubjectsWord
        LimitLine = "文書 1 件の上限: $($limitText) バイト"
        ShaLine = '公開範囲の指紋（SHA-256）: ' + (Get-EntryText -Entry $Report -Name 'exposureSha256')
    }
}

# 公開範囲の項目名（識別子）に対応する日本語の名前。知らない項目名は空文字。
function Get-ExposureFieldLabel {
    param([AllowEmptyString()][string]$Name)
    switch -CaseSensitive ($Name) {
        'projectRoot' { return 'プロジェクトルート' }
        'contextFile' { return '概要文書' }
        'statusFile' { return '状態文書' }
        'allowFiles' { return '公開ファイル' }
        'allowDirectories' { return '公開ディレクトリ' }
        'denyDirectories' { return '拒否ディレクトリ' }
        'maxDocumentBytes' { return '文書 1 件の上限' }
        'gitExposure' { return 'Git の公開設定' }
        'detailExposure' { return '詳細取得ツールの公開設定' }
        'sourceScope' { return 'ソース読み取り範囲の公開設定' }
        'claudeCode' { return 'Claude Code のジョブ' }
        default { return '' }
    }
}

# CLI の changes の 1 件（「項目名: 前 -> 後」。前と後は JSON）を、「日本語の名前（識別子）: 前 -> 後」にする。
# 前と後の値は JSON として退避済みのため、引用はせず、S1 の禁止文字と U+0020 以外の空白類だけを \u にする。
function Get-ExposureChangeText {
    param([AllowEmptyString()][AllowNull()][string]$Change)
    $changeMatch = [regex]::Match([string]$Change, '\A([A-Za-z]+): (.*)\z', [System.Text.RegularExpressions.RegexOptions]::Singleline) # 項目名と値に分けた結果。
    if (-not $changeMatch.Success) { return '内容: ' + (ConvertTo-DisplayEscaped -Text $Change) }
    $fieldName = $changeMatch.Groups[1].Value # 項目名（識別子）。
    $label = Get-ExposureFieldLabel -Name $fieldName # 日本語の名前。
    if ($label -eq '') { $label = '不明な項目' }
    return $label + '（' + $fieldName + '）: ' + (ConvertTo-DisplayEscaped -Text $changeMatch.Groups[2].Value)
}

# 承認ダイアログの一覧（ListBox。1 行 1 項目）に出す行を、構造化データから作る。省略しない。
# 並び: 承認できない項目（あれば）→ 形が想定と違う欄（あれば）→ 前回の承認から変わった項目（changed のとき）→ 対象 →
# 公開ファイル → 公開ディレクトリ → 拒否ディレクトリ → 詳細取得ツールの公開設定（detailExposure があれば）→
# ソース読み取り範囲（sourceScope があれば）→ Claude Code のジョブ（claudeCode があれば）→ その他の項目（あれば）→ Git・上限 → 指紋 → 末尾の印。
# 値は S2 で引用し、番号を付ける。長い行は Split-DisplayLine で分ける。List[string] を返す。
function Get-ApprovalDetailLine {
    param(
        [Parameter(Mandatory)][object]$Report,
        [AllowEmptyCollection()][string[]]$ForbiddenField = @(),
        [AllowEmptyCollection()][string[]]$ShapeProblem = @()
    )
    $exposure = Get-EntryValue -Entry $Report -Name 'exposure' # 公開範囲。
    $lines = [System.Collections.Generic.List[string]]::new() # 分ける前の行。
    if ($ForbiddenField.Count -gt 0) {
        $lines.Add("【承認できない項目】$($ForbiddenField.Count) 件（制御文字・行区切り・双方向制御文字・不可視文字を含むため、偽装の可能性があります）")
        $number = 0 # 項目の番号。
        foreach ($field in $ForbiddenField) {
            $number++
            $lines.Add("  $($number). $($field)")
        }
        $lines.Add('')
    }
    if ($ShapeProblem.Count -gt 0) {
        $lines.Add("【形式が想定と違う欄】$($ShapeProblem.Count) 件（件数を構造から確かめられないため、承認できません）")
        $number = 0
        foreach ($problem in $ShapeProblem) {
            $number++
            $lines.Add("  $($number). $($problem)")
        }
        $lines.Add('')
    }
    if ((Get-EntryText -Entry $Report -Name 'approvalState') -ceq 'changed') {
        $changes = @(Get-EntryList -Entry $Report -Name 'changes') # 前回承認との差分。
        $lines.Add("【前回の承認から変わった項目】$($changes.Count) 件")
        if ($changes.Count -eq 0) { $lines.Add('  （差分を取得できませんでした。全項目を確認してください）') }
        $number = 0
        foreach ($change in $changes) {
            $number++
            $lines.Add("  $($number). " + (Get-ExposureChangeText -Change ([string]$change)))
        }
        $lines.Add('')
    }
    $lines.Add('【対象】')
    $lines.Add('  ' + (Get-ApprovalRootText -Report $Report))
    $lines.Add('  プロファイル（承認の保存先の名前）: ' + (Format-DisplayValue -Text (Get-EntryText -Entry $Report -Name 'profile')))
    $lines.Add('  概要文書（contextFile）: ' + (Format-DisplayValue -Text (Get-EntryText -Entry $exposure -Name 'contextFile')))
    $lines.Add('  状態文書（statusFile）: ' + (Format-DisplayValue -Text (Get-EntryText -Entry $exposure -Name 'statusFile')))
    $lines.Add('')
    $files = @(Get-EntryList -Entry $exposure -Name 'allowFiles') # 明示許可ファイル。
    $lines.Add("【公開ファイル】$($files.Count) 件")
    if ($files.Count -eq 0) { $lines.Add('  （なし）') }
    $number = 0
    foreach ($file in $files) {
        $number++
        $lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$file)))
    }
    $lines.Add('')
    $directories = @(Get-EntryList -Entry $exposure -Name 'allowDirectories') # 明示許可ディレクトリ。
    $lines.Add("【公開ディレクトリ（Markdown だけ）】$($directories.Count) 件")
    if ($directories.Count -eq 0) { $lines.Add('  （なし）') }
    $number = 0
    foreach ($rule in $directories) {
        $number++
        $scope = if (Test-EntryNotFalse -Entry $rule -Name 'recursive') { '（配下すべて）' } else { '（直下だけ）' } # 対象の深さ。
        $lines.Add("  $($number). " + (Format-DisplayValue -Text (Get-EntryText -Entry $rule -Name 'path') -Suffix $scope))
    }
    $lines.Add('')
    $denied = @(Get-EntryList -Entry $exposure -Name 'denyDirectories') # 拒否ディレクトリ。
    $lines.Add("【拒否ディレクトリ】$($denied.Count) 件")
    if ($denied.Count -eq 0) { $lines.Add('  （なし）') }
    $number = 0
    foreach ($deniedDirectory in $denied) {
        $number++
        $lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$deniedDirectory)))
    }
    $lines.Add('')
    # 2.5.0 の詳細取得ツールの公開設定（ソースの本文・差分の抜粋・ブランチ名）。設定が無ければ出さない。
    $detailExposure = Get-EntryValue -Entry $exposure -Name 'detailExposure' # 詳細取得ツールの公開設定（JSON object）。
    if ($detailExposure -is [System.Management.Automation.PSCustomObject]) {
        $lines.Add('【詳細取得ツールの公開設定】')
        $lines.Add("  ソースの本文（sourceText）: $(if (Test-EntryNotFalse -Entry $detailExposure -Name 'sourceText') { '公開' } else { '非公開' })")
        $lines.Add("  差分の抜粋（diffExcerpts）: $(if (Test-EntryNotFalse -Entry $detailExposure -Name 'diffExcerpts') { '公開' } else { '非公開' })")
        $lines.Add("  ブランチ名（branchNames）: $(if (Test-EntryNotFalse -Entry $detailExposure -Name 'branchNames') { '公開' } else { '非公開' })")
        $lines.Add('')
    }
    # 2.6.0 のソース読み取り範囲を広げる設定。設定が無ければ出さない。
    $sourceScope = Get-EntryValue -Entry $exposure -Name 'sourceScope' # ソース読み取り範囲を広げる設定（JSON object）。
    if ($sourceScope -is [System.Management.Automation.PSCustomObject]) {
        $scopeAdditional = @(Get-EntryList -Entry $sourceScope -Name 'additionalDirectories') # 既定除外のうち明示的に開けるディレクトリ。
        $lines.Add("【追加で開けるディレクトリ】$($scopeAdditional.Count) 件")
        if ($scopeAdditional.Count -eq 0) { $lines.Add('  （なし）') }
        $number = 0
        foreach ($scopeDirectory in $scopeAdditional) {
            $number++
            $lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$scopeDirectory)))
        }
        $lines.Add('')
        $scopeLogs = @(Get-EntryList -Entry $sourceScope -Name 'logDirectories' | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] }) # read_test_log が読んでよい場所。
        $lines.Add("【ログの読み取り場所】$($scopeLogs.Count) 件")
        if ($scopeLogs.Count -eq 0) { $lines.Add('  （なし）') }
        $number = 0
        foreach ($rule in $scopeLogs) {
            $number++
            $logScope = if (Test-EntryNotFalse -Entry $rule -Name 'recursive') { '（配下すべて）' } else { '（直下だけ）' } # 対象の深さ。
            $lines.Add("  $($number). " + (Format-DisplayValue -Text (Get-EntryText -Entry $rule -Name 'path') -Suffix $logScope))
        }
        $lines.Add('')
    }
    # 2.7.0 のClaude Codeのジョブ実行を許可する設定。設定が無ければ出さない。
    $claudeCode = Get-EntryValue -Entry $exposure -Name 'claudeCode' # Claude Codeのジョブ実行を許可する設定（JSON object）。
    if ($claudeCode -is [System.Management.Automation.PSCustomObject]) {
        $claudeEnabled = Test-EntryNotFalse -Entry $claudeCode -Name 'enabled' # ChatGPTからClaude Codeのジョブ実行を許可するか。
        $lines.Add("【Claude Code のジョブ】$(if ($claudeEnabled) { '有効' } else { '無効' })")
        if ($claudeEnabled) {
            $lines.Add('警告: この承認で、ChatGPT から Claude Code を起動し、このプロジェクトの作業ツリーのファイルを書き換えさせ、次のコマンドを確認なしで実行させられるようになります（git の commit・push はできません。Claude Code の利用枠を消費します）。許可したコマンドがプロジェクト内のスクリプトを実行する場合、Claude Code はそのスクリプトを書き換えてから実行できるため、実質的に任意のコードを実行できます。')
        }
        $claudeCommands = @(Get-EntryList -Entry $claudeCode -Name 'allowedCommands') # 確認なしで実行してよいコマンド。
        if ($claudeCommands.Count -gt 0) {
            $lines.Add("コマンドの実行（$($claudeCommands.Count) 件。確認なしで実行できます）:")
            $number = 0
            foreach ($command in $claudeCommands) {
                $number++
                $lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$command)))
            }
        } else {
            $lines.Add('コマンドの実行: なし（ファイルの編集だけ）')
        }
        $claudeModelValue = Get-EntryValue -Entry $claudeCode -Name 'model' # 使うモデル（null のことがある）。
        $claudeModelText = if ($claudeModelValue -is [string]) { ConvertTo-DisplayQuoted -Text $claudeModelValue } else { '（指定なし）' } # 使うモデルの表示。
        $claudeEffortValue = Get-EntryValue -Entry $claudeCode -Name 'effort' # 思考の強さ（null のことがある）。
        $claudeEffortText = if ($claudeEffortValue -is [string]) { ConvertTo-DisplayQuoted -Text $claudeEffortValue } else { '（指定なし）' } # 思考の強さの表示。
        $lines.Add("model: $claudeModelText / effort: $claudeEffortText")
        $claudeBudgetValue = Get-EntryValue -Entry $claudeCode -Name 'maxBudgetUsd' # 推定コストの上限（null のことがある）。
        $claudeBudgetText = if ($null -ne $claudeBudgetValue) { '$' + (ConvertTo-DisplayEscaped -Text ([string]$claudeBudgetValue)) } else { '（指定なし）' } # 推定コストの上限の表示。
        $lines.Add("制限時間: $(ConvertTo-DisplayEscaped -Text (Get-EntryText -Entry $claudeCode -Name 'maxMinutes')) 分 / 推定コストの上限: $claudeBudgetText")
        $lines.Add('')
    }
    # 上に出していない公開範囲の欄（将来の追加分）。名前と JSON の表記を、禁止文字と空白類を \u の形にして出す。
    # 名前は序数（大文字小文字も区別）で照合する（-cnotcontains はカルチャの比較で、無視される文字だけが違う名前を既知の欄と見なして隠すため）。
    # 項目が 1 つも無い {} でも例外にしないよう、.PSObject.Properties.Name ではなく、項目を 1 つずつ読む。
    $extraNames = @() # その他の欄の名前。
    if ($exposure -is [System.Management.Automation.PSCustomObject]) {
        $knownNames = [System.Collections.Generic.HashSet[string]]::new([string[]]$script:KnownExposureFields, [System.StringComparer]::Ordinal) # 個別に表示する欄の名前。
        $extraNames = @(foreach ($property in $exposure.PSObject.Properties) { if (-not $knownNames.Contains([string]$property.Name)) { [string]$property.Name } })
    }
    if ($extraNames.Count -gt 0) {
        $lines.Add("【その他の項目】$($extraNames.Count) 件")
        foreach ($extraName in $extraNames) {
            $extraJson = ConvertTo-Json -InputObject $exposure.$extraName -Depth 20 -Compress # 値の JSON の表記。
            $lines.Add('  - ' + (ConvertTo-DisplayEscaped -Text $extraName) + ': ' + (ConvertTo-DisplayEscaped -Text $extraJson))
        }
        $lines.Add('')
    }
    $summary = Get-ApprovalSummary -Report $Report # 件数・Git・上限・指紋。
    $lines.Add('【Git と文書の上限】')
    $lines.Add('  ' + $summary.GitPathsText + ' / ' + $summary.GitCommitSubjectsText)
    $lines.Add('  ' + $summary.LimitLine)
    $lines.Add('')
    $lines.Add('【公開範囲の指紋（SHA-256）】')
    $lines.Add('  ' + (Get-EntryText -Entry $Report -Name 'exposureSha256'))
    $lines.Add('（一覧はここまでです）')
    $result = [System.Collections.Generic.List[string]]::new() # 分けたあとの行。
    foreach ($line in $lines) {
        foreach ($piece in @(Split-DisplayLine -Text $line)) { $result.Add([string]$piece) }
    }
    return , $result
}

# 一覧（ListBox）を末尾まで表示したかを返す。見えている行数は ClientHeight / ItemHeight の切り捨て。
# TopIndex + 見えている行数 が行数以上なら末尾まで表示した。行が無ければ $true、行の高さが 0 以下なら $false（判定できない）。
function Test-ListScrolledToEnd {
    param([int]$TopIndex, [int]$ItemCount, [int]$ClientHeight, [int]$ItemHeight)
    if ($ItemCount -le 0) { return $true }
    if ($ItemHeight -le 0) { return $false }
    $visibleCount = [int][Math]::Floor($ClientHeight / $ItemHeight) # 全体が見えている行の数。
    return (($TopIndex + $visibleCount) -ge $ItemCount)
}

# 「この内容で承認」を押せるかを返す。禁止文字があれば常に押せない。
# 一覧を末尾まで表示して「内容を読みました」にチェックし、別フォルダーの承認を上書きする場合はその確認にもチェックしたときだけ押せる。
function Test-ApprovalAllowed {
    param([bool]$Blocked, [bool]$ReachedEnd, [bool]$ReadChecked, [bool]$NeedsOverwriteConfirm, [bool]$OverwriteChecked)
    if ($Blocked) { return $false }
    if (-not ($ReachedEnd -and $ReadChecked)) { return $false }
    if ($NeedsOverwriteConfirm -and -not $OverwriteChecked) { return $false }
    return $true
}

# ---------------------------------------------------------------------------
# 別のコンソール窓の補助役（-ConsoleHelper）の引数の検査。純粋な処理（静的試験が Python へ写して突き合わせる）
# ---------------------------------------------------------------------------

# 補助役の起動引数を確かめ、CLI へ渡す引数（名前 → 値。& で渡すための hashtable）を返す。合わなければ例外にする。
# 受け付けるのは、キーを聞く Action（SaveKey・AddProject・HubAdd）と、その Action で許すパラメーターだけ。
# 値は空でない文字列で、- で始まらず、S1 の禁止文字を含まないこと。指紋は 64 桁の小文字 16 進。追加系は -NoStart が必須。
function ConvertTo-ConsoleHelperSplat {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$BoundParameters)
    if (-not $BoundParameters.Contains('ConsoleHelper')) { throw '-ConsoleHelper がありません。' }
    if ($BoundParameters.Contains('StaRelaunched')) { throw '-ConsoleHelper と -StaRelaunched は同時に指定できません。' }
    $actionName = if ($BoundParameters.Contains('Action')) { $BoundParameters['Action'] } else { $null } # 実行する Action。
    if ($actionName -isnot [string] -or $script:KeyConsoleActions -cnotcontains $actionName) { throw "別のコンソール窓で実行できない Action です: $actionName" }
    $allowed = $script:ConsoleHelperParameters[$actionName] # この Action で許すパラメーター。
    $splat = @{ Action = $actionName } # CLI へ渡す引数。
    foreach ($key in @($BoundParameters.Keys)) {
        $name = [string]$key # パラメーター名。
        if ($name -ceq 'ConsoleHelper' -or $name -ceq 'Action') { continue }
        if ($allowed -cnotcontains $name) { throw "$($actionName) では使えないパラメーターです: $name" }
        $value = $BoundParameters[$key] # 指定された値。
        if ($script:ConsoleHelperSwitches -ccontains $name) {
            if ($value -is [System.Management.Automation.SwitchParameter]) {
                $isOn = $value.IsPresent # チェックがオンか。
            } elseif ($value -is [bool]) {
                $isOn = $value
            } else {
                throw "チェックの値の形式が不正です: $name"
            }
            if ($isOn) { $splat[$name] = $true }
            continue
        }
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw "値が空か、文字列ではありません: $name" }
        if (Test-DashLeadingValue -Value $value) { throw "値が - で始まるため渡せません: $name" }
        if (Test-ForbiddenCharacter -Text $value) { throw "値に制御文字・書式文字・行区切りが含まれるため渡せません: $name" }
        if ($name -ceq 'ExposureSha256' -and $value -cnotmatch '^[0-9a-f]{64}\z') { throw '指紋の形式が不正です。' }
        $splat[$name] = $value
    }
    if ($script:ForcedNoStartActions -ccontains $actionName -and -not $splat.ContainsKey('NoStart')) { throw "$($actionName) には -NoStart が必要です（起動は管理画面の別のボタンで行います）。" }
    return $splat
}

# 管理画面として起動したときの引数を確かめる。受け付けるのは、STA で起動し直したことを示す -StaRelaunched だけ。
function Assert-GuiLaunchParameter {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$BoundParameters)
    foreach ($key in @($BoundParameters.Keys)) {
        if ([string]$key -cne 'StaRelaunched') { throw "管理画面は引数を受け付けません: -$($key)（-ConsoleHelper などは、この画面が別のコンソール窓を開くときだけ使います）" }
    }
}

# ---------------------------------------------------------------------------
# ログ欄の行の無害化。純粋な処理
# ---------------------------------------------------------------------------

# 複数行の文字列を行に分ける（CR LF と LF で分ける。単独の CR は分けずに残し、無害化で \x0d にする）。
function Split-LogText {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    if ($null -eq $Text) { $Text = '' }
    return ($Text -split "`r?`n")
}

# ログ欄に出す行を作る。行ごとに無害化し、LinePrefix（補助の子プロセスの印）と、CLI の出力なら固定の印（│ ）を先頭に付ける。
function Format-LogLine {
    param([AllowEmptyString()][AllowNull()][string]$Line, [string]$LinePrefix = '', [switch]$FromCli)
    $mark = if ($FromCli) { $script:CliOutputMark } else { '' } # CLI の出力の印。
    foreach ($piece in @(Split-LogText -Text $Line)) {
        $LinePrefix + $mark + (ConvertTo-SafeLogLine -Text $piece)
    }
}

# ハブ方式の影響範囲の警告を、hub-add の caution から引く（最初の 2 文）。取れなければ同じ趣旨の固定文を返す。
function Get-HubWarningText {
    param([Parameter(Mandatory)][object]$Help)
    $hubAdd = if ($null -ne $Help.actions.PSObject.Properties['hub-add']) { $Help.actions.'hub-add' } else { $null } # hub-add の説明。
    $caution = Get-EntryText -Entry $hubAdd -Name 'caution' # hub-add の注意。
    $sentences = @($caution -split '。' | Where-Object { $_.Trim() -ne '' } | Select-Object -First 2) # 先頭の 2 文。
    if ($sentences.Count -eq 0) { return 'ハブ方式では、このアプリを使うどのチャットからも、承認済みの全プロジェクトを読めます。' }
    return ((@($sentences | ForEach-Object { $_.Trim() + '。' })) -join '')
}

# ハブ設定 hub.json のパスを返す（CLI の Get-HubPath と同じ場所）。
function Get-HubConfigPath {
    return Join-Path $env:APPDATA 'chatgpt-project-bridge\hub.json'
}

# hub.json を読み取るだけで、登録プロジェクトの名前・フォルダー・承認ファイルを 1 件ずつ出す。
# ファイルが無ければ何も出さない（作らない・書かない）。
function Read-HubProjectList {
    param([Parameter(Mandatory)][string]$HubPath)
    if (-not (Test-Path -LiteralPath $HubPath -PathType Leaf)) { return }
    $hubItem = Get-Item -LiteralPath $HubPath -Force # ハブ設定ファイルの情報。
    if (($hubItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "ハブ設定にリンクやジャンクションは使用できません: $HubPath" }
    $hub = Get-Content -LiteralPath $HubPath -Raw -Encoding UTF8 | ConvertFrom-Json # 読み込んだハブ設定。
    foreach ($entry in @(Get-EntryList -Entry $hub -Name 'projects')) {
        [pscustomobject]@{
            Name = Get-EntryText -Entry $entry -Name 'name'
            Root = Get-EntryText -Entry $entry -Name 'root'
            ApprovalFile = Get-EntryText -Entry $entry -Name 'approvalFile'
        }
    }
}

# ハブ登録の承認ファイル名から、承認に使うプロファイル名を求める（CLI の Start-HubTunnel と同じ求め方）。形式が合わなければ空文字。
function Get-HubApprovalProfileName {
    param([AllowEmptyString()][string]$ApprovalFile)
    if ([string]::IsNullOrWhiteSpace($ApprovalFile)) { return '' }
    $profileName = [System.IO.Path]::GetFileNameWithoutExtension($ApprovalFile) # 承認ファイル名から求めたプロファイル名。
    if ($profileName -cnotmatch '^[a-z0-9][a-z0-9._-]{0,62}\z') { return '' }
    return $profileName
}

# CLI（Get-ApprovalPath）が承認を書く標準の場所。CLI は常にこの場所へ書くため、ハブ登録の承認ファイルがここと違うと、
# この画面から承認してもサーバーが読む承認ファイルと食い違う。
function Get-StandardHubApprovalPath {
    param([Parameter(Mandatory)][string]$ProfileName)
    return Join-Path $env:APPDATA "chatgpt-project-bridge\approvals\$ProfileName.json"
}

# ハブ登録の承認ファイルが、CLI が承認を書く標準の場所と一致するかを返す（大文字小文字は区別しない。Windows のパスのため）。
# 一致しないプロファイル名（空文字）は、この時点で false になる。
function Test-HubApprovalFileStandard {
    param([AllowEmptyString()][string]$ApprovalFile, [AllowEmptyString()][string]$ProfileName)
    if ([string]::IsNullOrWhiteSpace($ProfileName)) { return $false }
    return [string]::Equals([string]$ApprovalFile, (Get-StandardHubApprovalPath -ProfileName $ProfileName), [System.StringComparison]::OrdinalIgnoreCase)
}

# ---------------------------------------------------------------------------
# ハブの稼働表示と、分かっている値の自動入力。どれも読み取りだけ（何も書かず、子プロセスを起動せず、通信もしない）
# ---------------------------------------------------------------------------

# Tunnel ID の形式（tunnel_ に 32 桁の小文字 16 進数が続く。CLI と同じ）に合うかを返す。
function Test-HubTunnelId {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    return ([string]$Value -cmatch '^tunnel_[0-9a-f]{32}\z')
}

# プロファイル名の形式（CLI の Assert-ProfileName と同じ）に合うかを返す。合うものだけを PID ファイルの名前に使う。
function Test-HubProfileName {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    return ([string]$Value -cmatch '^[a-z0-9][a-z0-9._-]{0,62}\z')
}

# hub.json を読み取るだけで、Tunnel ID・プロファイル名・登録件数を返す。ファイルが無ければ $null を返す（作らない・書かない）。
# Read-HubProjectList と同じ安全策（リンクやジャンクションは読まない）。最上位がオブジェクトでなければ例外にする。
# Tunnel ID とプロファイル名は、形式に合わなければ空文字にする（合わない値を画面にもパスにも使わないため）。
function Read-HubSummary {
    param([Parameter(Mandatory)][string]$HubPath)
    if (-not (Test-Path -LiteralPath $HubPath -PathType Leaf)) { return $null }
    $hubItem = Get-Item -LiteralPath $HubPath -Force # ハブ設定ファイルの情報。
    if (($hubItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "ハブ設定にリンクやジャンクションは使用できません: $HubPath" }
    $hub = Get-Content -LiteralPath $HubPath -Raw -Encoding UTF8 | ConvertFrom-Json # 読み込んだハブ設定。
    if ($hub -isnot [System.Management.Automation.PSCustomObject]) { throw "ハブ設定の形式が不正です（最上位がオブジェクトではありません）: $HubPath" }
    $tunnelId = Get-EntryText -Entry $hub -Name 'tunnelId' # 記録された Tunnel ID。
    $profileName = Get-EntryText -Entry $hub -Name 'profileName' # ハブ用のプロファイル名。
    return [pscustomobject]@{
        TunnelId = if (Test-HubTunnelId -Value $tunnelId) { $tunnelId } else { '' }
        ProfileName = if (Test-HubProfileName -Value $profileName) { $profileName } else { '' }
        ProjectCount = @(Get-EntryList -Entry $hub -Name 'projects').Count
    }
}

# Tunnel Client が書く PID ファイルのパスを返す（%APPDATA%\tunnel-client\runtime\<プロファイル名>.pid。CLI の Start-ProfileTunnel が --pid.file で渡す場所）。
# プロファイル名は、形式に合うものだけを受け付ける（パスの区切りなどを含む名前で、ほかのファイルを指さないため）。
function Get-HubPidFilePath {
    param([Parameter(Mandatory)][string]$ProfileName)
    if (-not (Test-HubProfileName -Value $ProfileName)) { throw "プロファイル名の形式が不正です: $(ConvertTo-DisplayQuoted -Text $ProfileName)" }
    return Join-Path (Join-Path $env:APPDATA 'tunnel-client\runtime') ($ProfileName + '.pid')
}

# PID ファイルの中身から PID を求める。前後の空白と改行を除いて数字だけ（1〜9 桁）のときにその数を返し、それ以外は 0 を返す。
function ConvertTo-HubProcessId {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    $trimmed = ([string]$Text).Trim() # 前後の空白と改行を除いた中身。
    if ($trimmed -cnotmatch '^[0-9]{1,9}\z') { return 0 }
    return [int]$trimmed
}

# PID ファイルを読み取るだけで、PID を返す。ファイルが無い・リンクやジャンクションである・大きすぎる（64 バイト超）・数字だけでないときは 0 を返す。
function Read-HubProcessId {
    param([Parameter(Mandatory)][string]$PidPath)
    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return 0 }
    $pidItem = Get-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue # PID ファイルの情報（調べる間に消えたら $null）。
    if ($null -eq $pidItem) { return 0 }
    if (($pidItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 0 }
    if ($pidItem.Length -gt 64) { return 0 }
    return (ConvertTo-HubProcessId -Text ([string](Get-Content -LiteralPath $PidPath -Raw -Encoding UTF8)))
}

# プロセスの名前とコマンドラインから、このハブ（ProfileName）の Tunnel Client かを返す。画面もプロセスも見ない純粋な判定。
# CLI の Start-ProfileTunnel と同じ照合: 名前が tunnel-client で、コマンドラインに「--profile <プロファイル名>」があり、その直後が空白か末尾（大文字小文字は区別しない）。
# ProcessName は拡張子の無い名前（Get-Process の ProcessName）。コマンドラインを取れなかったとき（空文字）は、名前だけで決める。
function Test-HubProcessMatch {
    param(
        [AllowEmptyString()][AllowNull()][string]$ProcessName,
        [AllowEmptyString()][AllowNull()][string]$CommandLine,
        [Parameter(Mandatory)][string]$ProfileName
    )
    if (-not [string]::Equals([string]$ProcessName, 'tunnel-client', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $true }
    # CLI の正規表現の末尾は (?:\s|$)。$ が \z と違うのは末尾の改行の手前だけで、そこは \s が受けるため、\z と書いても同じ意味になる。
    $pattern = '--profile\s+' + [regex]::Escape($ProfileName) + '(?:\s|\z)' # このハブの Tunnel Client を見分ける引数。
    return [regex]::IsMatch($CommandLine, $pattern, ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant))
}

# プロセス 1 つのコマンドラインを、PID を指定して WMI（Win32_Process）に問い合わせて返す（読み取りだけ。全プロセスは列挙しない）。
# プロセスが無ければ $null、コマンドラインを読めなければ空文字を返す。時間がかかるため、Test-HubProcessRunning が PID の変わったときだけ呼ぶ。
function Get-ProcessCommandLine {
    param([Parameter(Mandatory)][int]$ProcessId)
    $processInfo = $null # WMI が返したプロセスの情報。
    try {
        $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($ProcessId)" -Property ProcessId, CommandLine -ErrorAction Stop
    } catch {
        return ''
    }
    if ($null -eq $processInfo) { return $null }
    return [string](@($processInfo)[0].CommandLine)
}

# PID のプロセスが、このハブ（ProfileName）の Tunnel Client として動いているかを返す（読み取りだけ）。
# 3 秒ごとに呼ばれるため、毎回見るのは PID のプロセスの有無と名前だけにする。コマンドラインの問い合わせ（WMI）は、
# PID・開始時刻・プロファイル名の組が前回と変わったときだけ行い、結果を $script:Ui.HubProbe に覚える（全プロセスの列挙はしない）。
function Test-HubProcessRunning {
    param([int]$ProcessId, [Parameter(Mandatory)][string]$ProfileName)
    if ($ProcessId -le 0) { return $false }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue # PID のプロセス（無ければ $null）。
    if ($null -eq $process) { return $false }
    $processName = '' # プロセスの名前（拡張子なし）。
    $startMark = '' # 開始時刻（PID の使い回しを見分けるため。読めなければ空文字）。
    try {
        $processName = [string]$process.ProcessName
        try { $startMark = [string]$process.StartTime.Ticks } catch { $startMark = '' }
    } catch {
        # 名前を読む前に終わったプロセスは、動いていないものとして扱う。
        return $false
    } finally {
        $process.Dispose()
    }
    if (-not (Test-HubProcessMatch -ProcessName $processName -CommandLine '' -ProfileName $ProfileName)) { return $false }
    $probeKey = "$($ProcessId)|$($startMark)|$($ProfileName)" # 確かめるプロセスを表す組。
    $probe = $script:Ui.HubProbe # 前回確かめた結果。
    if ($null -ne $probe -and [string]::Equals([string]$probe.ProbeKey, $probeKey, [System.StringComparison]::Ordinal)) { return [bool]$probe.IsMatch }
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId # コマンドライン（プロセスが無ければ $null、読めなければ空文字）。
    if ($null -eq $commandLine) { return $false }
    $isMatch = [bool](Test-HubProcessMatch -ProcessName $processName -CommandLine $commandLine -ProfileName $ProfileName) # このハブの Tunnel Client か。
    $script:Ui.HubProbe = @{ ProbeKey = $probeKey; IsMatch = $isMatch }
    return $isMatch
}

# ハブ（Tunnel Client）の稼働を、読み取りだけで調べて返す（hub.json・PID ファイル・その PID のプロセス。子プロセスを起動せず、通信もしない）。
# State は Running（実行中）・Stopped（停止中）・Unset（未設定）・Unknown（確認できません）。例外は外へ出さず、Unknown の理由（Reason）にする。
function Get-HubRunState {
    $status = [ordered]@{ State = 'Unknown'; ProcessId = 0; TunnelId = ''; ProfileName = ''; ProjectCount = 0; Reason = '' } # 調べた結果。
    try {
        $summary = Read-HubSummary -HubPath (Get-HubConfigPath) # ハブ設定の要点（hub.json が無ければ $null）。
        if ($null -eq $summary -or [string]::IsNullOrEmpty($summary.TunnelId)) {
            $status.State = 'Unset'
        } else {
            $status.TunnelId = [string]$summary.TunnelId
            $status.ProfileName = [string]$summary.ProfileName
            $status.ProjectCount = [int]$summary.ProjectCount
            if ([string]::IsNullOrEmpty($summary.ProfileName)) {
                $status.Reason = 'ハブ設定（hub.json）のプロファイル名（profileName）が無いか、形式が正しくないため、稼働を確かめられません。'
            } else {
                $processId = Read-HubProcessId -PidPath (Get-HubPidFilePath -ProfileName $summary.ProfileName) # PID ファイルの PID（無ければ 0）。
                if (Test-HubProcessRunning -ProcessId $processId -ProfileName $summary.ProfileName) {
                    $status.State = 'Running'
                    $status.ProcessId = $processId
                } else {
                    $status.State = 'Stopped'
                }
            }
        }
    } catch {
        $status.State = 'Unknown'
        $status.Reason = [string]$_.Exception.Message
    }
    return [pscustomobject]$status
}

# 稼働の状態（Get-HubRunState の結果）から、画面の上の帯に出す 2 つの文（状態・詳細）を作る。画面を作らない純粋な処理。
# hub.json 由来の値と例外の文は、ConvertTo-SafeLogLine で無害化してから出す。文は Ubuntu 版と同じ。IsRunning は実行中か（文字色を決める）。
function Get-HubStatusText {
    param([Parameter(Mandatory)][object]$Status)
    $state = [string]$Status.State # 稼働の状態。
    $summaryText = 'Tunnel ID: ' + (ConvertTo-SafeLogLine -Text ([string]$Status.TunnelId)) + ' / プロファイル: ' + (ConvertTo-SafeLogLine -Text ([string]$Status.ProfileName)) + ' / 登録 ' + [string][int]$Status.ProjectCount + ' 件' # Tunnel ID・プロファイル名・登録件数。
    if ([string]::Equals($state, 'Running', [System.StringComparison]::Ordinal)) {
        return [pscustomobject]@{ StateText = "ハブ: ● 実行中（PID $([int]$Status.ProcessId)）"; DetailText = $summaryText; IsRunning = $true }
    }
    if ([string]::Equals($state, 'Stopped', [System.StringComparison]::Ordinal)) {
        return [pscustomobject]@{ StateText = 'ハブ: ○ 停止中'; DetailText = $summaryText + '。「ハブを起動」で起動します。'; IsRunning = $false }
    }
    if ([string]::Equals($state, 'Unset', [System.StringComparison]::Ordinal)) {
        return [pscustomobject]@{ StateText = 'ハブ: 未設定'; DetailText = 'Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。'; IsRunning = $false }
    }
    $reasonLines = @(Split-LogText -Text ([string]$Status.Reason) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { ConvertTo-SafeLogLine -Text $_.Trim() }) # 理由の行（空の行は除く）。
    $reasonText = if ($reasonLines.Count -gt 0) { $reasonLines -join ' ' } else { '理由を取得できませんでした。' } # 確認できない理由。
    return [pscustomobject]@{ StateText = 'ハブ: 確認できません'; DetailText = $reasonText; IsRunning = $false }
}

# 入力欄を、同じオプション名の欄と値を共有してよいかを返す（$script:UnsharedInputOptions に載っている欄は共有しない）。
function Test-SharedInputOption {
    param([Parameter(Mandatory)][string]$ActionName, [Parameter(Mandatory)][string]$OptionName)
    if (-not $script:UnsharedInputOptions.ContainsKey($ActionName)) { return $true }
    return (@($script:UnsharedInputOptions[$ActionName]) -cnotcontains $OptionName)
}

# tunnel-client.exe を、CLI の Find-TunnelClient と同じ順番で探して、フルパスを返す（読み取りだけ。見つからなければ空文字）。
# 順番: PATH（Get-Command tunnel-client）、%LOCALAPPDATA%\ChatGPTProjectBridge\bin、%LOCALAPPDATA%\OpenAI\tunnel-client、%USERPROFILE%\Tools\tunnel-client。
function Find-TunnelClientPath {
    $command = Get-Command -Name 'tunnel-client' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 # PATH で見つかった tunnel-client。
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) { return [string]$command.Source }
    $candidates = [System.Collections.Generic.List[string]]::new() # 既知の候補（CLI と同じ並び）。
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'ChatGPTProjectBridge\bin\tunnel-client.exe'))
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'OpenAI\tunnel-client\tunnel-client.exe'))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $candidates.Add((Join-Path $env:USERPROFILE 'Tools\tunnel-client\tunnel-client.exe')) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).ProviderPath }
    }
    return ''
}

# 自動入力で欄を書き換えてよいかを返す（純粋な判定）。Current は欄のいまの値、Candidate は入れたい値、LastFilled は前回この処理が入れた値。
# 書き換えるのは、欄が空（空白だけも含む）のときか、前回この処理が入れた値のままのときだけ。利用者が入力した値は書き換えない。
# 入れたい値が空のとき・禁止文字（共通仕様 S1）を含むとき・- で始まるとき・欄が既に同じ値のときは、書き換えない。比較は序数で行う。
function Test-AutoFillAllowed {
    param(
        [AllowEmptyString()][AllowNull()][string]$Current,
        [AllowEmptyString()][AllowNull()][string]$Candidate,
        [AllowEmptyString()][AllowNull()][string]$LastFilled
    )
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    if (Test-ForbiddenCharacter -Text $Candidate) { return $false }
    if (Test-DashLeadingValue -Value $Candidate) { return $false }
    if ([string]::Equals([string]$Current, [string]$Candidate, [System.StringComparison]::Ordinal)) { return $false }
    if ([string]::IsNullOrWhiteSpace($Current)) { return $true }
    if ([string]::IsNullOrEmpty($LastFilled)) { return $false }
    return [string]::Equals([string]$Current, [string]$LastFilled, [System.StringComparison]::Ordinal)
}

# 必須の欄のうち空のもののラベルを出す。形式は確かめない（空かどうかだけ。それ以外の検査は CLI に任せる）。
function Get-MissingRequiredLabel {
    param(
        [Parameter(Mandatory)][object]$Help,
        [Parameter(Mandatory)][string]$ActionKey,
        [Parameter(Mandatory)][object]$Action,
        [System.Collections.IDictionary]$Values = @{}
    )
    foreach ($required in @(Get-EntryList -Entry $Action -Name 'required')) {
        $requiredName = [string]$required # 必須のオプション名。
        $value = if ($Values.Contains($requiredName)) { [string]$Values[$requiredName] } else { '' } # 入力された値。
        if (-not [string]::IsNullOrWhiteSpace($value)) { continue }
        $label = Get-EntryText -Entry (Get-OptionEntry -Help $Help -OptionName $requiredName) -Name 'label' # 欄の名前。
        if ($label -eq '') { $label = $requiredName }
        $label
    }
    # hub-remove は、フォルダーかハブ内の名前のどちらかが要る（両方空だと CLI は現在のフォルダーを対象にするため）。
    if ($ActionKey -eq 'hub-remove') {
        $rootValue = if ($Values.Contains('project-root')) { [string]$Values['project-root'] } else { '' } # フォルダー。
        $nameValue = if ($Values.Contains('hub-name')) { [string]$Values['hub-name'] } else { '' } # ハブ内の名前。
        if ([string]::IsNullOrWhiteSpace($rootValue) -and [string]::IsNullOrWhiteSpace($nameValue)) { 'プロジェクトのフォルダー または ハブ内の名前（どちらか 1 つ）' }
    }
}

# path の欄で開く選択画面の種類を返す: Folder（フォルダー）、SaveFile（保存先のファイル）、OpenFile（既存のファイル）。
function Get-PathDialogMode {
    param([Parameter(Mandatory)][string]$OptionName, [Parameter(Mandatory)][string]$ActionKey)
    if ($OptionName -eq 'project-root') { return 'Folder' }
    if ($OptionName -eq 'output-path') {
        if ($ActionKey -eq 'export-skill') { return 'SaveFile' }
        return 'Folder'
    }
    return 'OpenFile'
}

# ファイル選択画面の種類の絞り込み（Filter）を返す。
function Get-PathDialogFilter {
    param([Parameter(Mandatory)][string]$OptionName)
    switch ($OptionName) {
        'tunnel-client-path' { return 'tunnel-client.exe|tunnel-client.exe|実行ファイル (*.exe)|*.exe|すべてのファイル (*.*)|*.*' }
        'gh-path' { return 'gh.exe|gh.exe|実行ファイル (*.exe)|*.exe|すべてのファイル (*.*)|*.*' }
        'output-path' { return 'ZIP ファイル (*.zip)|*.zip' }
        default { return 'すべてのファイル (*.*)|*.*' }
    }
}

# パスの欄（kind が path）の値を、判定と CLI への引数の両方に使う形にする（足場の有無の判定と CLI が同じフォルダーを指すように）。
# 前後の空白を除き、全体を囲む二重引用符 1 組を外す（エクスプローラーの「パスのコピー」は前後に " を付けるため）。外したあとの前後の空白も除く。
# ~ だけ、または ~\ か ~/ で始まるときは、~ を HomePath（USERPROFILE）に置き換える（CLI の Resolve-Path は ~ をホームとして解決するため。
# Ubuntu 版も ~ をホームに展開してから CLI へ渡す）。~user のような形は置き換えない。比較はすべて序数で行う（カルチャの比較は不可視の文字を無視するため）。
function ConvertTo-InputPath {
    param([AllowEmptyString()][AllowNull()][string]$Text, [AllowEmptyString()][string]$HomePath = '')
    $value = ([string]$Text).Trim() # 前後の空白を除いた値。
    if ($value.Length -ge 2 -and $value.StartsWith([char]'"') -and $value.EndsWith([char]'"')) { $value = $value.Substring(1, $value.Length - 2).Trim() }
    if ([string]::IsNullOrWhiteSpace($HomePath)) { return $value }
    if ([string]::Equals($value, '~', [System.StringComparison]::Ordinal)) { return $HomePath }
    if ($value.StartsWith('~\', [System.StringComparison]::Ordinal) -or $value.StartsWith('~/', [System.StringComparison]::Ordinal)) { return (Join-Path $HomePath $value.Substring(2)) }
    return $value
}

# 値が - で始まるかを返す（先頭の半角空白・タブ・全角空白は飛ばして見る）。
# pwsh -File は、- で始まる引数をパラメーター名と見なすおそれがあるため、入口で止めるのに使う。
# - のほか、PowerShell が - と同じに扱うダッシュ（U+2013・U+2014・U+2015）も対象にする。
function Test-DashLeadingValue {
    param([AllowEmptyString()][AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    $trimmed = $Value.TrimStart([char[]]@(' ', "`t", [char]0x3000)) # 先頭の空白を除いた値。
    if ($trimmed.Length -eq 0) { return $false }
    return ($script:DashCharacters -contains $trimmed.Substring(0, 1))
}

# 入力された値のうち、text・path の欄で - で始まるもののラベルを出す。数値と flag は対象外。
function Get-DashLeadingLabel {
    param(
        [Parameter(Mandatory)][object]$Help,
        [System.Collections.IDictionary]$Values = @{}
    )
    foreach ($key in @($Values.Keys)) {
        $optionName = [string]$key # オプション名。
        $option = Get-OptionEntry -Help $Help -OptionName $optionName # オプションの説明。
        $kind = Get-EntryText -Entry $option -Name 'kind' # 欄の種類。
        if ($kind -ne 'text' -and $kind -ne 'path') { continue }
        if (-not (Test-DashLeadingValue -Value ([string]$Values[$key]))) { continue }
        $label = Get-EntryText -Entry $option -Name 'label' # 欄の名前。
        if ($label -eq '') { $label = $optionName }
        $label
    }
}

# 実行ボタンを押せるかを、画面の状態から決める。
# 別のコンソール窓が開いている間は、何も書き換えない Action（$script:ReadOnlyActions）だけを押せる（hub.json・承認・キーを同時に変えないため）。
# 操作が無ければ押せる。操作の実行中は、前面の子プロセスが動いている間に限り、読み取りだけの短い Action（補助）だけを押せる。
# 補助の子プロセスは同時に 1 つまで（動いている間は、補助の Action を押せない）。
function Test-RunButtonEnabled {
    param(
        [Parameter(Mandatory)][string]$ActionName,
        [bool]$Busy,
        [bool]$ForegroundRunning,
        [bool]$AuxiliaryRunning,
        [bool]$ConsoleRunning
    )
    if ($ConsoleRunning -and $script:ReadOnlyActions -notcontains $ActionName) { return $false }
    $isAuxiliary = $script:AuxiliaryActions -contains $ActionName # 補助として実行できる Action か。
    if ($isAuxiliary -and $AuxiliaryRunning) { return $false }
    if (-not $Busy) { return $true }
    return ($isAuxiliary -and $ForegroundRunning)
}

# 補助の子プロセスの出力の各行の先頭に付ける、Action 名の印（例: "[HubStatus] "）。
function Get-LogLinePrefix {
    param([Parameter(Mandatory)][string]$ActionName)
    return "[$($ActionName)] "
}

# ---------------------------------------------------------------------------
# 画面の部品づくり（WinForms を読み込んだあと、画面を作る関数からだけ呼ぶ）
# ---------------------------------------------------------------------------

# WinForms のコントロールを作る唯一の入口。説明（ツールチップ）を必ず付ける。
# 説明を付けないのは、配置だけを受け持つコンテナー（LayoutOnly）に限る。説明は上限で切り、表示幅で折り返してから付ける（Ubuntu 版と同じ幅）。
function New-GuiControl {
    param(
        [Parameter(Mandatory)][string]$TypeName,
        [AllowEmptyString()][string]$ToolTipText = '',
        [System.Collections.IDictionary]$Property = @{},
        [switch]$LayoutOnly
    )
    if ($LayoutOnly) {
        if ($script:LayoutTypeNames -notcontains $TypeName) { throw "説明なしで作れるのは配置用のコンテナーだけです: $TypeName" }
    } elseif ([string]::IsNullOrWhiteSpace($ToolTipText)) {
        throw "説明（ツールチップ）の無いコントロールは作れません: $TypeName"
    }
    $control = New-Object -TypeName "System.Windows.Forms.$TypeName" # 作ったコントロール。
    foreach ($key in @($Property.Keys)) { $control.$key = $Property[$key] }
    if (-not $LayoutOnly) { $script:Ui.ToolTip.SetToolTip($control, (Get-WrappedToolTipText -Text (Limit-ToolTipText -Text $ToolTipText))) }
    return $control
}

# コントロール以外の部品（Form・ToolTip・Timer・ファイル選択ダイアログ）を作る入口。種類は決めた一覧に限る。
function New-GuiComponent {
    param(
        [Parameter(Mandatory)][string]$TypeName,
        [System.Collections.IDictionary]$Property = @{}
    )
    if ($script:ComponentTypeNames -notcontains $TypeName) { throw "この部品は作れません: $TypeName" }
    $component = New-Object -TypeName "System.Windows.Forms.$TypeName" # 作った部品。
    foreach ($key in @($Property.Keys)) { $component.$key = $Property[$key] }
    return $component
}

# ウィンドウを出す画面の作業領域（タスクバーを除いた範囲）を返す。Owner（親の画面）が表示済みならその画面（CenterParent と同じ）、
# 無ければマウスポインターのある画面（CenterScreen と同じ選び方）。
function Get-DisplayWorkingArea {
    param([object]$Owner)
    if ($null -ne $Owner -and $Owner.IsHandleCreated) { return [System.Windows.Forms.Screen]::FromControl($Owner).WorkingArea }
    return [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
}

# ウィンドウ（Form）の大きさと最小の大きさを、作業領域を超えないように縮める。表示する前に呼ぶ（位置は表示のときに StartPosition で中央へ置く）。
# この画面は DPI 対応を宣言しないため、表示倍率 125〜150% などでは Windows が拡大して表示し、既定の大きさが作業領域を超えて、
# 下端のボタンが隠れることがある。DPI 対応の宣言は既存の配置を大きく変えるおそれがあるため行わず、大きさだけを合わせる。
function Resize-FormToWorkingArea {
    param([Parameter(Mandatory)][object]$Form, [Parameter(Mandatory)][System.Drawing.Rectangle]$WorkingArea)
    $maxWidth = [Math]::Max(1, $WorkingArea.Width) # 作業領域の幅。
    $maxHeight = [Math]::Max(1, $WorkingArea.Height) # 作業領域の高さ。
    $minimum = $Form.MinimumSize # いまの最小の大きさ。
    $Form.MinimumSize = [System.Drawing.Size]::new([Math]::Min($minimum.Width, $maxWidth), [Math]::Min($minimum.Height, $maxHeight))
    $current = $Form.Size # いまの大きさ（枠とタイトルバーを含む）。
    if ($current.Width -gt $maxWidth -or $current.Height -gt $maxHeight) {
        $Form.Size = [System.Drawing.Size]::new([Math]::Min($current.Width, $maxWidth), [Math]::Min($current.Height, $maxHeight))
    }
}

# ログ欄の末尾へ 1 行（複数行の文字列も可）追加する。AppendText が末尾までスクロールする。長くなりすぎたら古い側を消す。
# ログ欄へ書く唯一の入口。全ての行を Format-LogLine で無害化する（CR・行区切り・双方向制御文字などで表示を偽れないようにする）。
# FromCli は CLI の出力の行で、先頭に固定の印（│ ）を付けて、この画面自身のお知らせと見分けられるようにする。
function Add-LogLine {
    param([AllowEmptyString()][AllowNull()][string]$Line, [string]$LinePrefix = '', [switch]$FromCli)
    $logBox = $script:Ui.LogBox # 出力ログ欄。
    if ($null -eq $logBox) { return }
    if ($logBox.TextLength -gt 400000) { $logBox.Text = $logBox.Text.Substring($logBox.TextLength - 200000) }
    foreach ($formatted in @(Format-LogLine -Line $Line -LinePrefix $LinePrefix -FromCli:$FromCli)) {
        $logBox.AppendText([string]$formatted + "`r`n")
    }
}

# 画面の処理で起きた例外をログ欄へ出す（イベントの処理から例外を外へ出さないため）。
function Write-GuiError {
    param([Parameter(Mandatory)][object]$ErrorRecord)
    $message = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception.Message } else { [string]$ErrorRecord } # 表示する内容。
    Add-LogLine "画面の処理でエラーが起きました: $($message)"
}

# 「実行されるコマンド」欄へ、起動するコマンドを表示用に整形して出す。実行にはこの文字列を使わない（別コンソールを除く）。
function Set-CommandDisplay {
    param([Parameter(Mandatory)][string]$FilePath, [AllowEmptyCollection()][string[]]$ArgumentList, [string]$LinePrefix = '')
    $commandText = Join-CommandLine -ArgumentList (@($FilePath) + @($ArgumentList)) # 表示する文字列。
    if ($null -ne $script:Ui.CommandBox) { $script:Ui.CommandBox.Text = ConvertTo-SafeLogLine -Text $commandText }
    Add-LogLine "$($LinePrefix)> $($commandText)"
}

# 子プロセスの終了コードと、その意味をログ欄の最後に出す。LinePrefix は補助の子プロセスの行頭の印。
function Write-ExitSummary {
    param([int]$ExitCode, [Parameter(Mandatory)][string]$Label, [switch]$StopRequested, [string]$LinePrefix = '')
    Add-LogLine "$($LinePrefix)終了コード $($ExitCode)（$($Label)）"
    if ($ExitCode -eq 0) {
        Add-LogLine ($LinePrefix + 'CLI の処理は成功しました（ChatGPT からの呼び出しの確認は別の段階です）')
        return
    }
    Add-LogLine ($LinePrefix + '失敗しました')
    if ($StopRequested) { Add-LogLine ($LinePrefix + '（「停止」の操作で終わらせたため、0 以外の終了コードになることがあります）') }
}

# 完了した ReadLineAsync の結果を返す。終わり（EOF）や読み取りの失敗では $null を返す。
function Receive-TaskLine {
    param([Parameter(Mandatory)][object]$Task)
    if ($Task.IsFaulted -or $Task.IsCanceled) { return $null }
    return $Task.Result
}

# CLI を、この画面が管理する子プロセスとして起動する。引数は ArgumentList に 1 つずつ渡す（文字列に連結しない）。
# 出力は UI スレッドのタイマーが ReadLineAsync の完了を調べて読む（.NET のイベントに PowerShell の処理を登録しない）。
# Kind は終了後の処理の名前、Context はその処理が使う値。CaptureOutput なら標準出力をログへ出さずに溜める（JSON を読むため）。
function Start-CliJob {
    param(
        [Parameter(Mandatory)][System.Collections.Generic.List[string]]$ArgumentList,
        [Parameter(Mandatory)][string]$Kind,
        [hashtable]$Context = @{},
        [switch]$CaptureOutput
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new() # 子プロセスの起動設定。
    $startInfo.FileName = $script:Ui.PwshPath
    foreach ($argument in $ArgumentList) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.WorkingDirectory = $script:Ui.WorkingDirectory
    $linePrefix = if ($Context.ContainsKey('LinePrefix')) { [string]$Context['LinePrefix'] } else { '' } # 補助の子プロセスの行頭の印。
    Set-CommandDisplay -FilePath $script:Ui.PwshPath -ArgumentList $ArgumentList.ToArray() -LinePrefix $linePrefix
    $process = [System.Diagnostics.Process]::Start($startInfo) # 起動した子プロセス。
    # 入力はすぐ閉じる。CLI が入力を求めても待ち続けない（キーや確認の入力はこの画面では受けない）。
    $process.StandardInput.Close()
    $job = @{
        Id = [guid]::NewGuid().ToString('N') # この子プロセスの識別子。
        Process = $process
        Kind = $Kind
        Context = $Context
        CaptureOutput = [bool]$CaptureOutput
        Output = [System.Text.StringBuilder]::new() # CaptureOutput のときに溜める標準出力。
        OutTask = $process.StandardOutput.ReadLineAsync() # 標準出力の次の 1 行を待つ処理。
        ErrTask = $process.StandardError.ReadLineAsync() # 標準エラー出力の次の 1 行を待つ処理。
        OutDone = $false
        ErrDone = $false
        Finished = $false # 終了後の処理を済ませたか。
        StopRequested = $false # 「停止」で止めたか。
        LinePrefix = $linePrefix # ログの各行の先頭に付ける印（補助の子プロセスだけ。本体は空）。
    } # 子プロセス 1 つ分の状態。
    $script:Ui.Jobs.Add($job)
    if (-not $script:Ui.Timer.Enabled) { $script:Ui.Timer.Start() }
    return $job
}

# 子プロセスの出力を、完了している分だけ読み進める。1 回に読む行数には上限を置く（画面を固めないため）。
function Read-CliJobOutput {
    param([Parameter(Mandatory)][hashtable]$Job)
    $budget = 500 # この回に読む残りの行数。
    while (-not $Job.OutDone -and $budget -gt 0 -and $Job.OutTask.IsCompleted) {
        $budget--
        $line = Receive-TaskLine -Task $Job.OutTask # 読めた 1 行。$null は終わり。
        if ($null -eq $line) {
            $Job.OutDone = $true
            break
        }
        if ($Job.CaptureOutput) { [void]$Job.Output.AppendLine($line) } else { Add-LogLine -Line $line -LinePrefix $Job.LinePrefix -FromCli }
        $Job.OutTask = $Job.Process.StandardOutput.ReadLineAsync()
    }
    while (-not $Job.ErrDone -and $budget -gt 0 -and $Job.ErrTask.IsCompleted) {
        $budget--
        $line = Receive-TaskLine -Task $Job.ErrTask # 読めた 1 行。$null は終わり。
        if ($null -eq $line) {
            $Job.ErrDone = $true
            break
        }
        Add-LogLine -Line $line -LinePrefix $Job.LinePrefix -FromCli
        $Job.ErrTask = $Job.Process.StandardError.ReadLineAsync()
    }
}

# タイマーの各 tick で、全ての子プロセスの出力を読み進め、終わったものの後処理をする。
function Update-CliJobState {
    if ($script:Ui.InTick) { return }
    $script:Ui.InTick = $true
    try {
        foreach ($job in @($script:Ui.Jobs.ToArray())) {
            Read-CliJobOutput -Job $job
            if (-not ($job.OutDone -and $job.ErrDone -and $job.Process.HasExited)) { continue }
            [void]$script:Ui.Jobs.Remove($job)
            $job.Finished = $true
            try {
                Complete-CliJob -Job $job
            } catch {
                Add-LogLine "$($job.LinePrefix)終了後の処理でエラーが起きました: $($_.Exception.Message)"
                if ($job.Kind -eq 'Auxiliary') {
                    Clear-AuxiliaryJob -Job $job
                } elseif (@('PermissionCheck', 'PermissionConfirm', 'PermissionApply') -contains $job.Kind) {
                    Clear-HubPermissionJob -Job $job
                } elseif ($job.Kind -ne 'HubStop') {
                    Complete-Flow
                }
            } finally {
                $job.Process.Dispose()
            }
        }
        Update-ConsoleState
    } finally {
        $script:Ui.InTick = $false
    }
    # 子プロセスも別のコンソール窓も無くなったら止める（別のコンソール窓の終わりもこのタイマーで調べるため）。
    if ($script:Ui.Jobs.Count -eq 0 -and $null -eq $script:Ui.ConsoleProcess) { $script:Ui.Timer.Stop() }
}

# 子プロセスがまだ動いているかを返す。
function Test-JobRunning {
    param([object]$Job)
    if ($null -eq $Job) { return $false }
    if ($Job.Finished) { return $false }
    return (-not $Job.Process.HasExited)
}

# 別のコンソール窓（補助役）がまだ開いているかを返す。状態を取得できなければ、開いていないとして扱う（Update-ConsoleState が記録を消す）。
function Test-ConsoleProcessRunning {
    $consoleProcess = $script:Ui.ConsoleProcess # 別のコンソール窓のプロセス。
    if ($null -eq $consoleProcess) { return $false }
    try {
        return (-not $consoleProcess.HasExited)
    } catch {
        return $false
    }
}

# 別のコンソール窓が終わったかを調べ、終わっていれば記録を消し、ボタンの状態と登録一覧を更新する。
function Update-ConsoleState {
    $consoleProcess = $script:Ui.ConsoleProcess # 別のコンソール窓のプロセス。
    if ($null -eq $consoleProcess) { return }
    $exited = $true # 終わったか。
    try {
        $exited = $consoleProcess.HasExited
    } catch {
        Add-LogLine "別のコンソール窓の状態を取得できませんでした（$($_.Exception.Message)）。終わったものとして扱います。"
    }
    if (-not $exited) { return }
    $exitText = '不明' # 終了コードの表示。
    try {
        $exitText = [string]$consoleProcess.ExitCode
    } catch {
        $exitText = '不明'
    }
    $script:Ui.ConsoleProcess = $null
    $consoleProcess.Dispose()
    Add-LogLine "別のコンソール窓が閉じました（終了コード $($exitText)。CLI の結果は、その窓に表示されていました）。登録一覧を読み直します。"
    Update-ButtonState
    Update-HubListView
}

# 子プロセスをプロセスツリーごと止める（従来方式の Tunnel Client や、ウィンドウを閉じるとき）。
function Stop-JobProcessTree {
    param([Parameter(Mandatory)][hashtable]$Job)
    $Job.StopRequested = $true
    try {
        if (-not $Job.Process.HasExited) { $Job.Process.Kill($true) }
    } catch {
        Add-LogLine "プロセスを止められませんでした: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 操作の流れ（実行ボタン → 足場 → 公開範囲の確認 → 承認 → CLI または別コンソール）
# ---------------------------------------------------------------------------

# 共通のお知らせを出す（主画面を親にしたモーダルのメッセージ）。
function Show-GuiMessage {
    param([Parameter(Mandatory)][string]$Text, [string]$Caption = 'ChatGPT Project Bridge 管理画面', [switch]$Warning)
    $icon = if ($Warning) { [System.Windows.Forms.MessageBoxIcon]::Warning } else { [System.Windows.Forms.MessageBoxIcon]::Information } # 表示するアイコン。
    [void][System.Windows.Forms.MessageBox]::Show($script:Ui.Form, $Text, $Caption, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

# カードの入力欄から、text・path・number の値を JSON の並び順で集める。number の 0 は未入力として扱う（CLI の既定も 0）。
# path の値は ConvertTo-InputPath で整える（前後の " を外し、~ をホームにする）。足場の判定にも CLI への引数にも、この値を使う。
function Get-CardValue {
    param([Parameter(Mandatory)][hashtable]$Card)
    $values = [ordered]@{} # オプション名 → 値。
    foreach ($optionName in $Card.ValueOrder) {
        $control = $Card.Inputs[$optionName] # 入力欄。
        if ($Card.Kinds[$optionName] -eq 'number') {
            if ($control.Value -ne 0) { $values[$optionName] = [string][int]$control.Value }
            continue
        }
        if ($Card.Kinds[$optionName] -eq 'path') {
            $values[$optionName] = ConvertTo-InputPath -Text ([string]$control.Text) -HomePath $env:USERPROFILE
            continue
        }
        $values[$optionName] = ([string]$control.Text).Trim()
    }
    return , $values
}

# カードのチェックボックスのうち、オンのもののオプション名を出す。
function Get-CardFlag {
    param([Parameter(Mandatory)][hashtable]$Card)
    foreach ($optionName in $Card.FlagOrder) {
        if ($Card.Inputs[$optionName].Checked) { $optionName }
    }
}

# 実行ボタン・停止ボタンの有効・無効を、実行中の操作に合わせる。
# 操作は同時に 1 つだけ。ただし前面の子プロセスが動いている間は、読み取りだけの短い Action を補助として 1 つまで実行できる。停止ボタンは常に使える。
# 別のコンソール窓が開いている間は、何も書き換えない Action 以外の「実行」を押せない。
function Update-ButtonState {
    $flow = $script:Ui.Flow # 実行中の操作。
    $busy = $null -ne $flow # 操作の実行中か。
    $foregroundRunning = $busy -and (Test-JobRunning -Job $flow.ForegroundJob) # 前面の子プロセスが動いているか。
    $auxiliaryRunning = $null -ne $script:Ui.AuxJob # 補助の子プロセスがあるか（終了後の処理が済むまで残す）。
    $consoleRunning = [bool](Test-ConsoleProcessRunning) # 別のコンソール窓が開いているか。
    foreach ($card in $script:Ui.Cards) {
        $card.RunButton.Enabled = Test-RunButtonEnabled -ActionName $card.ActionName -Busy $busy -ForegroundRunning $foregroundRunning -AuxiliaryRunning $auxiliaryRunning -ConsoleRunning $consoleRunning
        if ($null -eq $card.StopButton) { continue }
        $isOwner = $foregroundRunning -and ($flow.Card.ActionKey -eq $card.ActionKey) # このカードの処理が動いているか。
        $card.StopButton.Visible = $isOwner
        $card.StopButton.Enabled = $isOwner -and -not $flow.HubStopRunning
    }
    # 権限の確認は読み取り専用で、ほかの操作と並行してよい（進行中の権限の子プロセスがあるときだけ押せない）。
    # 権限の切り替えは、設定を書き換えるため、操作の実行中・補助の実行中・別のコンソール窓が開いている間・ほかの権限の処理が進行中は押せない。
    $permissionBusy = ($null -ne $script:Ui.PermissionJob) -or ($null -ne $script:Ui.PermissionToggle) # 権限の確認・切り替えが進行中か。
    if ($null -ne $script:Ui.PermissionCheckButton) { $script:Ui.PermissionCheckButton.Enabled = ($null -eq $script:Ui.PermissionJob) }
    $permissionToggleEnabled = (-not $permissionBusy) -and (-not $busy) -and (-not $consoleRunning) # 切り替えボタンを押せるか。
    if ($null -ne $script:Ui.PermissionSourceButton) { $script:Ui.PermissionSourceButton.Enabled = $permissionToggleEnabled }
    if ($null -ne $script:Ui.PermissionClaudeButton) { $script:Ui.PermissionClaudeButton.Enabled = $permissionToggleEnabled }
}

# 実行中の操作を終え、ボタンを元に戻す。操作が終わるたびに登録一覧も読み直す（Ubuntu 版の finish_job と同じ。hub.json は読むだけ）。
function Complete-Flow {
    $script:Ui.Flow = $null
    Update-ButtonState
    try {
        Update-HubListView
    } catch {
        Write-GuiError -ErrorRecord $_
    }
}

# 実行を始めるときに、そのカードの上書き系のチェック（force・force-reconfigure・replace-key）をオフに戻す（Ubuntu 版の reset_dangerous_checks と同じ）。
# 指定はこの 1 回の実行にだけ効く（成功・失敗とも、次の実行には持ち越さない）。CLI へ渡すチェックは、戻す前に集めておく（Invoke-ActionCard）。
# オフに戻すときは確認ダイアログを出さない（Confirm-DangerousOption はオンにしたときだけ確かめる）。
function Reset-DangerousOption {
    param([Parameter(Mandatory)][hashtable]$Card)
    foreach ($optionName in $Card.FlagOrder) {
        $option = Get-OptionEntry -Help $script:Ui.Help -OptionName $optionName # オプションの説明。
        if (-not (Test-EntryFlag -Entry $option -Name 'dangerous')) { continue }
        $checkBox = $Card.Inputs[$optionName] # 上書き系のチェック。
        if (-not $checkBox.Checked) { continue }
        $checkBox.Checked = $false
        Add-LogLine "「$(Get-EntryText -Entry $option -Name 'label')」は、この実行にだけ付けます（チェックはオフに戻しました）。"
    }
}

# カードの「実行」ボタン。必須欄が空、または値が - で始まるなら CLI を呼ばずに止め、Action の種類に合わせて流れを始める。
# 前面の子プロセスが動いている間に押せるのは、読み取りだけの短い Action（補助）だけ。
function Invoke-ActionCard {
    param([Parameter(Mandatory)][hashtable]$Card)
    $flow = $script:Ui.Flow # 実行中の操作。
    $busy = $null -ne $flow # 操作の実行中か。
    $consoleRunning = [bool](Test-ConsoleProcessRunning) # 別のコンソール窓が開いているか。
    $allowed = Test-RunButtonEnabled -ActionName $Card.ActionName -Busy $busy -ForegroundRunning ($busy -and (Test-JobRunning -Job $flow.ForegroundJob)) -AuxiliaryRunning ($null -ne $script:Ui.AuxJob) -ConsoleRunning $consoleRunning # いま実行してよいか。
    if (-not $allowed) {
        if ($consoleRunning -and $script:ReadOnlyActions -notcontains $Card.ActionName) {
            Show-GuiMessage -Text '別のコンソール窓が開いている間は、設定を変える操作は実行できません。その窓の CLI が終わり、Enter キーで閉じてから実行してください。'
        } else {
            Show-GuiMessage -Text '別の操作を実行中です。終わってから実行してください。'
        }
        return
    }
    $values = Get-CardValue -Card $Card # 入力された値。
    $flags = @(Get-CardFlag -Card $Card) # オンのチェック。
    $missing = @(Get-MissingRequiredLabel -Help $script:Ui.Help -ActionKey $Card.ActionKey -Action $Card.Action -Values $values) # 空の必須欄。
    if ($missing.Count -gt 0) {
        $missingLines = @($missing | ForEach-Object { '・' + [string]$_ }) # 空の欄の一覧。
        Show-GuiMessage -Caption $Card.Label -Warning -Text ("次の欄が空です。入力してから実行してください（CLI は呼んでいません）。`r`n`r`n" + ($missingLines -join "`r`n"))
        return
    }
    $dashed = @(Get-DashLeadingLabel -Help $script:Ui.Help -Values $values) # - で始まる値の欄。
    if ($dashed.Count -gt 0) {
        $dashedLines = @($dashed | ForEach-Object { "・『$([string]$_)』は - で始められません" }) # - で始まる欄の一覧。
        Show-GuiMessage -Caption $Card.Label -Warning -Text ("pwsh が値をパラメーター名と取り違えるおそれがあるため、実行しません（CLI は呼んでいません）。`r`n`r`n" + ($dashedLines -join "`r`n"))
        return
    }
    if ($busy) {
        # 前面の子プロセスが動いている間の、読み取りだけの短い Action。操作の状態（Flow）は変えない。
        try {
            Start-AuxiliaryJob -Card $Card -Values $values -Flags $flags
        } catch {
            Add-LogLine "$(Get-LogLinePrefix -ActionName $Card.ActionName)実行できませんでした: $($_.Exception.Message)"
            $script:Ui.AuxJob = $null
            Update-ButtonState
        }
        return
    }
    $Card.HubStopTried = $false
    $script:Ui.Flow = @{
        Id = [guid]::NewGuid().ToString('N') # この操作の識別子（終わった子プロセスがどの操作のものかを見分ける）。
        Card = $Card
        ActionName = $Card.ActionName
        Label = $Card.Label
        OptionValues = $values # 入力された値（kebab-case のオプション名 → 値）。
        Flags = $flags
        HubQueue = $null # ハブ起動の前に確認する登録プロジェクトの列。
        CurrentHubProject = $null # 確認中の登録プロジェクト。
        HubUnverifiable = [System.Collections.Generic.List[string]]::new() # 承認状態を確かめられなかった登録プロジェクトの名前（この画面からは承認しない）。
        ForegroundJob = $null # この画面が動かし続ける子プロセス。
        HubStopRunning = $false # 停止のための HubStop を実行中か。
    } # 実行中の操作。
    Update-ButtonState
    Add-LogLine ''
    Add-LogLine "=== $($Card.Label)（$($Card.ActionName)）"
    try {
        # 上書き系のチェックは、この 1 回の実行にだけ効かせる（CLI へ渡すチェックは $flags に集めてあるため、画面のチェックはここでオフに戻す）。
        Reset-DangerousOption -Card $Card
        $interactive = @(Get-EntryList -Entry $Card.Action -Name 'interactive') # CLI が入力を求める種類。
        if ($script:HubApprovalActions -contains $Card.ActionName) {
            Start-HubApprovalFlow
            return
        }
        if ($interactive -contains 'approval') {
            if ($script:ForcedNoStartActions -contains $Card.ActionName) { Start-ScaffoldStep } else { Start-ExposureStep }
            return
        }
        if ($script:KeyConsoleActions -contains $Card.ActionName) {
            Start-KeyConsole -Approval $null
            Complete-Flow
            return
        }
        Start-ActionJob -Approval $null
    } catch {
        Add-LogLine "実行できませんでした: $($_.Exception.Message)"
        Complete-Flow
    }
}

# 追加系（AddProject・HubAdd）の最初の段階。足場が無ければ、先に Init をこの画面の子プロセスで実行する。足場が既にあれば Init は呼ばない。
function Start-ScaffoldStep {
    $flow = $script:Ui.Flow # 実行中の操作。
    $rootText = [string]$flow.OptionValues['project-root'] # 入力されたフォルダー（Get-CardValue が前後の " を外し、~ をホームにしたもの。CLI へもこの値を渡す）。
    $rootFull = [System.IO.Path]::GetFullPath($rootText, $script:Ui.WorkingDirectory) # 子プロセスと同じ基準（作業フォルダー）で解決したフォルダー。
    $configPath = Join-Path $rootFull $script:BridgeConfigName # 足場の設定ファイル。
    if (Test-Path -LiteralPath $configPath) {
        Add-LogLine "足場は既にあります（$($configPath)）。「プロジェクトを初期化」（Init）は実行しません。"
        Start-ExposureStep
        return
    }
    $projectName = if ($flow.OptionValues.Contains('project-name')) { [string]$flow.OptionValues['project-name'] } else { '' } # 足場に記録するプロジェクト名。
    if ([string]::IsNullOrWhiteSpace($projectName)) {
        Show-GuiMessage -Caption $flow.Label -Warning -Text "このフォルダーには足場（$($script:BridgeConfigName)）がありません。新しく作るため、「プロジェクト名」を入力してから実行してください。"
        Add-LogLine 'プロジェクト名が空のため中止しました（CLI は呼んでいません）。'
        Complete-Flow
        return
    }
    Add-LogLine '足場が無いため、先に「プロジェクトを初期化」（Init）を実行します（足場を作り、自己試験を実行します）。'
    $values = [ordered]@{ 'project-root' = $rootText; 'project-name' = $projectName } # Init に渡す値。
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'Init' -Values $values
    [void](Start-CliJob -ArgumentList $arguments -Kind 'Init' -Context @{ FlowId = $flow.Id })
}

# 公開範囲を ShowExposure（読み取りだけ）で取得する。プロファイルは、続けて呼ぶ CLI と同じ解決になるよう、カードに入力があるときだけ渡す。
function Start-ExposureStep {
    $flow = $script:Ui.Flow # 実行中の操作。
    $values = [ordered]@{ 'project-root' = [string]$flow.OptionValues['project-root'] } # ShowExposure に渡す値。
    if ($flow.OptionValues.Contains('profile') -and -not [string]::IsNullOrWhiteSpace([string]$flow.OptionValues['profile'])) { $values['profile'] = [string]$flow.OptionValues['profile'] }
    Add-LogLine '公開範囲を確認します（ShowExposure。読み取りだけで、何も書き込みません）。'
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'ShowExposure' -Values $values
    [void](Start-CliJob -ArgumentList $arguments -Kind 'Exposure' -Context @{ FlowId = $flow.Id } -CaptureOutput)
}

# ShowExposure の結果を読む。失敗したり JSON として読めなかったりしたら、生の出力をログへ出して $null を返す。
function Receive-ExposureReport {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode, [Parameter(Mandatory)][string]$Subject)
    $rawOutput = $Job.Output.ToString() # 溜めた標準出力。
    if ($ExitCode -ne 0) {
        if ($rawOutput.Trim() -ne '') { Add-LogLine -Line $rawOutput.TrimEnd() -FromCli }
        Write-ExitSummary -ExitCode $ExitCode -Label "公開範囲を確認（$($Subject)）"
        return $null
    }
    try {
        $report = ConvertFrom-ExposureReport -Text $rawOutput # 読み込んだ結果。
    } catch {
        Add-LogLine '公開範囲の確認（ShowExposure）の出力を JSON として読めませんでした。生の出力:'
        Add-LogLine -Line $rawOutput.TrimEnd() -FromCli
        Add-LogLine "理由: $($_.Exception.Message)"
        return $null
    }
    Add-LogLine "公開範囲を取得しました（$($Subject)。承認状態: $(Get-ApprovalStateText -State ([string]$report.approvalState))、指紋 $($report.exposureSha256)）。"
    return $report
}

# 公開範囲の取得が終わったあと。承認済みならダイアログを出さずに進み、それ以外は承認ダイアログを出す。
function Complete-ExposureStep {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode)
    $flow = $script:Ui.Flow # 実行中の操作。
    $report = Receive-ExposureReport -Job $Job -ExitCode $ExitCode -Subject ([string]$flow.OptionValues['project-root']) # 公開範囲。
    if ($null -eq $report) {
        Add-LogLine '公開範囲を確認できなかったため、中止しました。何も承認していません。'
        Complete-Flow
        return
    }
    # 承認状態が approved で、承認済みの指紋が現在の指紋と完全に一致するときだけ、ダイアログを省く。
    if (Test-ExposureApproved -Report $report) {
        Add-LogLine '公開範囲は承認済みのため、承認ダイアログは出しません（指紋は渡さず、CLI が承認済みを確かめます）。'
        Resume-AfterApproval -Approval $null
        return
    }
    $approval = Show-ApprovalDialog -Report $report -IsHub:($flow.ActionName -eq 'HubAdd') # 利用者の承認。キャンセルなら $null。
    if ($null -eq $approval) {
        Add-LogLine '承認しませんでした。このプロジェクトは公開されません。CLI は実行していません。'
        Complete-Flow
        return
    }
    Add-LogLine "承認ダイアログで承認しました（指紋 $($approval.Sha256)）。CLI が現在の公開範囲と再照合します。"
    Resume-AfterApproval -Approval $approval
}

# 承認の確認が済んだあと、Action を実行する。キーを入力する Action は別のコンソール窓で実行する。
function Resume-AfterApproval {
    param([object]$Approval)
    $flow = $script:Ui.Flow # 実行中の操作。
    if ($script:KeyConsoleActions -contains $flow.ActionName) {
        Start-KeyConsole -Approval $Approval
        Complete-Flow
        return
    }
    Start-ActionJob -Approval $Approval
}

# Action 本体を、この画面が管理する子プロセスで実行する。HubStart・HubRestart には必ず -Service を付ける（入力を求めず、未承認は公開しない）。
function Start-ActionJob {
    param([object]$Approval)
    $flow = $script:Ui.Flow # 実行中の操作。
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName $flow.ActionName -Values $flow.OptionValues -Flags $flow.Flags
    if ($null -ne $Approval) { Add-ApprovedExposureArgument -ArgumentList $arguments -Approval $Approval }
    if ($script:HubApprovalActions -contains $flow.ActionName) { $arguments.Add('-Service') }
    $job = Start-CliJob -ArgumentList $arguments -Kind 'Action' -Context @{ FlowId = $flow.Id } # 起動した子プロセス。
    if ($script:ManagedForegroundActions -contains $flow.ActionName) {
        $flow.ForegroundJob = $job
        Add-LogLine 'この処理は終了せずに動き続けます。止めるときは、このカードの「停止」を押してください。'
    }
    Update-ButtonState
}

# キーを入力する Action（SaveKey・AddProject・HubAdd）を、別のコンソール窓で CLI に実行させる。
# キーはその窓で CLI が受け取る。この画面はキーを読まず、保持せず、ログにも引数にも載せない。
# 別のコンソール窓では、この画面のスクリプトを補助役（-ConsoleHelper）として起動する。補助役は CLI を 1 回だけ実行し、
# 終了コードを出して Enter を待って終わる（対話プロンプトを残さないため、貼り付けたキーがコマンドとして実行されたり、履歴に残ったりしない）。
# 起動したプロセスは終わるまで持ち続け、その間は設定を変える Action の「実行」を押せなくする（Update-ConsoleState が終わりを調べる）。
function Start-KeyConsole {
    param([object]$Approval)
    $flow = $script:Ui.Flow # 実行中の操作。
    if (Test-ConsoleProcessRunning) { throw '別のコンソール窓が開いています。その窓を閉じてから実行してください。' }
    $arguments = New-CliArgumentList -CliPath $script:GuiScriptPath -ConsoleHelper -ActionName $flow.ActionName -Values $flow.OptionValues -Flags $flow.Flags
    if ($script:ForcedNoStartActions -contains $flow.ActionName) { $arguments.Add('-NoStart') }
    if ($null -ne $Approval) { Add-ApprovedExposureArgument -ArgumentList $arguments -Approval $Approval }
    # Start-Process の ArgumentList に配列を渡すと各要素が引用されないため、1 つずつ引用した 1 つの文字列で渡す。
    $commandLine = Join-CommandLine -ArgumentList $arguments.ToArray() # 別コンソールへ渡すコマンドライン。
    Set-CommandDisplay -FilePath $script:Ui.PwshPath -ArgumentList $arguments.ToArray()
    $script:Ui.ConsoleProcess = Start-Process -FilePath $script:Ui.PwshPath -ArgumentList $commandLine -WorkingDirectory $script:Ui.WorkingDirectory -PassThru
    if (-not $script:Ui.Timer.Enabled) { $script:Ui.Timer.Start() }
    Update-ButtonState
    Add-LogLine '別のコンソール窓を開きました。その窓が『Runtime API Key』の入力待ちになったときだけ、キーを貼り付けてください。入力した内容は表示されません（この画面には入力しません）。'
    Add-LogLine 'その窓は CLI が終わると終了コードを表示し、Enter キーで閉じます。窓が開いている間は、設定を変える操作（追加・承認・起動など）の「実行」は押せません。窓が閉じたら、登録一覧を読み直します。'
}

# 補助の子プロセスの記録を消し、ボタンを戻す。記録が別の子プロセスを指していれば消さない（識別子で照合する）。
# 補助の操作が終わったときも登録一覧を読み直す（Ubuntu 版の finish_aux_job と同じ。hub.json は読むだけ）。
function Clear-AuxiliaryJob {
    param([Parameter(Mandatory)][hashtable]$Job)
    if ($null -ne $script:Ui.AuxJob -and $script:Ui.AuxJob.Id -eq $Job.Id) { $script:Ui.AuxJob = $null }
    Update-ButtonState
    try {
        Update-HubListView
    } catch {
        Write-GuiError -ErrorRecord $_
    }
}

# 前面の子プロセスと並行して、読み取りだけの短い Action（Status・HubStatus・HubList）を補助の子プロセスで実行する。
# 出力の各行の先頭に Action 名を付けて、前面の処理の出力と区別する。操作の状態（Flow）は変えない。
function Start-AuxiliaryJob {
    param(
        [Parameter(Mandatory)][hashtable]$Card,
        [System.Collections.IDictionary]$Values = @{},
        [AllowEmptyCollection()][string[]]$Flags = @()
    )
    if ($script:AuxiliaryActions -notcontains $Card.ActionName) { throw "補助として実行できない Action です: $($Card.ActionName)" }
    $linePrefix = Get-LogLinePrefix -ActionName $Card.ActionName # 出力の各行の先頭の印。
    Add-LogLine "$($linePrefix)=== $($Card.Label)（$($Card.ActionName)。動いている処理と並行して実行します）"
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName $Card.ActionName -Values $Values -Flags $Flags
    $script:Ui.AuxJob = Start-CliJob -ArgumentList $arguments -Kind 'Auxiliary' -Context @{ Label = $Card.Label; LinePrefix = $linePrefix }
    Update-ButtonState
}

# HubStart・HubRestart の前段。hub.json の登録プロジェクトを 1 つずつ ShowExposure で確かめる。
# hub.json を読めないときは、承認の確認を飛ばして起動へ進まず、中止する（Ubuntu 版の start_hub_flow と同じ。CLI は呼ばない）。
function Start-HubApprovalFlow {
    $flow = $script:Ui.Flow # 実行中の操作。
    $hubPath = Get-HubConfigPath # ハブ設定ファイル。
    $projects = @() # 登録プロジェクト。
    try {
        $projects = @(Read-HubProjectList -HubPath $hubPath)
    } catch {
        $readError = $_.Exception.Message # 読めなかった理由。
        Add-LogLine "ハブ設定（$($hubPath)）を読めないため、中止しました（$($readError)）。CLI は実行していません。"
        Show-GuiMessage -Caption $flow.Label -Warning -Text "ハブ設定（hub.json）を読めないため、実行しませんでした（CLI は呼んでいません）。`r`n`r`n$($readError)"
        Complete-Flow
        return
    }
    $flow.HubQueue = [System.Collections.Generic.Queue[object]]::new()
    foreach ($project in $projects) { $flow.HubQueue.Enqueue($project) }
    if ($projects.Count -eq 0) {
        Add-LogLine "ハブに登録済みのプロジェクトが見つかりません（$($hubPath)）。"
    } else {
        Add-LogLine "登録プロジェクト $($projects.Count) 件の公開範囲を、1 件ずつ確認します（読み取りだけ）。"
    }
    Start-NextHubExposure
}

# 列の次の登録プロジェクトの公開範囲を取得する。列が空になったら Action 本体（-Service 付き）を実行する。
# フォルダーが記録されていない、または承認ファイル名からプロファイル名を求められない登録は、承認状態を確かめられないため、
# この画面からは承認しない（承認済みとしても扱わない。Ubuntu 版と同じ）。プロジェクトの設定のプロファイル名で代わりに確かめることもしない
# （CLI の起動は承認ファイル名のプロファイル名で承認を確かめるため、別の承認を確かめて承認してしまわないように）。
function Start-NextHubExposure {
    $flow = $script:Ui.Flow # 実行中の操作。
    while ($flow.HubQueue.Count -gt 0) {
        $project = $flow.HubQueue.Dequeue() # 確認する登録プロジェクト。
        $flow.CurrentHubProject = $project
        if ([string]::IsNullOrWhiteSpace($project.Root)) {
            Add-LogLine "$($project.Name): hub.json にフォルダーが記録されていないため、承認状態を確かめられません。この画面からは、このプロジェクトを承認しません（公開されません）。"
            $flow.HubUnverifiable.Add([string]$project.Name)
            continue
        }
        $profileName = Get-HubApprovalProfileName -ApprovalFile $project.ApprovalFile # CLI の Start-HubTunnel と同じ承認ファイルを指すプロファイル名。
        if ($profileName -eq '') {
            Add-LogLine "$($project.Name): 承認ファイル名からプロファイル名を求められないため、承認状態を確かめられません。この画面からは、このプロジェクトを承認しません（承認済みとしても扱いません）。hub.json の登録内容を確かめてください。"
            $flow.HubUnverifiable.Add([string]$project.Name)
            continue
        }
        $values = [ordered]@{ 'project-root' = $project.Root; 'profile' = $profileName } # ShowExposure に渡す値。
        $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'ShowExposure' -Values $values
        [void](Start-CliJob -ArgumentList $arguments -Kind 'HubExposure' -Context @{ FlowId = $flow.Id } -CaptureOutput)
        return
    }
    $flow.CurrentHubProject = $null
    if ($flow.HubUnverifiable.Count -gt 0) {
        Add-LogLine "承認状態を確かめられなかった登録 $($flow.HubUnverifiable.Count) 件: $($flow.HubUnverifiable -join '、')（この画面からは承認していません）。"
    }
    Add-LogLine '承認の確認が終わりました。-Service を付けて CLI を実行します（承認されていないプロジェクトは公開しないまま起動します）。'
    Start-ActionJob -Approval $null
}

# 登録プロジェクト 1 件の公開範囲を取得したあと。未承認・変更ありなら承認ダイアログを出し、承認されたら Approve で保存する。
# 承認の確認と保存には、承認ファイル名から求めたプロファイル名（CLI の起動が承認を確かめるもの）だけを使う（Ubuntu 版と同じ）。
function Complete-HubExposureStep {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode)
    $flow = $script:Ui.Flow # 実行中の操作。
    $project = $flow.CurrentHubProject # 確認中の登録プロジェクト。
    $report = Receive-ExposureReport -Job $Job -ExitCode $ExitCode -Subject $project.Name # 公開範囲。
    if ($null -eq $report) {
        Add-LogLine "$($project.Name): 公開範囲を確認できませんでした。このプロジェクトは公開されません（-Service の起動は、確認できないプロジェクトを飛ばします）。"
        Start-NextHubExposure
        return
    }
    $profileName = Get-HubApprovalProfileName -ApprovalFile $project.ApprovalFile # 承認ファイル名から求めたプロファイル名（Start-NextHubExposure で確かめ済み）。
    if ($profileName -eq '' -or -not [string]::Equals((Get-EntryText -Entry $report -Name 'profile'), $profileName, [System.StringComparison]::Ordinal)) {
        Add-LogLine "$($project.Name): 公開範囲の確認結果のプロファイル名が、承認ファイル名から求めたもの（$($profileName)）と違うため、承認状態を確かめられません。この画面からは、このプロジェクトを承認しません。"
        $flow.HubUnverifiable.Add([string]$project.Name)
        Start-NextHubExposure
        return
    }
    # 承認状態が approved で、承認済みの指紋が現在の指紋と完全に一致するときだけ、ダイアログを省く。
    if (Test-ExposureApproved -Report $report) {
        Add-LogLine "$($project.Name): 承認済みです。"
        Start-NextHubExposure
        return
    }
    $approval = Show-ApprovalDialog -Report $report -IsHub -Title "公開範囲の承認（ハブ: $($project.Name)）" # 利用者の承認。キャンセルなら $null。
    if ($null -eq $approval) {
        Add-LogLine "$($project.Name): 承認しませんでした。このプロジェクトは公開されません。"
        Start-NextHubExposure
        return
    }
    $values = [ordered]@{ 'project-root' = $project.Root; 'profile' = $profileName } # Approve に渡す値。
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'Approve' -Values $values
    Add-ApprovedExposureArgument -ArgumentList $arguments -Approval $approval
    Add-LogLine "$($project.Name): 承認ダイアログで承認しました。承認を保存します（Approve。CLI が指紋を再照合します）。"
    [void](Start-CliJob -ArgumentList $arguments -Kind 'HubApprove' -Context @{ FlowId = $flow.Id })
}

# 子プロセスが終わったあとの処理。Kind ごとに、次の段階へ進むか操作を終える。
function Complete-CliJob {
    param([Parameter(Mandatory)][hashtable]$Job)
    $Job.Process.WaitForExit()
    $exitCode = $Job.Process.ExitCode # 子プロセスの終了コード。
    if ($Job.Kind -eq 'HubStop') {
        Complete-HubStopJob -ExitCode $exitCode
        return
    }
    if ($Job.Kind -eq 'Auxiliary') {
        Write-ExitSummary -ExitCode $exitCode -Label ([string]$Job.Context['Label']) -LinePrefix $Job.LinePrefix
        Clear-AuxiliaryJob -Job $Job
        return
    }
    # 権限の確認・切り替え（かんたんタブの一覧）は、$script:Ui.Flow とは別に進む（HubStop・Auxiliary と同じ扱い）。
    if ($Job.Kind -eq 'PermissionCheck') {
        Complete-HubPermissionCheckJob -Job $Job -ExitCode $exitCode
        return
    }
    if ($Job.Kind -eq 'PermissionConfirm') {
        Complete-HubPermissionConfirmJob -Job $Job -ExitCode $exitCode
        return
    }
    if ($Job.Kind -eq 'PermissionApply') {
        Complete-HubPermissionApplyJob -Job $Job -ExitCode $exitCode
        return
    }
    $flow = $script:Ui.Flow # 実行中の操作。
    if ($null -eq $flow -or -not $Job.Context.ContainsKey('FlowId') -or $Job.Context['FlowId'] -ne $flow.Id) {
        Write-ExitSummary -ExitCode $exitCode -Label '以前の操作'
        return
    }
    switch ($Job.Kind) {
        'Init' {
            if ($exitCode -ne 0) {
                Write-ExitSummary -ExitCode $exitCode -Label '「プロジェクトを初期化」（Init）'
                Add-LogLine '足場の作成に失敗したため、中止しました。'
                Complete-Flow
                return
            }
            Add-LogLine '足場を作り、自己試験を終えました。続けて公開範囲を確認します。'
            Start-ExposureStep
        }
        'Exposure' {
            Complete-ExposureStep -Job $Job -ExitCode $exitCode
        }
        'HubExposure' {
            Complete-HubExposureStep -Job $Job -ExitCode $exitCode
        }
        'HubApprove' {
            $project = $flow.CurrentHubProject # 承認を保存した登録プロジェクト。
            Write-ExitSummary -ExitCode $exitCode -Label "公開範囲を承認（$($project.Name)）"
            if ($exitCode -ne 0) { Add-LogLine "$($project.Name): 承認を保存できませんでした。このプロジェクトは公開されません。" }
            Start-NextHubExposure
        }
        default {
            Write-ExitSummary -ExitCode $exitCode -Label $flow.Label -StopRequested:$Job.StopRequested
            Complete-Flow
        }
    }
}

# カードの「停止」ボタン。従来方式の Start はプロセスツリーごと止める。ハブは HubStop を呼び、それでも残れば次の押下でツリーごと止める。
function Stop-ForegroundAction {
    param([Parameter(Mandatory)][hashtable]$Card)
    $flow = $script:Ui.Flow # 実行中の操作。
    if ($null -eq $flow -or $flow.Card.ActionKey -ne $Card.ActionKey -or -not (Test-JobRunning -Job $flow.ForegroundJob)) {
        Add-LogLine 'このカードで動いている処理はありません。'
        Update-ButtonState
        return
    }
    $job = $flow.ForegroundJob # 動かし続けている子プロセス。
    if ($script:HubApprovalActions -notcontains $Card.ActionName -or $Card.HubStopTried) {
        Add-LogLine '動いている CLI を、プロセスツリーごと止めます（Tunnel Client も止まります）。'
        Stop-JobProcessTree -Job $job
        return
    }
    $Card.HubStopTried = $true
    $job.StopRequested = $true
    $flow.HubStopRunning = $true
    Update-ButtonState
    Add-LogLine '「ハブを停止」（HubStop）を実行して、ハブの Tunnel Client を止めます。'
    try {
        $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'HubStop'
        [void](Start-CliJob -ArgumentList $arguments -Kind 'HubStop' -Context @{ Card = $Card })
    } catch {
        $flow.HubStopRunning = $false
        Update-ButtonState
        throw
    }
}

# 停止のための HubStop が終わったあと。起動側がまだ動いていれば、次の「停止」でツリーごと止めることを知らせる。
function Complete-HubStopJob {
    param([int]$ExitCode)
    Write-ExitSummary -ExitCode $ExitCode -Label '「ハブを停止」（HubStop）'
    $flow = $script:Ui.Flow # 実行中の操作。
    if ($null -ne $flow) {
        $flow.HubStopRunning = $false
        if (Test-JobRunning -Job $flow.ForegroundJob) {
            Add-LogLine 'ハブを起動した側の CLI がまだ終わっていません。もう一度「停止」を押すと、その CLI をプロセスツリーごと止めます。'
        }
    }
    Update-ButtonState
}

# ウィンドウを閉じる前の確認。動いている子プロセスがあれば、止まることを伝えて確かめ、閉じるならプロセスツリーごと止める。
# 別のコンソール窓が開いていれば、そのことも知らせる（その窓は止めない。キーの入力の途中かもしれないため）。
function Confirm-WindowClose {
    param([Parameter(Mandatory)][object]$ClosingEvent)
    $running = @($script:Ui.Jobs.ToArray() | Where-Object { Test-JobRunning -Job $_ }) # 動いている子プロセス。
    $consoleRunning = [bool](Test-ConsoleProcessRunning) # 別のコンソール窓が開いているか。
    if ($running.Count -eq 0 -and -not $consoleRunning) { return }
    $flow = $script:Ui.Flow # 実行中の操作。
    $messageLines = [System.Collections.Generic.List[string]]::new() # 確認の文。
    if ($running.Count -gt 0) {
        if ($null -eq $flow -or -not (Test-JobRunning -Job $flow.ForegroundJob)) { $messageLines.Add('実行中の CLI を止めます。') } else { $messageLines.Add('ハブ（または Tunnel Client）が止まります。') }
    }
    if ($consoleRunning) { $messageLines.Add('別のコンソール窓が開いています（キーの入力を待っているかもしれません）。この画面を閉じても、その窓の CLI は止めません。') }
    $messageLines.Add('閉じますか?')
    $message = $messageLines -join "`r`n" # 確認の文。
    $answer = [System.Windows.Forms.MessageBox]::Show($script:Ui.Form, $message, 'ChatGPT Project Bridge 管理画面', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2) # 利用者の答え。
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
        $ClosingEvent.Cancel = $true
        return
    }
    foreach ($job in $running) { Stop-JobProcessTree -Job $job }
}

# コンソールの Ctrl+C（CTRL_C_EVENT）と Ctrl+Break（CTRL_BREAK_EVENT）を pwsh より先に受け取るよう登録する。受けたら Signal を立て、pwsh の処理を取りやめる。
# pwsh は Ctrl+C を受けると、実行中のパイプライン（ShowDialog の中）を止める。止まったあとは、タイマーなどのイベントの処理（スクリプトブロック）が
# 入口で PipelineStoppedException になり（処理の中の try では捕まえられない）、「ハンドルされていない例外」のダイアログが出続けて画面を閉じられなくなる。
# Ctrl+Break では pwsh がデバッガーに入り、画面が応答しなくなる。
# 信号の処理は別のスレッドで呼ばれるため、スクリプトブロックは使えない。式ツリー（System.Linq.Expressions）で「Cancel を立てて Signal.Set() を呼ぶ」だけの
# .NET の処理を作って登録する（P/Invoke は使わない）。画面を閉じるのは UI スレッドのタイマー（Update-ConsoleCancelState）。
# 後から登録した処理が先に呼ばれ、Cancel を立てると pwsh の処理は呼ばれない。登録できなければ何もしない（そのときの Ctrl+C は従来どおり pwsh が処理する）。
function Register-ConsoleCancelHandler {
    param([Parameter(Mandatory)][System.Threading.ManualResetEventSlim]$Signal)
    try {
        $expressionType = [System.Linq.Expressions.Expression] # 式ツリーを組み立てる型。
        $contextParameter = $expressionType::Parameter([System.Runtime.InteropServices.PosixSignalContext], 'context') # 信号の情報（処理の引数）。
        $cancelAssign = $expressionType::Assign($expressionType::Property($contextParameter, 'Cancel'), $expressionType::Constant($true)) # context.Cancel = true。
        $signalSet = $expressionType::Call($expressionType::Constant($Signal), [System.Threading.ManualResetEventSlim].GetMethod('Set', [type[]]@())) # Signal.Set()。
        $handler = $expressionType::Lambda([System.Action[System.Runtime.InteropServices.PosixSignalContext]], $expressionType::Block($cancelAssign, $signalSet), [System.Linq.Expressions.ParameterExpression[]]@($contextParameter)).Compile() # 登録する処理。
        # Windows では SIGINT が CTRL_C_EVENT、SIGQUIT が CTRL_BREAK_EVENT にあたる。
        foreach ($signalKind in @([System.Runtime.InteropServices.PosixSignal]::SIGINT, [System.Runtime.InteropServices.PosixSignal]::SIGQUIT)) {
            $script:Ui.ConsoleRegistrations.Add([System.Runtime.InteropServices.PosixSignalRegistration]::Create($signalKind, $handler))
        }
    } catch {
        foreach ($registration in $script:Ui.ConsoleRegistrations) { $registration.Dispose() }
        $script:Ui.ConsoleRegistrations.Clear()
        Add-LogLine "コンソールの Ctrl+C を受け取る準備ができませんでした（$($_.Exception.Message)）。この画面は右上の × で閉じてください（コンソールで Ctrl+C を押すと、画面を操作できなくなることがあります）。"
    }
}

# コンソールの Ctrl+C・Ctrl+Break を受けていたら、この画面を閉じる（200 ms ごとのタイマーから呼ぶ）。主画面は × と同じ閉じ方（FormClosing の確認）で閉じる。
# 前面にダイアログ（承認ダイアログなど）があれば、その回はダイアログだけをキャンセルとして閉じ、主画面は次の回以降に閉じる
# （ダイアログのあとの処理が済んでから、閉じる確認が実行中の子プロセスを調べるようにするため）。
# メッセージボックスやファイル選択（Form ではないもの）が手前にある間は、利用者が閉じるまで待つ（それらは閉じない）。
# 閉じる確認の間に押した Ctrl+C は数えない。閉じるのを取りやめたあとは、もう一度 Ctrl+C を押すと閉じ直す。
function Update-ConsoleCancelState {
    if ($script:Ui.ConsoleSignal.IsSet) {
        $script:Ui.ConsoleSignal.Reset()
        if (-not $script:Ui.InConsoleClose -and -not $script:Ui.ConsoleCloseRequested) {
            $script:Ui.ConsoleCloseRequested = $true
            Add-LogLine 'コンソールで Ctrl+C（または Ctrl+Break）を受けたため、この画面を閉じます。'
        }
    }
    if (-not $script:Ui.ConsoleCloseRequested -or $script:Ui.InConsoleClose) { return }
    $mainForm = $script:Ui.Form # 主画面。
    $visibleForms = @([System.Windows.Forms.Application]::OpenForms | Where-Object { $_.Visible }) # 表示中の画面（後ろほど後から開いたもの）。
    if ($visibleForms.Count -gt 0 -and $visibleForms[-1] -ne $mainForm) {
        $frontForm = $visibleForms[-1] # 前面のダイアログ。
        # 操作できる（手前に別のモーダルが無い）ときだけ閉じる。モーダルのダイアログは DialogResult が Cancel になり、承認も有効化もしない。
        if ($frontForm.CanFocus) { $frontForm.Close() }
        return
    }
    # 主画面の手前にメッセージボックスなどがある間（主画面を操作できない間）は待つ。
    if ($null -eq $mainForm -or -not $mainForm.CanFocus) { return }
    $script:Ui.ConsoleCloseRequested = $false
    $script:Ui.InConsoleClose = $true
    try {
        $mainForm.Close()
    } finally {
        $script:Ui.InConsoleClose = $false
    }
}

# 上書き系（dangerous）のチェックをオンにしたときの確認。キャンセルならチェックを戻す（戻すときは確認を出さない）。
function Confirm-DangerousOption {
    param([Parameter(Mandatory)][object]$CheckBox)
    if (-not $CheckBox.Checked -or $script:Ui.SuppressDangerConfirm) { return }
    $option = Get-OptionEntry -Help $script:Ui.Help -OptionName ([string]$CheckBox.Tag) # オプションの説明。
    $label = Get-EntryText -Entry $option -Name 'label' # オプションの名前。
    $accepted = Show-DangerConfirmDialog -Label $label -Caution (Get-EntryText -Entry $option -Name 'caution') # 利用者が有効にしたか。
    if ($accepted) {
        Add-LogLine "「$($label)」を有効にしました（このカードの次の 1 回の実行だけ。実行を始めるとオフに戻ります。設定は保存しません）。"
        return
    }
    $script:Ui.SuppressDangerConfirm = $true
    try {
        $CheckBox.Checked = $false
    } finally {
        $script:Ui.SuppressDangerConfirm = $false
    }
}

# 同じオプション名の入力欄（text・path・number）へ、値を写す。チェックボックスは写さない（カードごと）。
# 文字列は序数（大文字小文字も区別）で比べる（-ne は大文字小文字とカルチャを無視し、大文字小文字やゼロ幅文字だけの違いを写さないため）。
# 写す元も写す先も、共有の一覧（Register-SharedInput で登録した欄）にあるものだけにする。
function Sync-SharedInput {
    param([Parameter(Mandatory)][object]$Source)
    if ($script:Ui.SyncingInput) { return }
    $optionName = [string]$Source.Tag # 写すオプション名。
    if (-not $script:Ui.SharedInputs.ContainsKey($optionName)) { return }
    # 共有の一覧に入っていない欄（「プロジェクトを追加」（HubAdd）の Tunnel ID）の値は、ほかの欄へ写さない（一覧に無いので、ほかの欄からも写されない）。
    if (-not $script:Ui.SharedInputs[$optionName].Contains($Source)) { return }
    $isNumber = (Get-EntryText -Entry (Get-OptionEntry -Help $script:Ui.Help -OptionName $optionName) -Name 'kind') -eq 'number' # 数値の欄か。
    $script:Ui.SyncingInput = $true
    try {
        foreach ($other in $script:Ui.SharedInputs[$optionName]) {
            if ([object]::ReferenceEquals($other, $Source)) { continue }
            if ($isNumber) {
                if ($other.Value -ne $Source.Value) { $other.Value = $Source.Value }
            } elseif (-not [string]::Equals([string]$other.Text, [string]$Source.Text, [System.StringComparison]::Ordinal)) {
                $other.Text = $Source.Text
            }
        }
    } finally {
        $script:Ui.SyncingInput = $false
    }
}

# 「選択…」ボタン。フォルダーかファイルを選ぶ画面を開き、選んだパスを入力欄へ入れる。
function Select-PathForInput {
    param([Parameter(Mandatory)][hashtable]$Target)
    $mode = Get-PathDialogMode -OptionName $Target.OptionName -ActionKey $Target.ActionKey # 開く画面の種類。
    $textBox = $Target.TextBox # 結果を入れる入力欄。
    $current = ConvertTo-InputPath -Text ([string]$textBox.Text) -HomePath $env:USERPROFILE # いまの値（実行のときと同じく、前後の " を外し、~ をホームにしたもの）。
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        # 子プロセスと同じ基準（作業フォルダー）で解決する。解決できない値なら、選択画面の始まりの場所を決めずに開く。
        try {
            $current = [System.IO.Path]::GetFullPath($current, $script:Ui.WorkingDirectory)
        } catch {
            $current = ''
        }
    }
    $okResult = [System.Windows.Forms.DialogResult]::OK # 選んだときの結果。
    if ($mode -eq 'Folder') {
        $folderDialog = New-GuiComponent -TypeName 'FolderBrowserDialog' -Property ([ordered]@{ Description = "$($Target.Label)を選びます。"; ShowNewFolderButton = $true })
        try {
            if ($current -ne '' -and (Test-Path -LiteralPath $current -PathType Container)) { $folderDialog.SelectedPath = $current }
            if ($folderDialog.ShowDialog($script:Ui.Form) -eq $okResult) { $textBox.Text = $folderDialog.SelectedPath }
        } finally {
            $folderDialog.Dispose()
        }
        return
    }
    if ($mode -eq 'SaveFile') {
        # 既存ファイルの上書きの可否は CLI（-Force）が決めるため、選択画面では上書きの確認を出さない。
        $fileDialog = New-GuiComponent -TypeName 'SaveFileDialog' -Property ([ordered]@{ Title = "$($Target.Label)を選びます。"; Filter = (Get-PathDialogFilter -OptionName $Target.OptionName); OverwritePrompt = $false })
    } else {
        $fileDialog = New-GuiComponent -TypeName 'OpenFileDialog' -Property ([ordered]@{ Title = "$($Target.Label)を選びます。"; Filter = (Get-PathDialogFilter -OptionName $Target.OptionName); CheckFileExists = $true })
    }
    try {
        if ($current -ne '') {
            $currentDirectory = Split-Path -Path $current -Parent # いまの値のフォルダー。
            if (-not [string]::IsNullOrWhiteSpace($currentDirectory) -and (Test-Path -LiteralPath $currentDirectory -PathType Container)) { $fileDialog.InitialDirectory = $currentDirectory }
        }
        if ($fileDialog.ShowDialog($script:Ui.Form) -eq $okResult) { $textBox.Text = $fileDialog.FileName }
    } finally {
        $fileDialog.Dispose()
    }
}

# 画面の上のハブの稼働表示（状態と詳細の 2 つのラベル）を、いまの状態に合わせる。読み取りだけで、何も起動せず、通信もしない。
# 3 秒ごとの専用のタイマーと、Update-HubListView（画面の表示時・操作や補助の終了・別のコンソール窓が閉じたとき・「一覧を更新」）から呼ぶ。
function Update-HubStatusBand {
    $stateLabel = $script:Ui.HubStateLabel # 状態のラベル。
    $detailLabel = $script:Ui.HubDetailLabel # 詳細のラベル。
    if ($null -eq $stateLabel -or $null -eq $detailLabel) { return }
    if ($script:Ui.InHubUpdate) { return }
    $script:Ui.InHubUpdate = $true
    try {
        $display = Get-HubStatusText -Status (Get-HubRunState) # 表示する 2 つの文と、実行中かどうか。
        # 文が変わったときだけ書き換える（3 秒ごとの書き換えで、表示をちらつかせないため）。
        if (-not [string]::Equals([string]$stateLabel.Text, [string]$display.StateText, [System.StringComparison]::Ordinal)) { $stateLabel.Text = [string]$display.StateText }
        if (-not [string]::Equals([string]$detailLabel.Text, [string]$display.DetailText, [System.StringComparison]::Ordinal)) { $detailLabel.Text = [string]$display.DetailText }
        $stateLabel.ForeColor = if ($display.IsRunning) { [System.Drawing.Color]::DarkGreen } else { [System.Drawing.SystemColors]::ControlText } # 実行中だけ緑系にする。
    } finally {
        $script:Ui.InHubUpdate = $false
    }
}

# 入力欄 1 つへ、自動入力の規則（Test-AutoFillAllowed）に合うときだけ値を入れ、入れた値を覚える（次に書き換えてよいかの判定に使う）。
function Set-AutoFilledText {
    param([Parameter(Mandatory)][string]$SlotName, [Parameter(Mandatory)][object]$TextBox, [AllowEmptyString()][string]$Candidate = '')
    $lastFilled = if ($script:Ui.AutoFilled.ContainsKey($SlotName)) { [string]$script:Ui.AutoFilled[$SlotName] } else { '' } # 前回この処理が入れた値。
    if (-not (Test-AutoFillAllowed -Current ([string]$TextBox.Text) -Candidate $Candidate -LastFilled $lastFilled)) { return }
    $TextBox.Text = $Candidate
    $script:Ui.AutoFilled[$SlotName] = $Candidate
}

# 分かっている値を、空の入力欄へ入れる（入力済みの値は書き換えない。Test-AutoFillAllowed）。読み取りだけで、対象は次の 2 つだけ。
#   1. 「プロジェクトを追加」（HubAdd）カードの Tunnel ID に、hub.json の tunnelId を入れる（形式に合うときだけ）。この欄は、従来方式の Tunnel ID 欄と値を共有しない。
#   2. Tunnel Client の場所（出ている全カードで共有）に、Find-TunnelClientPath が見つけた tunnel-client.exe のフルパスを入れる。見つからなければ何も入れない。
# プロジェクトのフォルダー・プロジェクト名・ハブ内の名前・プロファイル名は入れない（候補が 1 つに決まらない、または「ハブから外す」の空欄の安全策を弱めるため）。
# Update-HubListView（画面の表示時など）から呼ぶ。3 秒ごとのタイマーからは呼ばない（入力中に書き換えないため）。
function Set-KnownInputValue {
    $tunnelBox = $null # 「プロジェクトを追加」（HubAdd）の Tunnel ID 欄。
    foreach ($card in $script:Ui.Cards) {
        if ([string]::Equals([string]$card.ActionName, 'HubAdd', [System.StringComparison]::Ordinal) -and $card.Inputs.ContainsKey('tunnel-id')) { $tunnelBox = $card.Inputs['tunnel-id'] }
    }
    if ($null -ne $tunnelBox) {
        $hubTunnelId = '' # ハブ設定の Tunnel ID（未登録・形式に合わない・読めないときは空文字）。
        try {
            $summary = Read-HubSummary -HubPath (Get-HubConfigPath) # ハブ設定の要点（hub.json が無ければ $null）。
            if ($null -ne $summary) { $hubTunnelId = [string]$summary.TunnelId }
        } catch {
            $hubTunnelId = ''
        }
        Set-AutoFilledText -SlotName 'HubAdd:tunnel-id' -TextBox $tunnelBox -Candidate $hubTunnelId
    }
    if ($script:Ui.SharedInputs.ContainsKey('tunnel-client-path') -and $script:Ui.SharedInputs['tunnel-client-path'].Count -gt 0) {
        $clientPath = '' # 見つかった tunnel-client.exe（見つからない・探せないときは空文字）。
        try {
            $clientPath = [string](Find-TunnelClientPath)
        } catch {
            $clientPath = ''
        }
        # 共有の欄の 1 つへ入れると、Sync-SharedInput が同じ名前のほかの欄へ写す。
        Set-AutoFilledText -SlotName 'tunnel-client-path' -TextBox $script:Ui.SharedInputs['tunnel-client-path'][0] -Candidate $clientPath
    }
}

# かんたんタブの登録一覧を、hub.json を読み取るだけで作り直す。ファイルが無ければ「未登録」と出す（作らない）。
# 同じきっかけ（画面の表示時・操作や補助の終了・別のコンソール窓が閉じたとき・「一覧を更新」）で、先に、画面の上のハブの稼働表示を調べ直し、
# 分かっている値を空の入力欄へ入れる（どちらも読み取りだけ。失敗したらログ欄へ出し、登録一覧の作り直しは続ける）。
function Update-HubListView {
    try {
        Update-HubStatusBand
        Set-KnownInputValue
    } catch {
        Write-GuiError -ErrorRecord $_
    }
    $listView = $script:Ui.HubListView # 登録一覧。
    if ($null -eq $listView) { return }
    $listView.BeginUpdate()
    try {
        $listView.Items.Clear()
        $hubPath = Get-HubConfigPath # ハブ設定ファイル。
        try {
            $projects = @(Read-HubProjectList -HubPath $hubPath) # 登録プロジェクト。
        } catch {
            $errorItem = $listView.Items.Add('読み取れません') # 読み取りに失敗したことを示す行。
            [void]$errorItem.SubItems.Add($_.Exception.Message)
            return
        }
        if ($projects.Count -eq 0) {
            $emptyItem = $listView.Items.Add('未登録') # 登録が無いことを示す行。
            [void]$emptyItem.SubItems.Add("（$($hubPath) が無いか、登録がありません）")
            return
        }
        foreach ($project in $projects) {
            # hub.json の値は、制御文字・双方向制御文字などを \u の形にしてから出す（表示を偽れないようにする）。
            $projectItem = $listView.Items.Add((ConvertTo-SafeLogLine -Text $project.Name)) # 登録プロジェクトの行。
            [void]$projectItem.SubItems.Add((ConvertTo-SafeLogLine -Text $project.Root))
            [void]$projectItem.SubItems.Add('（未確認）') # ソースの読み取り（「権限を確認」を押すまでの初期値）。
            [void]$projectItem.SubItems.Add('（未確認）') # Claude Code の起動（「権限を確認」を押すまでの初期値）。
            [void]$projectItem.SubItems.Add('（未確認）') # 承認（「権限を確認」を押すまでの初期値）。
            # 行の状態（権限の切り替えが使う。表示用に無害化していない生の値を持つ。CLI へ渡すのはこの値）。
            $projectItem.Tag = @{
                Name = $project.Name
                Root = $project.Root
                ApprovalFile = $project.ApprovalFile
                Profile = (Get-HubApprovalProfileName -ApprovalFile $project.ApprovalFile)
                Permission = $null # HubPermissions が返した、このプロジェクトの権限（未確認なら $null）。
            }
        }
    } finally {
        $listView.EndUpdate()
    }
}

# ---------------------------------------------------------------------------
# 権限（ソースの読み取り・Claude Code の起動）の確認・切り替え（かんたんタブの一覧）。
# 確認（HubPermissions）は読み取り専用で、ほかの操作と並行してよい。切り替え（SetPermission）は、確認 → 承認ダイアログ → 適用の順で、
# $script:Ui.Flow（カードの操作）とは別に $script:Ui.PermissionJob・$script:Ui.PermissionToggle で状態を持つ（同時に 1 つまで）。
# ---------------------------------------------------------------------------

# 一覧の「ソースの読み取り」列に出す文。HubPermissions の sourceRead（on・off・partial）をそのまま日本語にする。
function Get-HubPermissionSourceReadText {
    param([AllowEmptyString()][string]$State)
    switch ($State) {
        'on' { return 'On' }
        'off' { return 'Off' }
        'partial' { return '一部のみ（使えません）' }
        default { return '（未確認）' }
    }
}

# 一覧の「Claude Code」列に出す文。HubPermissions の claudeCode（on・off・unset）をそのまま日本語にする。on は許可コマンドの件数も添える。
function Get-HubPermissionClaudeCodeText {
    param([AllowEmptyString()][string]$State, [int]$AllowedCommandCount = 0)
    switch ($State) {
        'on' { if ($AllowedCommandCount -gt 0) { return "On（コマンド $($AllowedCommandCount) 件）" } else { return 'On' } }
        'off' { return 'Off' }
        'unset' { return '設定なし' }
        default { return '（未確認）' }
    }
}

# 一覧の「承認」列に出す文。unavailable（確認できなかった）は理由を添える。他の 3 状態は承認ダイアログと同じ言い回しにする（Get-ApprovalStateText）。
function Get-HubPermissionApprovalText {
    param([AllowEmptyString()][string]$State, [AllowEmptyString()][AllowNull()][string]$ErrorMessage)
    if ($State -eq '') { return '（未確認）' }
    if ($State -ceq 'unavailable') {
        $reason = if ([string]::IsNullOrWhiteSpace($ErrorMessage)) { '理由不明' } else { $ErrorMessage } # 確認できなかった理由。
        return '確認できません（' + (ConvertTo-SafeLogLine -Text $reason) + '）'
    }
    return Get-ApprovalStateText -State $State
}

# 権限の切り替えのログ・お知らせに出す日本語の名前。
function Get-HubPermissionKindLabel {
    param([Parameter(Mandatory)][ValidateSet('SourceRead', 'ClaudeCode')][string]$Kind)
    if ($Kind -eq 'SourceRead') { return 'ソースの読み取り' }
    return 'Claude Code の起動'
}

# 切り替え後の方向（on・off）を、現在の権限から決める。ソース: on → off、それ以外（off・partial）→ on。Claude Code: on → off、それ以外（off・unset）→ on。
function Get-HubPermissionToggleDirection {
    param([Parameter(Mandatory)][ValidateSet('SourceRead', 'ClaudeCode')][string]$Kind, [Parameter(Mandatory)][object]$Permission)
    if ($Kind -eq 'SourceRead') {
        if ((Get-EntryText -Entry $Permission -Name 'sourceRead') -ceq 'on') { return 'off' }
        return 'on'
    }
    if ((Get-EntryText -Entry $Permission -Name 'claudeCode') -ceq 'on') { return 'off' }
    return 'on'
}

# HubPermissions の標準出力全体を JSON として読み、projects 配列を返す。読めなければ例外にする（一覧の列は変えない）。
function ConvertFrom-HubPermissionReport {
    param([AllowEmptyString()][AllowNull()][string]$Text)
    $trimmed = ([string]$Text).TrimStart([char]0xFEFF).Trim() # 先頭の BOM と前後の空白を除いた出力。
    if ($trimmed -eq '') { throw 'HubPermissions の出力が空です。' }
    $report = $trimmed | ConvertFrom-Json # 読み込んだ結果。
    if ($null -eq $report -or $report -is [array]) { throw 'HubPermissions の出力が JSON のオブジェクト 1 つではありません。' }
    if ($null -eq $report.PSObject.Properties['projects']) { throw 'HubPermissions の出力に projects がありません。' }
    $entries = @(Get-EntryList -Entry $report -Name 'projects') # プロジェクトごとの権限。
    foreach ($entry in $entries) {
        if ($entry -isnot [System.Management.Automation.PSCustomObject]) { throw 'HubPermissions の出力の projects に、オブジェクトでない要素があります。' }
        foreach ($name in @('name', 'root', 'approvalState')) {
            if ((Get-EntryValue -Entry $entry -Name $name) -isnot [string]) { throw "HubPermissions の出力の projects に $name がありません。" }
        }
    }
    return , $entries
}

# HubPermissions の結果を一覧の列へ反映する。行は Root で対応づける（大文字小文字は区別しない。Windows のパスのため）。
# 一致する行が無いエントリは無視する（この画面は hub.json を読み直さないため、権限の確認だけで一覧の行は増減しない）。
function Update-HubPermissionColumn {
    param([AllowEmptyCollection()][object[]]$Entry = @())
    $listView = $script:Ui.HubListView # 登録一覧。
    if ($null -eq $listView) { return }
    foreach ($item in $listView.Items) {
        $state = $item.Tag # 行の状態（Update-HubListView が作る）。
        if ($state -isnot [hashtable]) { continue }
        $matched = $null # この行に対応する権限（見つからなければ $null）。
        foreach ($one in $Entry) {
            if ([string]::Equals((Get-EntryText -Entry $one -Name 'root'), [string]$state.Root, [System.StringComparison]::OrdinalIgnoreCase)) { $matched = $one; break }
        }
        $state.Permission = $matched
        $allowedCount = 0 # 許可コマンドの件数。
        $allowedValue = Get-EntryValue -Entry $matched -Name 'allowedCommandCount'
        if ($allowedValue -is [int] -or $allowedValue -is [long]) { $allowedCount = [int]$allowedValue }
        $item.SubItems[2].Text = ConvertTo-SafeLogLine -Text (Get-HubPermissionSourceReadText -State (Get-EntryText -Entry $matched -Name 'sourceRead'))
        $item.SubItems[3].Text = ConvertTo-SafeLogLine -Text (Get-HubPermissionClaudeCodeText -State (Get-EntryText -Entry $matched -Name 'claudeCode') -AllowedCommandCount $allowedCount)
        $item.SubItems[4].Text = ConvertTo-SafeLogLine -Text (Get-HubPermissionApprovalText -State (Get-EntryText -Entry $matched -Name 'approvalState') -ErrorMessage (Get-EntryText -Entry $matched -Name 'error'))
    }
}

# 権限の確認・切り替えの子プロセスの記録を消し、ボタンを戻す（Complete-CliJob が例外で終わったときの後始末。Clear-AuxiliaryJob と同じ考え方）。
function Clear-HubPermissionJob {
    param([Parameter(Mandatory)][hashtable]$Job)
    if ($null -ne $script:Ui.PermissionJob -and $script:Ui.PermissionJob.Id -eq $Job.Id) { $script:Ui.PermissionJob = $null }
    $script:Ui.PermissionToggle = $null
    Update-ButtonState
}

# 権限確認（HubPermissions）を、読み取り専用の子プロセスで実行する。他の操作（Flow・補助・コンソール窓）と並行してよい。同時に 1 つまで。
function Start-HubPermissionCheckJob {
    if ($null -ne $script:Ui.PermissionJob) { return }
    Add-LogLine ''
    Add-LogLine '=== 権限を確認（HubPermissions。読み取り専用で、ほかの操作と並行して実行します）'
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'HubPermissions'
    $script:Ui.PermissionJob = Start-CliJob -ArgumentList $arguments -Kind 'PermissionCheck' -CaptureOutput
    Update-ButtonState
}

# 権限確認（HubPermissions）が終わったあと。JSON を検証して一覧の列を埋める（形が違えば列は変えず、ログに理由を出す）。
# 切り替えの途中（まだ確認していなかった）なら、確認できた権限で切り替えを続ける。確認できなければ切り替えを断る。
function Complete-HubPermissionCheckJob {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode)
    $script:Ui.PermissionJob = $null
    $pendingToggle = $script:Ui.PermissionToggle # 進行中の切り替え（無ければ $null）。
    $isPending = ($null -ne $pendingToggle -and $null -eq $pendingToggle.Direction) # この確認が、切り替えのために始めたものか。
    $rawOutput = $Job.Output.ToString() # 溜めた標準出力。
    Write-ExitSummary -ExitCode $ExitCode -Label '権限を確認（HubPermissions）'
    $entries = $null # 読み取れた権限（読めなければ $null のまま）。
    if ($ExitCode -eq 0) {
        try {
            $entries = ConvertFrom-HubPermissionReport -Text $rawOutput
        } catch {
            Add-LogLine "権限を確認（HubPermissions）の出力を JSON として読めませんでした。理由: $($_.Exception.Message)"
        }
    }
    if ($null -eq $entries) {
        if ($rawOutput.Trim() -ne '') { Add-LogLine -Line $rawOutput.TrimEnd() -FromCli }
    } else {
        Update-HubPermissionColumn -Entry $entries
        Add-LogLine "権限を確認しました（登録 $($entries.Count) 件）。"
    }
    if (-not $isPending) {
        Update-ButtonState
        return
    }
    if ($null -eq $entries) {
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        Show-GuiMessage -Warning -Text '権限を確認できなかったため、切り替えられません。'
        return
    }
    Resume-HubPermissionToggle -Kind $pendingToggle.Kind -Item $pendingToggle.Item -State $pendingToggle.State
}

# 一覧で選んだプロジェクトの、ソースの読み取り（Kind='SourceRead'）または Claude Code の起動（Kind='ClaudeCode'）を、現在値の逆へ切り替える。
# まだ権限を確認していなければ、先に確認してから続ける（確認は読み取り専用で、この画面からは並行してよい）。
function Invoke-HubPermissionToggle {
    param([Parameter(Mandatory)][ValidateSet('SourceRead', 'ClaudeCode')][string]$Kind)
    if ($null -ne $script:Ui.PermissionToggle -or $null -ne $script:Ui.PermissionJob) {
        Show-GuiMessage -Text '権限の確認・切り替えを実行中です。終わってから実行してください。'
        return
    }
    if ($null -ne $script:Ui.Flow -or (Test-ConsoleProcessRunning)) {
        Show-GuiMessage -Text '別の操作を実行中、または別のコンソール窓が開いています。終わってから実行してください。'
        return
    }
    $listView = $script:Ui.HubListView # 登録一覧。
    if ($null -eq $listView -or $listView.SelectedItems.Count -eq 0) {
        Show-GuiMessage -Text '一覧から、切り替えるプロジェクトを選んでください。'
        return
    }
    $item = $listView.SelectedItems[0] # 選んだ行。
    $state = $item.Tag # 行の状態。
    if ($state -isnot [hashtable]) {
        Show-GuiMessage -Text 'この行は切り替えられません（登録プロジェクトの行を選んでください）。'
        return
    }
    if ($state.Profile -eq '') {
        Show-GuiMessage -Text '承認ファイル名からプロファイル名を求められないため、この画面からは切り替えられません（hub.json の登録内容を確かめてください）。'
        return
    }
    if (-not (Test-HubApprovalFileStandard -ApprovalFile $state.ApprovalFile -ProfileName $state.Profile)) {
        Show-GuiMessage -Text '承認ファイルの場所が標準と違うため、この画面から切り替えられません。'
        return
    }
    if ($null -eq $state.Permission) {
        Add-LogLine "$($state.Name): まだ権限を確認していないため、先に確認します。"
        $script:Ui.PermissionToggle = @{ Kind = $Kind; Item = $item; State = $state; Direction = $null }
        Update-ButtonState
        Start-HubPermissionCheckJob
        return
    }
    Resume-HubPermissionToggle -Kind $Kind -Item $item -State $state
}

# 権限（State.Permission）が分かったあと、切り替えを続ける。確認できなかった行（error あり）は切り替えを断る。
function Resume-HubPermissionToggle {
    param([Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][object]$Item, [Parameter(Mandatory)][hashtable]$State)
    $permissionError = Get-EntryText -Entry $State.Permission -Name 'error' # 確認できなかった理由（無ければ空文字）。
    if ($State.Permission -isnot [System.Management.Automation.PSCustomObject] -or $permissionError -ne '') {
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        $reasonText = if ($permissionError -ne '') { "（$($permissionError)）" } else { '' } # 理由（分かれば添える）。
        Show-GuiMessage -Warning -Text "権限を確認できなかったため、切り替えられません$($reasonText)。"
        return
    }
    $direction = Get-HubPermissionToggleDirection -Kind $Kind -Permission $State.Permission # 切り替え後の方向。
    $script:Ui.PermissionToggle = @{ Kind = $Kind; Item = $Item; State = $State; Direction = $direction }
    Update-ButtonState
    Start-HubPermissionConfirmJob
}

# 切り替えの確認（SetPermission を指紋なしで実行）。変更後の公開範囲だけを取得し、何も書き込まない。
function Start-HubPermissionConfirmJob {
    $toggle = $script:Ui.PermissionToggle # 進行中の切り替え。
    Add-LogLine ''
    Add-LogLine "=== 権限を切り替え（$(Get-HubPermissionKindLabel -Kind $toggle.Kind): $($toggle.Direction)。$($toggle.State.Name)。まず変更後の公開範囲を確認します）"
    $values = [ordered]@{ 'project-root' = [string]$toggle.State.Root; 'profile' = [string]$toggle.State.Profile } # SetPermission に渡す値。
    if ($toggle.Kind -eq 'SourceRead') { $values['source-read'] = $toggle.Direction } else { $values['claude-code'] = $toggle.Direction }
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'SetPermission' -Values $values
    $script:Ui.PermissionJob = Start-CliJob -ArgumentList $arguments -Kind 'PermissionConfirm' -CaptureOutput
    Update-ButtonState
}

# 切り替えの確認（SetPermission 指紋なし）が終わったあと。レポートを検証し、承認済みならそのまま終え、そうでなければ承認ダイアログを出す。
function Complete-HubPermissionConfirmJob {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode)
    $script:Ui.PermissionJob = $null
    $toggle = $script:Ui.PermissionToggle # 進行中の切り替え。
    $rawOutput = $Job.Output.ToString() # 溜めた標準出力。
    if ($null -eq $toggle) {
        Write-ExitSummary -ExitCode $ExitCode -Label '権限の切り替え（確認）'
        Update-ButtonState
        return
    }
    if ($ExitCode -ne 0) {
        if ($rawOutput.Trim() -ne '') { Add-LogLine -Line $rawOutput.TrimEnd() -FromCli }
        Write-ExitSummary -ExitCode $ExitCode -Label '権限の切り替え（確認）'
        Add-LogLine "$($toggle.State.Name): 変更後の公開範囲を確認できなかったため、中止しました。何も書き込んでいません。"
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        return
    }
    $report = $null # 確認結果（読めなければ $null のまま）。
    try {
        $report = ConvertFrom-ExposureReport -Text $rawOutput
    } catch {
        Add-LogLine "権限の切り替えの確認結果を JSON として読めませんでした。理由: $($_.Exception.Message)"
        Add-LogLine -Line $rawOutput.TrimEnd() -FromCli
    }
    if ($null -eq $report) {
        Add-LogLine "$($toggle.State.Name): 確認結果を読めなかったため、中止しました。何も書き込んでいません。"
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        return
    }
    # 確認結果が、渡したプロファイルと行のフォルダーを指しているかを確かめる（別のプロジェクトを切り替えてしまわないように）。
    $reportRoot = (Get-EntryText -Entry $report -Name 'projectRoot').TrimEnd('\') # 確認結果のフォルダー。
    $rowRoot = ([string]$toggle.State.Root).TrimEnd('\') # 行のフォルダー。
    if (-not [string]::Equals((Get-EntryText -Entry $report -Name 'profile'), [string]$toggle.State.Profile, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals($reportRoot, $rowRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Add-LogLine "$($toggle.State.Name): 確認結果のプロファイルまたはフォルダーが一致しないため、中止しました。何も書き込んでいません。"
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        Show-GuiMessage -Warning -Text '確認結果が選んだプロジェクトと一致しないため、中止しました（CLI は書き込んでいません）。'
        return
    }
    if (Test-ExposureApproved -Report $report) {
        Add-LogLine "$($toggle.State.Name): 変更はありません（承認済みのまま）。"
        $script:Ui.PermissionToggle = $null
        Start-HubPermissionCheckJob
        return
    }
    $approval = Show-ApprovalDialog -Report $report -ExtraNote 'この承認で、プロジェクトの設定ファイル（.chatgpt-project-bridge.json）も書き換わります。キャンセルすると何も変わりません。' # 利用者の承認。キャンセルなら $null。
    if ($null -eq $approval) {
        Add-LogLine "$($toggle.State.Name): 承認しませんでした。設定は変わりません。"
        $script:Ui.PermissionToggle = $null
        Update-ButtonState
        return
    }
    Add-LogLine "$($toggle.State.Name): 承認ダイアログで承認しました（指紋 $($approval.Sha256)）。CLI が現在の公開範囲と再照合します。"
    Start-HubPermissionApplyJob -Approval $approval
}

# 切り替えの適用（SetPermission を指紋付きで実行）。承認ダイアログで承認した指紋と一致したときだけ、CLI が設定を書き換え、承認を保存する。
function Start-HubPermissionApplyJob {
    param([Parameter(Mandatory)][object]$Approval)
    $toggle = $script:Ui.PermissionToggle # 進行中の切り替え。
    $values = [ordered]@{ 'project-root' = [string]$toggle.State.Root; 'profile' = [string]$toggle.State.Profile } # SetPermission に渡す値。
    if ($toggle.Kind -eq 'SourceRead') { $values['source-read'] = $toggle.Direction } else { $values['claude-code'] = $toggle.Direction }
    $arguments = New-CliArgumentList -CliPath $script:CliPath -ActionName 'SetPermission' -Values $values
    Add-ApprovedExposureArgument -ArgumentList $arguments -Approval $Approval
    $script:Ui.PermissionJob = Start-CliJob -ArgumentList $arguments -Kind 'PermissionApply' -CaptureOutput
    Update-ButtonState
}

# 切り替えの適用（SetPermission 指紋付き）が終わったあと。結果をログへ出し、権限を確認し直して一覧の列を更新する。
function Complete-HubPermissionApplyJob {
    param([Parameter(Mandatory)][hashtable]$Job, [int]$ExitCode)
    $script:Ui.PermissionJob = $null
    $toggle = $script:Ui.PermissionToggle # 進行中の切り替え（ログの見出しにだけ使う）。
    $script:Ui.PermissionToggle = $null
    $rawOutput = $Job.Output.ToString() # 溜めた標準出力。
    if ($rawOutput.Trim() -ne '') { Add-LogLine -Line $rawOutput.TrimEnd() -FromCli }
    $label = if ($null -ne $toggle) { "権限の切り替え（$(Get-HubPermissionKindLabel -Kind $toggle.Kind)）" } else { '権限の切り替え' } # ログに出す見出し。
    Write-ExitSummary -ExitCode $ExitCode -Label $label
    Start-HubPermissionCheckJob
}

# ---------------------------------------------------------------------------
# ダイアログ
# ---------------------------------------------------------------------------

# 承認ダイアログの「この内容で承認」の有効・無効を、ダイアログの状態（禁止文字・末尾まで表示・各チェック）から決める。
function Update-ApprovalButtonState {
    param([Parameter(Mandatory)][hashtable]$State)
    $overwriteChecked = ($null -ne $State.OverwriteCheck) -and [bool]$State.OverwriteCheck.Checked # 上書きの確認にチェックしたか。
    $State.ApproveButton.Enabled = Test-ApprovalAllowed -Blocked $State.Blocked -ReachedEnd $State.ReachedEnd -ReadChecked ([bool]$State.ReadCheck.Checked) -NeedsOverwriteConfirm $State.NeedsOverwriteConfirm -OverwriteChecked $overwriteChecked
}

# 承認ダイアログの見出しと要約の文を折り返す幅（ボタンの並びの幅も同じ）を、ダイアログの中の幅から決める（既定の大きさで 840。狭くても 200）。
function Get-ApprovalTextWidth {
    param([int]$ClientWidth)
    return [Math]::Max(200, $ClientWidth - 40)
}

# 承認ダイアログの大きさが変わったとき（最大化を含む）、見出しと要約の文の折り返し幅と、ボタンの並びの幅を合わせ直す。
# ボタンの並びは右から詰めるため、ダイアログより広いままだと、狭くしたときに右端の「キャンセル」が隠れる。それを防ぐ。
function Update-ApprovalDialogWidth {
    param([Parameter(Mandatory)][hashtable]$State)
    $textWidth = Get-ApprovalTextWidth -ClientWidth $State.Dialog.ClientSize.Width # 新しい幅。
    if ($State.ButtonPanel.Width -eq $textWidth) { return }
    $State.Dialog.SuspendLayout()
    try {
        foreach ($wrapLabel in $State.WrapLabels) { $wrapLabel.MaximumSize = [System.Drawing.Size]::new($textWidth, 0) }
        $State.ButtonPanel.Width = $textWidth
    } finally {
        $State.Dialog.ResumeLayout($true)
    }
}

# 承認ダイアログの一覧を末尾まで表示したかを調べ、表示したら「内容を読みました」を押せるようにする（一度押せるようにしたら戻さない）。
# タイマー（150ms）とダイアログの表示直後に呼ぶ。スクロール位置は ListBox の TopIndex・ClientSize・ItemHeight から求める（P/Invoke は使わない）。
# タイマーは末尾まで表示するまで止めないため、ダイアログを広げて一覧が全部見えるようになった場合も、次の回で押せるようになる。
function Update-ApprovalReadGate {
    param([Parameter(Mandatory)][hashtable]$State)
    if (-not $State.ReachedEnd) {
        $listBox = $State.ListBox # 詳細の一覧。
        if (Test-ListScrolledToEnd -TopIndex $listBox.TopIndex -ItemCount $listBox.Items.Count -ClientHeight $listBox.ClientSize.Height -ItemHeight $listBox.ItemHeight) {
            $State.ReachedEnd = $true
            $State.ReadCheck.Enabled = $true
            if (-not $State.Blocked) { $State.ReadHint.Text = '一覧を末尾まで表示しました。読み終えたらチェックしてください。' }
            $State.Timer.Stop()
        }
    }
    Update-ApprovalButtonState -State $State
}

# 承認ダイアログ。上から「固定の見出し（承認状態・プロジェクトルート・プロファイル・ハブの警告）」、
# 「詳細の一覧（ListBox。1 行 1 項目でスクロールする。省略しない）」、「承認できない理由・別フォルダーの上書きの警告」、
# 「固定の要約（件数・Git・上限・指紋。スクロールしない）」、「内容を読みました」、「ボタン」の順に並べる。
# 「この内容で承認」は、禁止文字が無く、一覧を末尾まで表示して「内容を読みました」にチェックし、
# 別フォルダーの承認を上書きする場合はその確認にもチェックしたときだけ押せる。押したあとも同じ条件で確かめ直す。
# キャンセル（既定のボタン）や閉じた場合は $null を返す。利用者の操作なしに承認の結果を返す経路は無い。
function Show-ApprovalDialog {
    param([Parameter(Mandatory)][object]$Report, [switch]$IsHub, [string]$Title = '公開範囲の承認', [AllowEmptyString()][string]$ExtraNote = '')
    $forbiddenFields = Get-ForbiddenFieldList -Report $Report # 禁止文字を含む項目。1 つでもあれば承認できない。
    $shapeProblems = Get-ExposureShapeProblem -Report $Report # 形が想定と違う欄。1 つでもあれば承認できない。
    $blockReasons = @(Get-ApprovalBlockReason -ForbiddenField $forbiddenFields.ToArray() -ShapeProblem $shapeProblems.ToArray()) # 承認できない理由。
    $blocked = [bool]($blockReasons.Count -gt 0) # 承認を止めるか。
    $needsOverwriteConfirm = [bool](Test-ForeignApprovalOverwrite -Report $Report) # 別のフォルダーの承認を上書きするか。
    $summary = Get-ApprovalSummary -Report $Report # 固定の要約（構造化データから作る）。
    $detailLines = Get-ApprovalDetailLine -Report $Report -ForbiddenField $forbiddenFields.ToArray() -ShapeProblem $shapeProblems.ToArray() # 一覧の各行。
    $dialog = New-GuiComponent -TypeName 'Form' -Property ([ordered]@{
            Text = (ConvertTo-SafeLogLine -Text $Title)
            StartPosition = [System.Windows.Forms.FormStartPosition]::CenterParent
            ClientSize = [System.Drawing.Size]::new(880, 700)
            MinimumSize = [System.Drawing.Size]::new(720, 600)
            MinimizeBox = $false
            MaximizeBox = $true
            ShowInTaskbar = $false
        }) # 承認ダイアログ。最大化を許す（狭い画面でも、一覧を広げて読めるように）。
    # 表示する画面の作業領域に収める（高 DPI では既定の大きさが画面より大きくなり、下端のボタンが隠れることがあるため）。
    Resize-FormToWorkingArea -Form $dialog -WorkingArea (Get-DisplayWorkingArea -Owner $script:Ui.Form)
    $textWidth = Get-ApprovalTextWidth -ClientWidth $dialog.ClientSize.Width # 見出しと要約の文を折り返す幅（既定の大きさで 840。大きさを変えると Update-ApprovalDialogWidth が合わせ直す）。
    $wrapLabels = [System.Collections.Generic.List[object]]::new() # 幅を合わせ直す見出しと要約の文。
    $boldFont = [System.Drawing.Font]::new($dialog.Font, [System.Drawing.FontStyle]::Bold) # 警告と「公開」の表示に使う太字。
    $timer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 150 }) # 一覧を末尾まで表示したかを調べるタイマー。
    $approved = $false # 利用者が承認したか。
    try {
        # 固定の見出し（スクロールしない）。
        $headerPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                Dock = [System.Windows.Forms.DockStyle]::Top
                FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
                WrapContents = $false
                AutoSize = $true
                AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            }) # 見出しの並び。
        $stateLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'ShowExposure（読み取りだけ）が返した承認状態です。未承認・変更あり（前回の承認から公開範囲が変わった）のときに、このダイアログを出します。' -Property ([ordered]@{
                Text = '承認状態: ' + (Get-ApprovalHeaderStateText -Report $Report)
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
                Font = $boldFont
            }) # 承認状態。
        $rootLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'ChatGPT へ公開するプロジェクトのフォルダーです（サーバーが正規化したもの）。制御文字や空白類は \u の形で、引用符の中に示します。全体は下の一覧にもあります。' -Property ([ordered]@{
                Text = (Get-ApprovalRootText -Report $Report)
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
            }) # プロジェクトルート。
        $profileLabel = New-GuiControl -TypeName 'Label' -ToolTipText '承認を保存する名前（approvals フォルダーのファイル名）です。同じ名前の承認は上書きされます。' -Property ([ordered]@{
                Text = 'プロファイル（承認の保存先の名前）: ' + (Format-DisplayValue -Text (Get-EntryText -Entry $Report -Name 'profile'))
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
            }) # プロファイル。
        $headerPanel.Controls.Add($stateLabel)
        $headerPanel.Controls.Add($rootLabel)
        $headerPanel.Controls.Add($profileLabel)
        $wrapLabels.Add($stateLabel)
        $wrapLabels.Add($rootLabel)
        $wrapLabels.Add($profileLabel)
        if (-not [string]::IsNullOrWhiteSpace($ExtraNote)) {
            $noteLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'この承認でほかに何が書き換わるかの注記です（かんたんタブの権限の切り替えなど、呼び出し元ごとに添えます）。' -Property ([ordered]@{
                    Text = $ExtraNote
                    AutoSize = $true
                    MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
                    ForeColor = [System.Drawing.Color]::DarkRed
                    Font = $boldFont
                }) # 呼び出し元ごとの注記。
            $headerPanel.Controls.Add($noteLabel)
            $wrapLabels.Add($noteLabel)
        }
        if ($IsHub) {
            $warningLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'ハブ方式の影響範囲の注意です（説明データの「プロジェクトを追加」（hub-add）の注意から引いています）。' -Property ([ordered]@{
                    Text = (Get-HubWarningText -Help $script:Ui.Help)
                    AutoSize = $true
                    MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
                    ForeColor = [System.Drawing.Color]::DarkRed
                    Font = $boldFont
                }) # ハブ方式の警告。
            $headerPanel.Controls.Add($warningLabel)
            $wrapLabels.Add($warningLabel)
        }

        # 詳細の一覧（1 行 1 項目。改行の扱いと文字数の上限に左右されないよう、複数行の TextBox は使わない）。
        $listBox = New-GuiControl -TypeName 'ListBox' -ToolTipText 'ShowExposure（読み取りだけ）が返した公開範囲の全項目です。値は引用符で囲み、制御文字・行区切り・双方向制御文字・空白類は \u の形で示します。末尾までスクロールすると「内容を読みました」にチェックできます。' -Property ([ordered]@{
                Dock = [System.Windows.Forms.DockStyle]::Fill
                IntegralHeight = $false
                HorizontalScrollbar = $true
                SelectionMode = [System.Windows.Forms.SelectionMode]::None
            }) # 詳細の一覧。
        $listBox.BeginUpdate()
        try {
            foreach ($detailLine in $detailLines) { [void]$listBox.Items.Add($detailLine) }
        } finally {
            $listBox.EndUpdate()
        }

        # 一覧の下の固定部分（スクロールしない）: 承認できない理由・上書きの警告・要約・読んだことの確認・ボタン。
        $footerPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                Dock = [System.Windows.Forms.DockStyle]::Bottom
                FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
                WrapContents = $false
                AutoSize = $true
                AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            }) # 一覧の下の並び。
        foreach ($blockReason in $blockReasons) {
            $blockLabel = New-GuiControl -TypeName 'Label' -ToolTipText '表示と実際の値がずれる文字（改行・行区切り・右から左への書き換え・見えない文字など）を含む設定や、形式が想定と違う公開範囲は、この画面では承認できません。設定ファイルを直してから、もう一度実行してください。' -Property ([ordered]@{
                    Text = $blockReason
                    AutoSize = $true
                    MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
                    ForeColor = [System.Drawing.Color]::Red
                    Font = $boldFont
                }) # 承認できない理由（赤字）。
            $footerPanel.Controls.Add($blockLabel)
            $wrapLabels.Add($blockLabel)
        }
        $overwriteCheck = $null # 別のフォルダーの承認を上書きする確認（必要なときだけ作る）。
        if ($needsOverwriteConfirm) {
            $approvedRootText = ConvertTo-DisplayQuoted -Text ([string](Get-EntryValue -Entry $Report -Name 'approvedProjectRoot')) # 前回の承認に記録されたフォルダー。
            $overwriteLabel = New-GuiControl -TypeName 'Label' -ToolTipText '同じプロファイル名で、別のフォルダーの公開範囲が承認されています。承認すると、そのフォルダーの承認を置き換えます。プロファイル名の取り違えや、設定の偽装でないかを確かめてください。' -Property ([ordered]@{
                    Text = '警告: このプロファイル名の前回の承認は、別のフォルダー ' + $approvedRootText + ' のものです。承認すると、そのフォルダーの承認を上書きします（プロファイル名の取り違えや、設定の偽装の可能性があります）。'
                    AutoSize = $true
                    MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
                    ForeColor = [System.Drawing.Color]::Red
                    Font = $boldFont
                }) # 上書きの警告（赤字）。
            $overwriteCheck = New-GuiControl -TypeName 'CheckBox' -ToolTipText '別のフォルダーの承認を上書きしてよい場合だけチェックします。チェックするまで「この内容で承認」は押せません。' -Property ([ordered]@{
                    Text = '別のフォルダーの承認を上書きしてよいことを理解しました'
                    AutoSize = $true
                    Checked = $false
                }) # 上書きの確認。
            $footerPanel.Controls.Add($overwriteLabel)
            $footerPanel.Controls.Add($overwriteCheck)
            $wrapLabels.Add($overwriteLabel)
        }
        $countLabel = New-GuiControl -TypeName 'Label' -ToolTipText '公開範囲の件数です。ShowExposure の結果の配列の長さから数えています（値の文字列からは作りません）。' -Property ([ordered]@{
                Text = $summary.CountLine
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
            }) # 件数の要約。
        $gitPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
                WrapContents = $false
                AutoSize = $true
                AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            }) # Git の公開設定の並び。
        $gitPathsLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'Git の状態に出るファイル名を ChatGPT へ出すかです。公開のときは太字の赤で示します。' -Property ([ordered]@{
                Text = $summary.GitPathsText
                AutoSize = $true
            }) # Git のファイル名の公開設定。
        $gitSubjectsLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'Git のコミット件名を ChatGPT へ出すかです。公開のときは太字の赤で示します。' -Property ([ordered]@{
                Text = '/ ' + $summary.GitCommitSubjectsText
                AutoSize = $true
            }) # Git のコミット件名の公開設定。
        if ($summary.GitPathsPublic) {
            $gitPathsLabel.ForeColor = [System.Drawing.Color]::Red
            $gitPathsLabel.Font = $boldFont
        }
        if ($summary.GitCommitSubjectsPublic) {
            $gitSubjectsLabel.ForeColor = [System.Drawing.Color]::Red
            $gitSubjectsLabel.Font = $boldFont
        }
        $gitPanel.Controls.Add($gitPathsLabel)
        $gitPanel.Controls.Add($gitSubjectsLabel)
        $limitLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'ChatGPT が 1 回に読める文書 1 件の大きさの上限です。' -Property ([ordered]@{
                Text = $summary.LimitLine
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
            }) # 文書 1 件の上限。
        $shaLabel = New-GuiControl -TypeName 'Label' -ToolTipText '承認すると、この指紋を -ExposureSha256 として CLI へ渡します。CLI が現在の公開範囲の指紋と照合し、一致したときだけ承認を保存します（64 桁すべてを表示します）。' -Property ([ordered]@{
                Text = $summary.ShaLine
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($textWidth, 0)
            }) # 公開範囲の指紋。
        $footerPanel.Controls.Add($countLabel)
        $footerPanel.Controls.Add($gitPanel)
        $footerPanel.Controls.Add($limitLabel)
        $footerPanel.Controls.Add($shaLabel)
        $wrapLabels.Add($countLabel)
        $wrapLabels.Add($limitLabel)
        $wrapLabels.Add($shaLabel)
        $readPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
                WrapContents = $false
                AutoSize = $true
                AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            }) # 読んだことの確認の並び。
        $readCheck = New-GuiControl -TypeName 'CheckBox' -ToolTipText '上の一覧を末尾までスクロールすると押せるようになります。全部読んだらチェックします。チェックするまで「この内容で承認」は押せません。' -Property ([ordered]@{
                Text = '内容を読みました'
                AutoSize = $true
                Checked = $false
                Enabled = $false
            }) # 読んだことの確認。
        $readHintText = if ($blocked) { 'この内容は承認できません（「キャンセル」だけ押せます）。' } else { '一覧を末尾までスクロールすると、チェックできるようになります。' } # 読んだことの確認の案内。
        $readHint = New-GuiControl -TypeName 'Label' -ToolTipText '「内容を読みました」は、一覧の最後の行（「一覧はここまでです」）が見えるまでスクロールすると押せるようになります。' -Property ([ordered]@{
                Text = $readHintText
                AutoSize = $true
                ForeColor = [System.Drawing.Color]::DimGray
            }) # 読んだことの確認の案内。
        $readPanel.Controls.Add($readCheck)
        $readPanel.Controls.Add($readHint)
        $footerPanel.Controls.Add($readPanel)
        $buttonPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
                WrapContents = $false
                Width = $textWidth
                Height = 40
            }) # ボタンの並び（幅はダイアログの幅に合わせる。右から詰めるため、ダイアログより広いと右端のボタンが隠れる）。
        $cancelButton = New-GuiControl -TypeName 'Button' -ToolTipText '承認せずに閉じます。承認は保存せず、CLI も実行しません。このプロジェクトは公開されません。Enter と Esc もこのボタンです。' -Property ([ordered]@{
                Text = 'キャンセル'
                DialogResult = [System.Windows.Forms.DialogResult]::Cancel
                AutoSize = $true
            }) # キャンセル（既定のボタン）。
        $approveButton = New-GuiControl -TypeName 'Button' -ToolTipText '表示した指紋を -ExposureSha256 として CLI へ渡します。CLI が現在の公開範囲と再照合し、一致したときだけ承認を保存します。一覧を末尾まで表示して「内容を読みました」にチェックするまで（別フォルダーの上書きがあるときはその確認も）押せません。承認できない文字を含む設定では、常に押せません。' -Property ([ordered]@{
                Text = 'この内容で承認'
                DialogResult = [System.Windows.Forms.DialogResult]::OK
                AutoSize = $true
                Enabled = $false
            }) # 承認ボタン。
        $buttonPanel.Controls.Add($cancelButton)
        $buttonPanel.Controls.Add($approveButton)
        $footerPanel.Controls.Add($buttonPanel)

        # ダイアログの状態。イベントの処理へは Tag で渡す（関数の変数をイベントの処理から直接は参照しない）。
        $state = @{
            ApproveButton = $approveButton
            ReadCheck = $readCheck
            ReadHint = $readHint
            OverwriteCheck = $overwriteCheck
            ListBox = $listBox
            Timer = $timer
            Blocked = $blocked
            NeedsOverwriteConfirm = $needsOverwriteConfirm
            ReachedEnd = $false
            Dialog = $dialog
            WrapLabels = $wrapLabels
            ButtonPanel = $buttonPanel
        } # 承認ダイアログの状態。
        $readCheck.Tag = $state
        $readCheck.Add_CheckedChanged({
                try { Update-ApprovalButtonState -State $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
            })
        if ($null -ne $overwriteCheck) {
            $overwriteCheck.Tag = $state
            $overwriteCheck.Add_CheckedChanged({
                    try { Update-ApprovalButtonState -State $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
                })
        }
        $timer.Tag = $state
        $timer.Add_Tick({
                try { Update-ApprovalReadGate -State $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
            })
        $dialog.Tag = $state
        $dialog.Add_Shown({
                try { Update-ApprovalReadGate -State $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
            })
        # 大きさを変えたら（最大化を含む）、文の折り返し幅とボタンの並びの幅を合わせ直す。末尾まで表示したかは、タイマーが大きさを変えたあとも調べ続ける。
        $dialog.Add_Resize({
                try { Update-ApprovalDialogWidth -State $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
            })
        # Dock の配置は Controls の後ろの要素から順に決まる。一覧（Fill）を先頭に、下（Bottom）、上（Top）の順に追加する。
        $dialog.Controls.Add($listBox)
        $dialog.Controls.Add($footerPanel)
        $dialog.Controls.Add($headerPanel)
        $dialog.AcceptButton = $cancelButton
        $dialog.CancelButton = $cancelButton
        $dialog.ActiveControl = $cancelButton
        $timer.Start()
        $result = $dialog.ShowDialog($script:Ui.Form) # ダイアログの結果。
        $overwriteChecked = ($null -ne $overwriteCheck) -and [bool]$overwriteCheck.Checked # 上書きの確認にチェックしたか。
        # 押したあとも、ボタンを押せる条件と同じ条件で確かめ直す。
        $approved = ($result -eq [System.Windows.Forms.DialogResult]::OK) -and (Test-ApprovalAllowed -Blocked $blocked -ReachedEnd $state.ReachedEnd -ReadChecked ([bool]$readCheck.Checked) -NeedsOverwriteConfirm $needsOverwriteConfirm -OverwriteChecked $overwriteChecked)
    } finally {
        $timer.Stop()
        $timer.Dispose()
        $dialog.Dispose()
        $boldFont.Dispose()
    }
    if (-not $approved) { return $null }
    return [pscustomobject]@{ ApprovedByUser = $true; Sha256 = [string]$Report.exposureSha256 }
}

# 上書き系のオプションを有効にする前の確認ダイアログ。「それでも有効にする」を押したときだけ $true を返す（既定はキャンセル）。
function Show-DangerConfirmDialog {
    param([AllowEmptyString()][string]$Label, [AllowEmptyString()][string]$Caution)
    $dialog = New-GuiComponent -TypeName 'Form' -Property ([ordered]@{
            Text = '上書き系の設定の確認'
            StartPosition = [System.Windows.Forms.FormStartPosition]::CenterParent
            ClientSize = [System.Drawing.Size]::new(560, 300)
            FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
            MinimizeBox = $false
            MaximizeBox = $false
            ShowInTaskbar = $false
        }) # 確認ダイアログ。
    $bodyText = "「$($Label)」を有効にしますか?`r`n`r`n$($Caution)`r`n`r`nこの指定は保存しません（このカードの次の 1 回の実行だけに効き、実行を始めるとオフに戻ります）。" # 確認の本文（Ubuntu 版と同じ扱い）。
    $bodyLabel = New-GuiControl -TypeName 'Label' -ToolTipText '上書き系のオプションを有効にする前の確認です。上書きの対象は、オプションの説明の【注意】に書いてあります。' -Property ([ordered]@{
            Text = $bodyText
            Dock = [System.Windows.Forms.DockStyle]::Fill
            AutoSize = $false
        }) # 確認の本文。
    $buttonPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Bottom
            FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
            Height = 44
        }) # ボタンの並び。
    $cancelButton = New-GuiControl -TypeName 'Button' -ToolTipText '有効にせず、チェックをオフに戻します。Enter と Esc もこのボタンです。' -Property ([ordered]@{
            Text = 'キャンセル'
            DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            AutoSize = $true
        }) # キャンセル（既定のボタン）。
    $confirmButton = New-GuiControl -TypeName 'Button' -ToolTipText 'このカードでだけ、このオプションを有効にします。実行するとき CLI へ渡します。' -Property ([ordered]@{
            Text = 'それでも有効にする'
            DialogResult = [System.Windows.Forms.DialogResult]::OK
            AutoSize = $true
        }) # 有効にするボタン。
    $buttonPanel.Controls.Add($cancelButton)
    $buttonPanel.Controls.Add($confirmButton)
    # 本文（Fill）を先に追加し、ボタンの並び（Bottom）を後に追加する。
    $dialog.Controls.Add($bodyLabel)
    $dialog.Controls.Add($buttonPanel)
    $dialog.AcceptButton = $cancelButton
    $dialog.CancelButton = $cancelButton
    $dialog.ActiveControl = $cancelButton
    try {
        return ($dialog.ShowDialog($script:Ui.Form) -eq [System.Windows.Forms.DialogResult]::OK)
    } finally {
        $dialog.Dispose()
    }
}

# ---------------------------------------------------------------------------
# 画面の組み立て
# ---------------------------------------------------------------------------

# タブの説明（ツールチップ）。この画面の文。
function Get-GroupDescription {
    param([Parameter(Mandatory)][string]$GroupKey, [AllowEmptyString()][string]$GroupLabel)
    switch ($GroupKey) {
        'easy' { return 'よく使う操作（ハブ方式でのプロジェクトの追加・起動・停止・状態の確認）と、確認の 5 段階をまとめたタブです。' }
        'hub' { return 'ハブ方式（このPCの全プロジェクトを 1 つの Tunnel・App・キーで公開する方式）の、残りの操作です。' }
        'legacy' { return '従来方式（プロジェクトごとに別の Tunnel を使う方式）の操作です。' }
        'maintainer' { return '署名鍵や gh（GitHub CLI）を使う、配布物の作成者向けの操作です。' }
        default { return "$($GroupLabel)の操作です。" }
    }
}

# 入力欄を、同じオプション名の欄の一覧へ登録する（値を全カードで共有するため）。共有しない欄（Test-SharedInputOption が偽）は登録しない。
function Register-SharedInput {
    param([Parameter(Mandatory)][string]$OptionName, [Parameter(Mandatory)][object]$Control)
    if (-not $script:Ui.SharedInputs.ContainsKey($OptionName)) { $script:Ui.SharedInputs[$OptionName] = [System.Collections.Generic.List[object]]::new() }
    $script:Ui.SharedInputs[$OptionName].Add($Control)
}

# 1 つの Action のカード（見出し・概要・オプションの格子・チェック・実行ボタン）を作り、カードの状態を返す。
function New-ActionCard {
    param([Parameter(Mandatory)][string]$ActionKey, [Parameter(Mandatory)][object]$Action, [int]$CardWidth = 900)
    $help = $script:Ui.Help # 説明文の共有データ。
    $actionName = ConvertTo-PascalName -Name $ActionKey # CLI の Action 名。
    $label = Get-EntryText -Entry $Action -Name 'label' # カードの見出し。
    if ($label -eq '') { $label = $actionName }
    $actionTip = Get-ActionToolTipText -Action $Action # 見出しと概要の説明。
    $runTip = Get-ActionToolTipText -Action $Action -GuiNote (Get-ActionGuiNote -ActionName $actionName) # 実行ボタンの説明。
    $card = @{
        ActionKey = $ActionKey
        ActionName = $actionName
        Action = $Action
        Label = $label
        Inputs = @{} # オプション名 → 入力欄。
        Kinds = @{} # オプション名 → kind。
        ValueOrder = [System.Collections.Generic.List[string]]::new() # 値を取る欄の並び。
        FlagOrder = [System.Collections.Generic.List[string]]::new() # チェックの並び。
        RunButton = $null
        StopButton = $null
        HubStopTried = $false # 停止のための HubStop を一度実行したか。
        GroupBox = $null
    } # カードの状態。
    $groupBox = New-GuiControl -TypeName 'GroupBox' -ToolTipText $actionTip -Property ([ordered]@{
            Text = $label
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            MinimumSize = [System.Drawing.Size]::new($CardWidth, 0)
            MaximumSize = [System.Drawing.Size]::new($CardWidth, 0)
        }) # カードの枠。
    $inner = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
            WrapContents = $false
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            Location = [System.Drawing.Point]::new(10, 22)
        }) # カードの中身を上から並べる枠。
    $summaryLabel = New-GuiControl -TypeName 'Label' -ToolTipText $actionTip -Property ([ordered]@{
            Text = (Get-EntryText -Entry $Action -Name 'summary')
            AutoSize = $true
            MaximumSize = [System.Drawing.Size]::new($CardWidth - 40, 0)
        }) # 概要の 1 行。
    $inner.Controls.Add($summaryLabel)

    $requiredNames = @(Get-EntryList -Entry $Action -Name 'required' | ForEach-Object { [string]$_ }) # 必須のオプション名。
    $visibleNames = @(Get-VisibleOptionName -ActionKey $ActionKey -Action $Action -CliParameters $script:Ui.CliParameters) # 出すオプション名。
    $valueNames = @($visibleNames | Where-Object { (Get-EntryText -Entry (Get-OptionEntry -Help $help -OptionName $_) -Name 'kind') -ne 'flag' }) # 値を取るオプション。
    $flagNames = @($visibleNames | Where-Object { (Get-EntryText -Entry (Get-OptionEntry -Help $help -OptionName $_) -Name 'kind') -eq 'flag' }) # チェックのオプション。

    if ($valueNames.Count -gt 0) {
        $grid = New-GuiControl -TypeName 'TableLayoutPanel' -LayoutOnly -Property ([ordered]@{
                ColumnCount = 3
                RowCount = $valueNames.Count
                AutoSize = $true
                AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            }) # ラベル・入力欄・選択ボタンの格子。
        $rowIndex = 0 # 追加する行。
        foreach ($optionName in $valueNames) {
            $option = Get-OptionEntry -Help $help -OptionName $optionName # オプションの説明。
            $kind = Get-EntryText -Entry $option -Name 'kind' # 入力欄の種類。
            $optionLabel = Get-EntryText -Entry $option -Name 'label' # 欄の名前。
            if ($optionLabel -eq '') { $optionLabel = $optionName }
            $optionTip = Get-OptionToolTipText -Option $option # ラベルと入力欄の説明。
            $labelText = if ($requiredNames -contains $optionName) { $optionLabel + '＊' } else { $optionLabel } # 必須なら末尾に＊。
            $nameLabel = New-GuiControl -TypeName 'Label' -ToolTipText $optionTip -Property ([ordered]@{
                    Text = $labelText
                    AutoSize = $true
                    Anchor = [System.Windows.Forms.AnchorStyles]::Left
                }) # 欄のラベル。
            if ($kind -eq 'number') {
                $inputControl = New-GuiControl -TypeName 'NumericUpDown' -ToolTipText $optionTip -Property ([ordered]@{
                        Minimum = 0
                        Maximum = 65535
                        Value = 0
                        Width = 120
                        Tag = $optionName
                    }) # 数値の入力欄。
                $inputControl.Add_ValueChanged({
                        try { Sync-SharedInput -Source $this } catch { Write-GuiError -ErrorRecord $_ }
                    })
            } else {
                $inputControl = New-GuiControl -TypeName 'TextBox' -ToolTipText $optionTip -Property ([ordered]@{
                        Width = 560
                        Tag = $optionName
                    }) # 文字列・パスの入力欄。
                $inputControl.Add_TextChanged({
                        try { Sync-SharedInput -Source $this } catch { Write-GuiError -ErrorRecord $_ }
                    })
            }
            # 「プロジェクトを追加」（HubAdd）の Tunnel ID だけは、ほかのカードと値を共有しない（$script:UnsharedInputOptions）。
            if (Test-SharedInputOption -ActionName $actionName -OptionName $optionName) { Register-SharedInput -OptionName $optionName -Control $inputControl }
            $grid.Controls.Add($nameLabel, 0, $rowIndex)
            $grid.Controls.Add($inputControl, 1, $rowIndex)
            if ($kind -eq 'path') {
                $mode = Get-PathDialogMode -OptionName $optionName -ActionKey $ActionKey # 開く選択画面の種類。
                $selectNote = if ($mode -eq 'Folder') { 'フォルダーを選ぶ画面を開き、選んだフォルダーを左の欄へ入れます。' } elseif ($mode -eq 'SaveFile') { '保存先のファイル名を選ぶ画面を開き、選んだパスを左の欄へ入れます（既存のファイルの上書きは、上書きを許可（force）にチェックしたときだけ CLI が行います）。' } else { 'ファイルを選ぶ画面を開き、選んだファイルのパスを左の欄へ入れます。' } # 選択ボタンの説明。
                $selectButton = New-GuiControl -TypeName 'Button' -ToolTipText ($selectNote + "`r`n`r`n" + $optionTip) -Property ([ordered]@{
                        Text = '選択…'
                        AutoSize = $true
                        Tag = @{ TextBox = $inputControl; OptionName = $optionName; ActionKey = $ActionKey; Label = $optionLabel }
                    }) # 選択ボタン。
                $selectButton.Add_Click({
                        try { Select-PathForInput -Target $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
                    })
                $grid.Controls.Add($selectButton, 2, $rowIndex)
            }
            $card.Inputs[$optionName] = $inputControl
            $card.Kinds[$optionName] = $kind
            $card.ValueOrder.Add($optionName)
            $rowIndex++
        }
        $inner.Controls.Add($grid)
    }

    if ($flagNames.Count -gt 0) {
        $flagPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
                WrapContents = $true
                AutoSize = $true
                MaximumSize = [System.Drawing.Size]::new($CardWidth - 40, 0)
            }) # チェックの並び。
        foreach ($optionName in $flagNames) {
            $option = Get-OptionEntry -Help $help -OptionName $optionName # オプションの説明。
            $dangerous = Test-EntryFlag -Entry $option -Name 'dangerous' # 上書き系か。
            $flagNote = if ($dangerous) { 'オンにするたびに確認ダイアログを出します。このカードの次の 1 回の実行だけに効き、実行を始めるとオフに戻ります（設定は保存しません）。' } else { 'このカードだけの設定です（他のカードとは共有しません。起動のたびにオフ）。' } # この画面での扱い。
            $flagLabel = Get-EntryText -Entry $option -Name 'label' # チェックの名前。
            if ($flagLabel -eq '') { $flagLabel = $optionName }
            $checkBox = New-GuiControl -TypeName 'CheckBox' -ToolTipText (Get-OptionToolTipText -Option $option -GuiNote $flagNote) -Property ([ordered]@{
                    Text = $flagLabel
                    AutoSize = $true
                    Checked = $false
                    Tag = $optionName
                }) # チェックボックス。
            if ($dangerous) {
                $checkBox.Add_CheckedChanged({
                        try { Confirm-DangerousOption -CheckBox $this } catch { Write-GuiError -ErrorRecord $_ }
                    })
            }
            $flagPanel.Controls.Add($checkBox)
            $card.Inputs[$optionName] = $checkBox
            $card.Kinds[$optionName] = 'flag'
            $card.FlagOrder.Add($optionName)
        }
        $inner.Controls.Add($flagPanel)
    }

    $buttonPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
            AutoSize = $true
        }) # 実行・停止ボタンの並び。
    $runButton = New-GuiControl -TypeName 'Button' -ToolTipText $runTip -Property ([ordered]@{
            Text = '実行'
            AutoSize = $true
            Tag = $card
        }) # 実行ボタン。
    $runButton.Add_Click({
            try { Invoke-ActionCard -Card $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
        })
    $buttonPanel.Controls.Add($runButton)
    $card.RunButton = $runButton
    if ($script:ManagedForegroundActions -contains $actionName) {
        $stopTip = if ($script:HubApprovalActions -contains $actionName) { '「ハブを停止」（HubStop）を実行して、ハブの Tunnel Client を止めます。それでも起動側の CLI が終わらないときは、もう一度押すとプロセスツリーごと止めます。止めると、このPCの全プロジェクトが ChatGPT から読めなくなります。' } else { 'この画面が動かしている CLI を、Tunnel Client ごと（プロセスツリーごと）止めます。止めると、このプロジェクトは ChatGPT から読めなくなります。' } # 停止ボタンの説明。
        $stopButton = New-GuiControl -TypeName 'Button' -ToolTipText $stopTip -Property ([ordered]@{
                Text = '停止'
                AutoSize = $true
                Enabled = $false
                Visible = $false
                Tag = $card
            }) # 停止ボタン（動いている間だけ出す）。
        $stopButton.Add_Click({
                try { Stop-ForegroundAction -Card $this.Tag } catch { Write-GuiError -ErrorRecord $_ }
            })
        $buttonPanel.Controls.Add($stopButton)
        $card.StopButton = $stopButton
    }
    $inner.Controls.Add($buttonPanel)
    $groupBox.Controls.Add($inner)
    $card.GroupBox = $groupBox
    return $card
}

# かんたんタブの先頭（このタブでできること・確認の 5 段階・ハブに登録済みのプロジェクト）を、スクロールする枠へ追加する。
function Add-EasyTabHeader {
    param([Parameter(Mandatory)][object]$Panel, [int]$CardWidth = 900)
    $introText = @(
        '・プロジェクトを追加: フォルダーをハブに登録します。公開範囲は承認ダイアログで確認し、キーは別のコンソール窓で入力します。',
        '・ハブを起動 / ハブを停止: ChatGPT から読めるようにする間は、ハブを動かしておきます。',
        '・登録一覧を表示 / ハブの稼働状態: 登録と承認の状態、Tunnel Client の稼働を確かめます。'
    ) -join "`r`n" # このタブでできること。
    $introLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'このタブには、ハブ方式でよく使う操作だけを並べています。ほかの操作は「ハブ方式」「従来方式」タブにあります。' -Property ([ordered]@{
            Text = $introText
            AutoSize = $true
            MaximumSize = [System.Drawing.Size]::new($CardWidth, 0)
        }) # このタブの説明。
    $Panel.Controls.Add($introLabel)

    $stageBox = New-GuiControl -TypeName 'GroupBox' -ToolTipText 'ChatGPT からプロジェクトを読めるまでの確認を 5 段階に分けています。1 つの表示（緑のランプなど）にまとめず、段階ごとに確かめます。画面の上の「ハブ」の表示が示すのは、3 の Tunnel Client のプロセスの有無だけです。' -Property ([ordered]@{
            Text = '確認の 5 段階'
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            MinimumSize = [System.Drawing.Size]::new($CardWidth, 0)
            MaximumSize = [System.Drawing.Size]::new($CardWidth, 0)
        }) # 5 段階の枠。
    $stageInner = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
            WrapContents = $false
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            Location = [System.Drawing.Point]::new(10, 22)
        }) # 5 段階を上から並べる枠。
    $stages = @(
        @('1. 足場の作成（scaffold）', 'プロジェクトに .chatgpt-project-bridge.json と文書 2 つ（CONTEXT・STATUS）があることです。「プロジェクトを追加」は、足場が無ければ先に「プロジェクトを初期化」（Init）を実行して作ります。'),
        @('2. 自己試験', 'MCP サーバーの自己試験と、公開境界の自己試験です。「プロジェクトを初期化」・プロジェクトの追加・「自己試験」（Test）が実行します。手元のサーバーの確認で、ChatGPT から読めることの証明ではありません。'),
        @('3. Tunnel Client の稼働', '「ハブの稼働状態」（HubStatus）・「稼働状態を表示」（Status）が、Tunnel Client のローカル管理画面（health）から表示します。稼働中の表示は、ChatGPT で読めることの証明ではありません。'),
        @('4. ChatGPT のツール検出', 'ChatGPT の新しいチャットで、App のツール（ハブ方式では list_projects など）が見えるかを確かめます。この画面では確かめられません。'),
        @('5. 実際のツール呼び出し', 'ChatGPT から実際にツールを呼び、文書が読めるかを確かめます。この画面では確かめられません。')
    ) # 段階の名前と説明。
    foreach ($stage in $stages) {
        $stageLabel = New-GuiControl -TypeName 'Label' -ToolTipText $stage[1] -Property ([ordered]@{
                Text = $stage[0]
                AutoSize = $true
            }) # 段階のラベル。
        $stageInner.Controls.Add($stageLabel)
    }
    $stageNote = New-GuiControl -TypeName 'Label' -ToolTipText '前の 3 つは、この画面から CLI を呼んで確かめられます。後ろの 2 つは ChatGPT の画面で確かめます。終了コード 0 は CLI の処理の成功で、ChatGPT から読めることの確認ではありません。' -Property ([ordered]@{
            Text = 'このツールが確かめるのは前の 3 つまで。後ろの 2 つは ChatGPT 側で確認が必要です。'
            AutoSize = $true
            MaximumSize = [System.Drawing.Size]::new($CardWidth - 40, 0)
            ForeColor = [System.Drawing.Color]::DarkRed
        }) # 確かめられる範囲の注意。
    $stageInner.Controls.Add($stageNote)
    $stageBox.Controls.Add($stageInner)
    $Panel.Controls.Add($stageBox)

    $hubBox = New-GuiControl -TypeName 'GroupBox' -ToolTipText 'ハブ設定（hub.json）に登録されたプロジェクトです。この画面は hub.json を読むだけで、作成も変更もしません。' -Property ([ordered]@{
            Text = 'ハブに登録済みのプロジェクト'
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            MinimumSize = [System.Drawing.Size]::new($CardWidth, 0)
            MaximumSize = [System.Drawing.Size]::new($CardWidth, 0)
        }) # 登録一覧の枠。
    $hubInner = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
            WrapContents = $false
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
            Location = [System.Drawing.Point]::new(10, 22)
        }) # 一覧とボタンを上から並べる枠。
    $listView = New-GuiControl -TypeName 'ListView' -ToolTipText "hub.json（$(Get-HubConfigPath)）に登録されたプロジェクトの名前・フォルダー・権限・承認の状態です。権限と承認の列は「権限を確認」を押すまで「（未確認）」のままです（画面の表示や「一覧を更新」だけでは node を起動せず、確認しません）。" -Property ([ordered]@{
            View = [System.Windows.Forms.View]::Details
            FullRowSelect = $true
            MultiSelect = $false
            HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
            Width = $CardWidth - 30
            Height = 120
        }) # 登録一覧。
    [void]$listView.Columns.Add('名前', 170)
    [void]$listView.Columns.Add('フォルダー', 230)
    [void]$listView.Columns.Add('ソースの読み取り', 120)
    [void]$listView.Columns.Add('Claude Code', 150)
    [void]$listView.Columns.Add('承認', 190)
    $refreshButton = New-GuiControl -TypeName 'Button' -ToolTipText 'hub.json を読み直して、登録済みのプロジェクトの名前とフォルダーを表示します。ファイルは読むだけで、作成も変更もしません。権限と承認の列は「（未確認）」に戻ります（この操作では node を起動しません。確認し直すには「権限を確認」を押してください）。別のコンソール窓で追加したあとに押します。' -Property ([ordered]@{
            Text = '一覧を更新'
            AutoSize = $true
        }) # 一覧の更新ボタン。
    $refreshButton.Add_Click({
            try { Update-HubListView } catch { Write-GuiError -ErrorRecord $_ }
        })
    $permissionButtonPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
            WrapContents = $false
            AutoSize = $true
            AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
        }) # 権限の確認・切り替えのボタンの並び。
    $permissionCheckButton = New-GuiControl -TypeName 'Button' -ToolTipText 'ハブに登録した全プロジェクトの、ChatGPT からのソースの読み取りと Claude Code の起動の権限、承認の状態を確認します（HubPermissions）。読み取り専用で、hub.json・承認ファイル・プロジェクトの設定のどれにも書き込みません。プロジェクトごとに Node.js を 2 回起動するため、件数に応じて数秒かかります。ほかの操作と並行して実行できます。' -Property ([ordered]@{
            Text = '権限を確認'
            AutoSize = $true
        }) # 権限確認ボタン。
    $permissionCheckButton.Add_Click({
            try { Start-HubPermissionCheckJob } catch { Write-GuiError -ErrorRecord $_ }
        })
    $permissionSourceButton = New-GuiControl -TypeName 'Button' -ToolTipText '一覧で選んだプロジェクトの、ChatGPT からのソースの読み取り（detailExposure.sourceText と gitExposure.paths）を On / Off します。まだ権限を確認していなければ、先に確認します。設定の変更と承認を 1 つの操作で行うため、承認ダイアログでの承認が必要です（キャンセルすると何も変わりません）。' -Property ([ordered]@{
            Text = 'ソースの読み取りを切り替え'
            AutoSize = $true
        }) # ソースの読み取り切り替えボタン。
    $permissionSourceButton.Add_Click({
            try { Invoke-HubPermissionToggle -Kind 'SourceRead' } catch { Write-GuiError -ErrorRecord $_ }
        })
    $permissionClaudeButton = New-GuiControl -TypeName 'Button' -ToolTipText '一覧で選んだプロジェクトの、ChatGPT からの Claude Code の起動（claudeCode.enabled）を On / Off します。On にすると、ChatGPT が Claude Code を起動して、このプロジェクトの作業ツリーのファイルを書き換えさせられるようになります。まだ権限を確認していなければ、先に確認します。設定の変更と承認を 1 つの操作で行うため、承認ダイアログでの承認が必要です（キャンセルすると何も変わりません）。' -Property ([ordered]@{
            Text = 'Claude Code の起動を切り替え'
            AutoSize = $true
        }) # Claude Code 起動切り替えボタン。
    $permissionClaudeButton.Add_Click({
            try { Invoke-HubPermissionToggle -Kind 'ClaudeCode' } catch { Write-GuiError -ErrorRecord $_ }
        })
    $permissionButtonPanel.Controls.Add($permissionCheckButton)
    $permissionButtonPanel.Controls.Add($permissionSourceButton)
    $permissionButtonPanel.Controls.Add($permissionClaudeButton)
    $hubInner.Controls.Add($listView)
    $hubInner.Controls.Add($refreshButton)
    $hubInner.Controls.Add($permissionButtonPanel)
    $hubBox.Controls.Add($hubInner)
    $Panel.Controls.Add($hubBox)
    $script:Ui.HubListView = $listView
    $script:Ui.PermissionCheckButton = $permissionCheckButton
    $script:Ui.PermissionSourceButton = $permissionSourceButton
    $script:Ui.PermissionClaudeButton = $permissionClaudeButton
}

# 画面の下部（実行されるコマンド・ログ欄・消去・コピー）を作る。
function New-BottomPanel {
    $panel = New-GuiControl -TypeName 'Panel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Bottom
            Height = 240
        }) # 下部の枠。
    $commandLabel = New-GuiControl -TypeName 'Label' -ToolTipText '最後に起動した CLI のコマンドです。' -Property ([ordered]@{
            Text = '実行されるコマンド（表示用）'
            Dock = [System.Windows.Forms.DockStyle]::Top
            Height = 20
        }) # コマンド欄の見出し。
    $commandBox = New-GuiControl -TypeName 'TextBox' -ToolTipText '最後に起動した CLI のコマンドを、表示用に整形したものです。この画面が動かす子プロセスには引数を 1 つずつ渡し、この文字列は使いません。別のコンソール窓（キー入力）は、この文字列と同じ引用で、この画面のスクリプトを補助役（-ConsoleHelper）として起動します。' -Property ([ordered]@{
            ReadOnly = $true
            Dock = [System.Windows.Forms.DockStyle]::Top
            Font = $script:Ui.MonoFont
        }) # コマンド欄。
    $toolbar = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Top
            FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
            Height = 34
        }) # ログ欄の操作ボタンの並び。
    $logLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'CLI の出力です。最後に「終了コード N」を出します。' -Property ([ordered]@{
            Text = '出力ログ'
            AutoSize = $true
        }) # ログ欄の見出し。
    $clearButton = New-GuiControl -TypeName 'Button' -ToolTipText 'ログ欄の表示を消します。実行中の CLI は止めません。' -Property ([ordered]@{
            Text = '消去'
            AutoSize = $true
        }) # 消去ボタン。
    $clearButton.Add_Click({
            try { $script:Ui.LogBox.Clear() } catch { Write-GuiError -ErrorRecord $_ }
        })
    $copyButton = New-GuiControl -TypeName 'Button' -ToolTipText 'ログ欄の全文をクリップボードへコピーします。' -Property ([ordered]@{
            Text = 'コピー'
            AutoSize = $true
        }) # コピーボタン。
    $copyButton.Add_Click({
            try {
                $logText = $script:Ui.LogBox.Text # コピーする全文。
                if (-not [string]::IsNullOrEmpty($logText)) { [System.Windows.Forms.Clipboard]::SetText($logText) }
            } catch {
                Write-GuiError -ErrorRecord $_
            }
        })
    $toolbar.Controls.Add($logLabel)
    $toolbar.Controls.Add($clearButton)
    $toolbar.Controls.Add($copyButton)
    $logBox = New-GuiControl -TypeName 'TextBox' -ToolTipText 'CLI の標準出力と標準エラー出力を、行の先頭に「│ 」を付けて表示し（この画面自身のお知らせには付けません）、最後に「終了コード N」を出します。制御文字・行区切り・双方向制御文字は \x / \u の形で示します。0 は CLI の処理の成功で、ChatGPT から読めることの確認ではありません。キーはこの画面を通らないため、ここには出ません。' -Property ([ordered]@{
            Multiline = $true
            ReadOnly = $true
            ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
            WordWrap = $true
            MaxLength = 0
            Dock = [System.Windows.Forms.DockStyle]::Fill
            Font = $script:Ui.MonoFont
        }) # 出力ログ欄。
    # Dock の配置は Controls の後ろの要素から順に決まる。上から「見出し・コマンド・ボタン・ログ」に見えるよう、ログ（Fill）を先頭に、上端のものは下から順に追加する。
    $panel.Controls.Add($logBox)
    $panel.Controls.Add($toolbar)
    $panel.Controls.Add($commandBox)
    $panel.Controls.Add($commandLabel)
    $script:Ui.LogBox = $logBox
    $script:Ui.CommandBox = $commandBox
    return $panel
}

# 画面の上の帯（ハブの稼働表示）を作る。タブの上に置くので、どのタブを開いていても見える。
# 左に状態のラベル、その右に詳細のラベルを並べる（詳細は帯の残りの幅を使い、収まらなければ 2 行に折り返す）。文は Update-HubStatusBand が入れる。
function New-HubStatusBand {
    $bandHeight = 40 # 帯の高さ（詳細が 2 行に折り返しても収まる高さ）。
    $band = New-GuiControl -TypeName 'Panel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Top
            Height = $bandHeight
        }) # 帯の枠。
    $edgePanel = New-GuiControl -TypeName 'Panel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Left
            Width = 6
        }) # 左端のすき間。
    $stateLabel = New-GuiControl -TypeName 'Label' -ToolTipText $script:HubStatusToolTip -Property ([ordered]@{
            Text = ''
            AutoSize = $true
            MinimumSize = [System.Drawing.Size]::new(0, $bandHeight)
            Dock = [System.Windows.Forms.DockStyle]::Left
            TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
        }) # 状態のラベル（幅は文に合わせる。高さは帯に合わせ、文を上下の中央に置く）。
    $gapPanel = New-GuiControl -TypeName 'Panel' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Left
            Width = 12
        }) # 状態と詳細の間のすき間。
    $detailLabel = New-GuiControl -TypeName 'Label' -ToolTipText $script:HubStatusToolTip -Property ([ordered]@{
            Text = ''
            AutoSize = $false
            AutoEllipsis = $true
            Dock = [System.Windows.Forms.DockStyle]::Fill
            TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
        }) # 詳細のラベル（残りの幅を使う）。
    # Dock の配置は Controls の後ろの要素から順に決まる。左から「すき間・状態・すき間・詳細」に見えるよう、詳細（Fill）を先頭に、左端のものは右から順に追加する。
    $band.Controls.Add($detailLabel)
    $band.Controls.Add($gapPanel)
    $band.Controls.Add($stateLabel)
    $band.Controls.Add($edgePanel)
    $script:Ui.HubStateLabel = $stateLabel
    $script:Ui.HubDetailLabel = $detailLabel
    return $band
}

# 主画面を作る。タブは groups の順、カードは actions の JSON の並び順。
function New-BridgeForm {
    $help = $script:Ui.Help # 説明文の共有データ。
    $cardWidth = 900 # カードの幅。
    $form = New-GuiComponent -TypeName 'Form' -Property ([ordered]@{
            Text = 'ChatGPT Project Bridge 管理画面'
            ClientSize = [System.Drawing.Size]::new(960, 720)
            MinimumSize = [System.Drawing.Size]::new(760, 520)
            StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        }) # 主画面。
    $script:Ui.Form = $form
    $tabControl = New-GuiControl -TypeName 'TabControl' -LayoutOnly -Property ([ordered]@{
            Dock = [System.Windows.Forms.DockStyle]::Fill
            ShowToolTips = $true
        }) # タブ。
    foreach ($groupProperty in $help.groups.PSObject.Properties) {
        $groupKey = [string]$groupProperty.Name # グループの名前。
        $groupLabel = [string]$groupProperty.Value # タブの見出し。
        $tabTip = Get-GroupDescription -GroupKey $groupKey -GroupLabel $groupLabel # タブの説明。
        $tabPage = New-GuiControl -TypeName 'TabPage' -ToolTipText $tabTip -Property ([ordered]@{
                Text = $groupLabel
                ToolTipText = (Get-WrappedToolTipText -Text (Limit-ToolTipText -Text $tabTip))
            }) # タブのページ（見出しの説明もツールチップと同じく折り返す）。
        $scrollPanel = New-GuiControl -TypeName 'FlowLayoutPanel' -LayoutOnly -Property ([ordered]@{
                Dock = [System.Windows.Forms.DockStyle]::Fill
                FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
                WrapContents = $false
                AutoScroll = $true
            }) # カードを縦に並べてスクロールする枠。
        if ($groupKey -eq 'easy') { Add-EasyTabHeader -Panel $scrollPanel -CardWidth $cardWidth }
        if ($groupKey -eq 'maintainer') {
            $maintainerLabel = New-GuiControl -TypeName 'Label' -ToolTipText 'ExportSkill・ExportBundle・UpdateLock は、Skill のソースから配布物や依存物のロックを作る操作です。通常の利用では使いません。' -Property ([ordered]@{
                    Text = '署名鍵や gh（GitHub CLI）を使う、配布物の作成者向けの操作です'
                    AutoSize = $true
                    MaximumSize = [System.Drawing.Size]::new($cardWidth, 0)
                    ForeColor = [System.Drawing.Color]::DarkRed
                }) # 保守者向けタブの警告。
            $scrollPanel.Controls.Add($maintainerLabel)
        }
        foreach ($actionProperty in $help.actions.PSObject.Properties) {
            if ((Get-EntryText -Entry $actionProperty.Value -Name 'group') -ne $groupKey) { continue }
            $card = New-ActionCard -ActionKey ([string]$actionProperty.Name) -Action $actionProperty.Value -CardWidth $cardWidth # 作ったカード。
            $script:Ui.Cards.Add($card)
            $scrollPanel.Controls.Add($card.GroupBox)
        }
        $tabPage.Controls.Add($scrollPanel)
        $tabControl.TabPages.Add($tabPage)
    }
    $bottomPanel = New-BottomPanel # 下部の共通欄。
    $hubBand = New-HubStatusBand # 上部のハブの稼働表示（どのタブでも見える帯）。
    # タブ（Fill）を先に追加し、下部（Bottom）と上部の帯（Top）を後に追加する（後の要素から配置が決まるため）。
    $form.Controls.Add($tabControl)
    $form.Controls.Add($bottomPanel)
    $form.Controls.Add($hubBand)
    $form.Add_FormClosing({
            try { Confirm-WindowClose -ClosingEvent $_ } catch { Write-GuiError -ErrorRecord $_ }
        })
    # 主画面を閉じたら、ハブの稼働表示のタイマーを止める（閉じるのを取りやめたときは止めないよう、FormClosing ではなく FormClosed で止める）。
    $form.Add_FormClosed({
            try {
                if ($null -ne $script:Ui.HubTimer) { $script:Ui.HubTimer.Stop() }
            } catch {
                Write-GuiError -ErrorRecord $_
            }
        })
    # 表示したら、ハブの稼働表示の 3 秒ごとのタイマーを始め、登録一覧・稼働表示・自動入力を 1 回行う（Update-HubListView が稼働表示と自動入力も行う）。
    $form.Add_Shown({
            try {
                if ($null -ne $script:Ui.HubTimer) { $script:Ui.HubTimer.Start() }
                Update-HubListView
                Update-ButtonState
            } catch {
                Write-GuiError -ErrorRecord $_
            }
        })
    # 表示する画面の作業領域に収める（高 DPI では既定の大きさが画面より大きくなるため）。
    Resize-FormToWorkingArea -Form $form -WorkingArea (Get-DisplayWorkingArea)
    return $form
}

# 管理画面を起動する。Windows 以外では止め、STA でなければ -STA で起動し直す。
function Start-BridgeGui {
    if (-not $IsWindows) { throw 'この管理画面は Windows 専用です。Ubuntu では scripts/project-bridge-gui.py を使ってください。' }
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
        # 起動し直しても STA にならない環境で、起動し直しを繰り返さない。
        if ($script:IsStaRelaunch) { throw 'STA（シングルスレッド アパートメント）で起動できませんでした。pwsh -STA -NoProfile -File で起動してください。' }
        $pwshPath = (Get-Process -Id $PID).Path # いまの pwsh。
        Start-Process -FilePath $pwshPath -ArgumentList (Join-CommandLine -ArgumentList @('-STA', '-NoProfile', '-File', $script:GuiScriptPath, '-StaRelaunched'))
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    if (-not (Test-Path -LiteralPath $script:CliPath -PathType Leaf)) { throw "CLI がありません: $($script:CliPath)" }
    $script:Ui.Help = Read-GuiHelp -Path $script:HelpPath
    $script:Ui.CliParameters = Get-CliParameterSet -CliPath $script:CliPath
    $script:Ui.PwshPath = (Get-Process -Id $PID).Path
    $script:Ui.WorkingDirectory = $env:USERPROFILE
    $script:Ui.MonoFont = [System.Drawing.Font]::new('Consolas', [single]9.5)
    $script:Ui.ToolTip = New-GuiComponent -TypeName 'ToolTip' -Property ([ordered]@{
            AutoPopDelay = 30000
            InitialDelay = 300
            ReshowDelay = 100
            ShowAlways = $true
        })
    $script:Ui.Timer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 150 })
    $script:Ui.Timer.Add_Tick({
            try { Update-CliJobState } catch { Write-GuiError -ErrorRecord $_ }
        })
    # ハブの稼働表示の専用のタイマー（3 秒ごと）。子プロセスの出力を読む上のタイマー（子プロセスが無ければ止まる）とは別に、主画面を表示している間ずっと動かす。
    # 稼働表示だけを調べ直す。自動入力（Set-KnownInputValue）と登録一覧の作り直しはしない（入力中の欄を書き換えないため）。
    $script:Ui.HubTimer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 3000 })
    $script:Ui.HubTimer.Add_Tick({
            try { Update-HubStatusBand } catch { Write-GuiError -ErrorRecord $_ }
        })
    # コンソールの Ctrl+C・Ctrl+Break を受けたら画面を閉じるタイマー（200 ms ごと）。受けたことは、信号の処理（Register-ConsoleCancelHandler）が ConsoleSignal に立てる。
    $script:Ui.ConsoleSignal = [System.Threading.ManualResetEventSlim]::new($false)
    $script:Ui.ConsoleTimer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 200 })
    $script:Ui.ConsoleTimer.Add_Tick({
            try { Update-ConsoleCancelState } catch { Write-GuiError -ErrorRecord $_ }
        })
    $form = New-BridgeForm # 主画面。
    try {
        Register-ConsoleCancelHandler -Signal $script:Ui.ConsoleSignal
        if ($script:Ui.ConsoleRegistrations.Count -gt 0) { $script:Ui.ConsoleTimer.Start() }
        [void]$form.ShowDialog()
    } finally {
        $script:Ui.ConsoleTimer.Stop()
        $script:Ui.ConsoleTimer.Dispose()
        $script:Ui.HubTimer.Stop()
        $script:Ui.HubTimer.Dispose()
        $script:Ui.Timer.Stop()
        $script:Ui.Timer.Dispose()
        $script:Ui.ToolTip.Dispose()
        $form.Dispose()
        # 信号の登録は最後に外す（後片付けの途中の Ctrl+C でも、pwsh がパイプラインを止めないように）。
        # ConsoleSignal は Dispose しない（外す直前に別のスレッドで呼ばれた処理が、そのあとで Set を呼んでも例外にならないように。待機用のハンドルは作らないため、解放するものは無い）。
        foreach ($registration in $script:Ui.ConsoleRegistrations) { $registration.Dispose() }
        $script:Ui.ConsoleRegistrations.Clear()
    }
}

# 管理画面の起動で起きた例外を、メッセージボックス（エラーのアイコン）で知らせる。
# ランチャー（スタートメニュー・.cmd）は -WindowStyle Hidden で起動するため、コンソールに出る例外の表示は利用者に見えない。
# 同じ文を標準エラー出力にも出す（コンソールから起動したときと、WinForms を読み込めない環境のため）。文は行ごとに無害化する。
function Show-StartupError {
    param([Parameter(Mandatory)][object]$ErrorRecord)
    $message = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception.Message } else { [string]$ErrorRecord } # 例外の内容。
    $lines = [System.Collections.Generic.List[string]]::new() # 表示する行。
    $lines.Add('管理画面を起動できませんでした。')
    $lines.Add('')
    foreach ($piece in @(Split-LogText -Text $message)) { $lines.Add((ConvertTo-SafeLogLine -Text $piece)) }
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord] -and -not [string]::IsNullOrWhiteSpace($ErrorRecord.ScriptStackTrace)) {
        $lines.Add('')
        $lines.Add('起きた場所:')
        foreach ($piece in @(Split-LogText -Text $ErrorRecord.ScriptStackTrace | Select-Object -First 6)) { $lines.Add((ConvertTo-SafeLogLine -Text $piece)) }
    }
    $text = $lines -join "`r`n" # 表示する文。
    [Console]::Error.WriteLine($text)
    if (-not $IsWindows) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($text, 'ChatGPT Project Bridge 管理画面', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
        [Console]::Error.WriteLine("メッセージボックスを表示できませんでした: $($_.Exception.Message)")
    }
}

# ---------------------------------------------------------------------------
# 別のコンソール窓の補助役（-ConsoleHelper）。WinForms は読み込まない
# ---------------------------------------------------------------------------

# 補助役の窓へ 1 行出す（コンソールのホストへ直接出す）。
function Write-ConsoleText {
    param([AllowEmptyString()][string]$Text)
    Out-Host -InputObject $Text
}

# 終了コードを出し、Enter キーが押されるまで待つ。押されたキーは表示せず、どこにも残さない（キーを貼り付けても実行も記録もされない）。
# 待つ前に、CLI の実行中に溜まった入力を捨てる（貼り付けた内容の改行で、結果を読む前に閉じないようにする）。
function Wait-ConsoleEnter {
    param([int]$ExitCode)
    Write-ConsoleText ''
    Write-ConsoleText "終了コード $($ExitCode)。Enter キーで閉じます。"
    try {
        while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
        while ($true) {
            $keyInfo = [Console]::ReadKey($true) # 押されたキー（表示しない）。
            if ($keyInfo.Key -eq [System.ConsoleKey]::Enter) { break }
        }
    } catch {
        Write-ConsoleText "キーを読めなかったため、待たずに閉じます（$($_.Exception.Message)）。"
    }
}

# 補助役の本体。起動引数を確かめ、CLI（project-bridge.ps1）を & で 1 回だけ実行し、終了コードを出して Enter を待ち、その終了コードで終わる。
# 対話プロンプトは残さない（CLI の終了後にプロンプトへ戻る起動のしかたをしない）。
# 終了コードは、CLI が exit で返したもの（$LASTEXITCODE。呼ぶ前に 0 にしておき、exit しなければ 0）。CLI が例外で止まったら 1、引数が不正なら 2。
# CLI は失敗を例外で知らせるほか、エラー文を退避して表示するときは exit 1 で終わるため、$LASTEXITCODE も拾う。
function Invoke-ConsoleHelper {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$BoundParameters)
    $exitCode = 1 # この窓の終了コード。
    $splat = $null # CLI へ渡す引数。
    try {
        $splat = ConvertTo-ConsoleHelperSplat -BoundParameters $BoundParameters
    } catch {
        Write-ConsoleText "別のコンソール窓の引数が不正なため、CLI を実行しませんでした: $($_.Exception.Message)"
        $exitCode = 2
    }
    if ($null -ne $splat) {
        Write-ConsoleText "この窓は ChatGPT Project Bridge の CLI（$($splat['Action'])）を実行します。"
        Write-ConsoleText '『Runtime API Key』の入力待ちになったときだけ貼り付けてください。入力した内容は表示されません。'
        Write-ConsoleText ''
        try {
            $global:LASTEXITCODE = 0
            & $script:CliPath @splat | Out-Host
            $succeeded = $? # CLI が exit で 0 以外を返したときだけ偽になる。
            $exitCode = [int]$global:LASTEXITCODE
            # CLI が正常に終わったのに、途中で呼んで失敗として扱わなかった外部コマンドの終了コードが残っていたら 0 にする（pwsh -File で起動したときと同じ結果にする）。
            if ($succeeded) { $exitCode = 0 }
        } catch {
            Write-ConsoleText "CLI が失敗しました: $($_.Exception.Message)"
            $exitCode = 1
        }
    }
    Wait-ConsoleEnter -ExitCode $exitCode
    exit $exitCode
}

# 入口。ドットソースしたとき（. .\project-bridge-gui.ps1）は画面を出さず、関数だけを読み込む。
# -ConsoleHelper のときは別のコンソール窓の補助役として CLI を 1 回だけ実行する（画面は作らず、WinForms も読み込まない）。
# 管理画面の起動で例外が起きたら、メッセージボックスで内容を見せてから終了コード 1 で終わる（コンソールを隠して起動するため）。
if ($MyInvocation.InvocationName -ne '.') {
    if ($script:IsConsoleHelper) {
        Invoke-ConsoleHelper -BoundParameters $script:LaunchParameters
    } else {
        try {
            Assert-GuiLaunchParameter -BoundParameters $script:LaunchParameters
            Start-BridgeGui
        } catch {
            Show-StartupError -ErrorRecord $_
            exit 1
        }
    }
}
