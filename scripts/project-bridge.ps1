#Requires -Version 7
<#
.SYNOPSIS
  ローカルプロジェクトとChatGPTを読み取り専用MCPで接続する。

.DESCRIPTION
  プロジェクト文書の初期化、Secure MCP Tunnelプロファイル設定、DPAPIキー保存、
  状態更新、ローカル自己試験、起動、診断を1つのコマンドで扱う。

.PARAMETER Action
  Init / ConfigureTunnel / SaveKey / Update / Test / Doctor / Start / Status / AddProject / Approve / ShowExposure / ExportSkill / ExportBundle / UpdateLock。
  ShowExposure は公開範囲・指紋・承認状態・前回承認との差分をJSON1つで標準出力へ出す読み取り専用の操作。承認ファイルやプロジェクト設定へは何も書かない。-Profile 省略時は Approve と同じ方法でプロファイル名を決める。
  ハブ方式（PCごとに1つのTunnel・App・キーで複数プロジェクト）: HubAdd / HubRemove / HubList / HubStart / HubStop / HubRestart / HubDoctor / HubStatus。
  自動起動（サインイン時にハブを起動）: HubServiceInstall / HubServiceUninstall。

.PARAMETER Service
  HubStart / HubRestart を入力なしで実行する（自動起動用）。未承認のプロジェクトは公開しないまま起動する。

.PARAMETER ProjectRoot
  接続対象のプロジェクトフォルダー。既定は現在のフォルダー。

.PARAMETER ProjectName
  ChatGPTへ表示するプロジェクト名。Init時の既定はフォルダー名。

.PARAMETER Profile
  Tunnel Clientのプロファイル名。未指定時はプロジェクト名から生成する。

.PARAMETER TunnelId
  Platformで作成した tunnel_ から始まるID。ConfigureTunnelで必須。

.PARAMETER TunnelClientPath
  tunnel-client.exeの明示パス。未指定時はPATHと既知の配置候補を確認する。

.PARAMETER HealthPort
  ローカル管理画面のポート。0なら18080以降の空きポートを選ぶ。

.PARAMETER OutputPath
  ExportSkillで作成するZIPファイルのパス。

.PARAMETER Force
  既存のbridge設定、Tunnelプロファイル、またはZIPを明示的に置き換える。

.PARAMETER ExposureSha256
  非対話で公開範囲を承認するときの指紋。現在の公開範囲の指紋と一致した場合だけ承認する。

.PARAMETER SigningKey
  ExportBundleでSHA256SUMS.txtへSSH署名する秘密鍵のパス。省略時は署名せず指紋だけを表示する。

.PARAMETER TunnelClientVersion
  UpdateLockで固定するTunnel Clientのリリースタグ（例: v1.2.3）。省略時は最新リリース。

.PARAMETER NodeVersion
  UpdateLockで固定するNode.js LTSの版（例: v22.11.0）。省略時は最新LTS。

.PARAMETER HubName
  HubAdd / HubRemove で使う、ハブ内のプロジェクト名（英数字と . _ -）。HubAdd で省略するとプロジェクト名から作る。

.PARAMETER GhPath
  UpdateLockでTunnel Clientの来歴証明を検証するGitHub CLI（gh.exe）のパス。省略時はPATHと %LOCALAPPDATA%\Programs\gh\bin\gh.exe を探す。

.PARAMETER SourceRead
  SetPermission で、ChatGPTからのソースの読み取りを on（detailExposure.sourceText と gitExposure.paths を許可）/ off（sourceText を止める。paths は残す）にする。

.PARAMETER ClaudeCode
  SetPermission で、ChatGPTからのClaude Codeの起動（claudeCode.enabled）を on / off にする。

.PARAMETER AllowedCommand
  SetPermission で、Claude Codeに確認なしで実行させるコマンドのパターン（複数指定できる。指定すると一覧を置き換える）。

  SetPermission / HubPermissions（2.8.0）: SetPermission はプロジェクトごとの権限（ソースの読み取り・Claude Codeの起動・許可コマンド）の切り替えを、変更と承認を1つの操作にして行う。
  -ExposureSha256 なしでは、変更後の公開範囲の確認結果をJSON1つで出すだけで、設定も承認も書かない。-ExposureSha256 付きでは、変更後の指紋と一致するときだけ設定を書き、承認を保存する。
  HubPermissions はハブの全プロジェクトの権限と承認の状態をJSON1つで出す読み取り専用の操作。

.EXAMPLE
  & $env:USERPROFILE\.codex\skills\chatgpt-project-bridge\scripts\project-bridge.ps1 -Action Init -ProjectRoot E:\work\Example -ProjectName Example

.EXAMPLE
  & $env:USERPROFILE\.codex\skills\chatgpt-project-bridge\scripts\project-bridge.ps1 -Action ConfigureTunnel -ProjectRoot E:\work\Example -TunnelId tunnel_0123456789abcdef0123456789abcdef

.EXAMPLE
  & $env:USERPROFILE\.codex\skills\chatgpt-project-bridge\scripts\project-bridge.ps1 -Action ShowExposure -ProjectRoot E:\work\Example
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Init', 'ConfigureTunnel', 'SaveKey', 'Update', 'Test', 'Doctor', 'Start', 'Status', 'AddProject', 'Approve', 'ShowExposure', 'ExportSkill', 'ExportBundle', 'UpdateLock', 'HubAdd', 'HubRemove', 'HubList', 'HubStart', 'HubStop', 'HubRestart', 'HubDoctor', 'HubStatus', 'HubServiceInstall', 'HubServiceUninstall', 'SetPermission', 'HubPermissions')]
    [string]$Action,

    [string]$ProjectRoot = (Get-Location).ProviderPath,
    [string]$ProjectName,
    [string]$Profile,
    [string]$TunnelId,
    [string]$TunnelClientPath,
    [ValidateRange(0, 65535)]
    [int]$HealthPort = 0,
    [string]$OutputPath,
    [switch]$Force,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [switch]$ForceReconfigure,
    [switch]$ReplaceKey,
    [string]$ExposureSha256,
    [string]$SigningKey,
    [string]$TunnelClientVersion,
    [string]$NodeVersion,
    [string]$GhPath,
    [string]$HubName,
    [switch]$Service,
    [ValidateSet('on', 'off')]
    [string]$SourceRead,
    [ValidateSet('on', 'off')]
    [string]$ClaudeCode,
    [string[]]$AllowedCommand
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:SkillRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath) # このスキルの配置ルート。UNCでも Microsoft.PowerShell.Core\FileSystem:: の付かないファイルシステムのパスにし、UNCでは Resolve-Path が残す scripts\.. を GetFullPath で畳む。
$script:ServerPath = Join-Path $PSScriptRoot 'server.mjs' # Tunnelから起動する汎用MCPサーバー。
$script:PermissionHelperPath = Join-Path $PSScriptRoot 'bridge-permission.mjs' # SetPermission が、権限の切り替えを反映した設定の候補を作るのに使うNode.jsの部品（Ubuntu版と同じ変換）。
$script:SelfTestPath = Join-Path $PSScriptRoot 'selftest.mjs' # ローカルstdio自己試験。
$script:SecuritySelfTestPath = Join-Path $PSScriptRoot 'security-selftest.mjs' # 公開境界の防御を一時プロジェクトで試す自己試験。
$script:LockPath = Join-Path $script:SkillRoot 'dependencies.lock.json' # 依存物の版とSHA-256の固定値。
$script:SignatureNamespace = 'chatgpt-project-bridge-bundle' # Bundle署名に使うssh-keygenの名前空間。
$script:ConfigName = '.chatgpt-project-bridge.json' # プロジェクト側の公開範囲設定名。
$script:ManifestPath = Join-Path $script:SkillRoot 'distribution.json' # 配布対象・mode・versionの唯一の正本。
$script:ContextName = 'CHATGPT_PROJECT_CONTEXT.md' # 長期概要文書名。
$script:StatusName = 'CHATGPT_PROJECT_STATUS.md' # 現在状態文書名。
$script:TunnelsUrl = 'https://platform.openai.com/settings/organization/tunnels' # Tunnel作成画面。
$script:ApiKeysUrl = 'https://platform.openai.com/settings/organization/api-keys' # Runtime API Key作成画面。
$script:PluginsUrl = 'https://chatgpt.com/plugins' # ChatGPT App登録画面。
$script:ConfigTextFields = @('projectName', 'contextFile', 'statusFile', 'profileName', 'tunnelId') # 公開設定のうち利用者に表示する1つだけの文字列項目。
$script:ExposureTextFields = @('projectRoot', 'contextFile', 'statusFile') # サーバーが返す公開範囲のうち1つだけの文字列項目。
$script:GitSafeOptions = @('-c', 'core.fsmonitor=false', '--no-optional-locks') # Gitの呼び出しごとに付ける、fsmonitorの実行と索引のロックを止めるオプション（共通仕様S5）。
$script:GitNoDiffProgramOptions = @('--no-ext-diff', '--no-textconv') # logなど差分を扱う呼び出しで、外部diffとtextconvの実行を止めるオプション。
$script:GitUnsafeConfigPatterns = @(
    '^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand|worktree)$',
    '^(filter|diff|merge)\..+\.(clean|smudge|process|command|textconv|driver|cachetextconv)$',
    '^diff\.external$',
    '^(alias|include|includeif|url|credential|protocol|gpg|http|sendemail|uploadpack|receive)\.',
    '^submodule\..+\.update$',
    '^remote\..+\.(receivepack|uploadpack|vcs|proxy)$'
) # .git/config にあればGit情報を収集しない、実行を伴いうる設定のキー（共通仕様S5。3つの実装で同じ一覧。大文字小文字を区別しない -match で照合する）。submodule は実行を伴う update だけを対象にする（例外E2）。
$script:GitLfsSafeValues = @{
    'filter.lfs.clean' = @('git-lfs clean -- %f')
    'filter.lfs.smudge' = @('git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f')
    'filter.lfs.process' = @('git-lfs filter-process', 'git-lfs filter-process --skip')
} # Git LFS が書く正規の設定（共通仕様S5の例外E1）。キーと値が大文字小文字を区別して完全に一致するときだけ危険とみなさない。

# 文字列をコードポイントの並びにする。サロゲートペアは [char]::ConvertToUtf32 で1つにまとめ、対にならないサロゲートはその値のまま返す。
function Get-CodePoint {
    param([string]$Text)
    $codePoints = [System.Collections.Generic.List[int]]::new() # 組み立て中のコードポイント。
    $position = 0 # 読んでいる位置（UTF-16の単位）。
    while ($position -lt $Text.Length) {
        if ([char]::IsHighSurrogate($Text[$position]) -and ($position + 1) -lt $Text.Length -and [char]::IsLowSurrogate($Text[$position + 1])) {
            $codePoints.Add([char]::ConvertToUtf32($Text[$position], $Text[$position + 1]))
            $position += 2
        } else {
            $codePoints.Add([int]$Text[$position])
            $position += 1
        }
    }
    return $codePoints.ToArray()
}

# 1つのコードポイントが共通仕様S1の禁止文字（制御・書式・行区切り・段落区切り・対にならないサロゲート）かを返す。
function Test-ForbiddenCodePoint {
    param([int]$CodePoint)
    $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($CodePoint) # .NETの一般カテゴリ。
    return $category -in @(
        [System.Globalization.UnicodeCategory]::Control,
        [System.Globalization.UnicodeCategory]::Format,
        [System.Globalization.UnicodeCategory]::LineSeparator,
        [System.Globalization.UnicodeCategory]::ParagraphSeparator,
        [System.Globalization.UnicodeCategory]::Surrogate
    )
}

# 文字列に共通仕様S1の禁止文字が1つでも含まれるかを返す。
function Test-ForbiddenCharacter {
    param([string]$Text)
    if ($Text -cmatch '^[\x20-\x7E]*\z') { return $false } # 表示できるASCIIだけなら調べるまでもない。
    foreach ($codePoint in (Get-CodePoint -Text $Text)) {
        if (Test-ForbiddenCodePoint -CodePoint $codePoint) { return $true }
    }
    return $false
}

# 1つのコードポイントを \u と小文字16進4桁（BMP外は \U と8桁）の形にする。
function ConvertTo-EscapedCodePoint {
    param([int]$CodePoint)
    if ($CodePoint -le 0xFFFF) { return ('\u{0:x4}' -f $CodePoint) }
    return ('\U{0:x8}' -f $CodePoint)
}

# 値を画面・端末へ出す形にする（共通仕様S2）。二重引用符で囲み、\ と " を退避し、禁止文字とU+0020以外の空白類を \uXXXX にする。
function ConvertTo-DisplayQuoted {
    param([AllowNull()][object]$Value)
    $text = if ($null -eq $Value) { '' } else { [string]$Value } # 引用する文字列。
    if ($text -cmatch '^[\x20-\x7E]*\z') { return '"' + $text.Replace('\', '\\').Replace('"', '\"') + '"' } # 表示できるASCIIだけなら退避は \ と " だけ。
    $builder = [System.Text.StringBuilder]::new('"') # 組み立て中の表示文字列。
    foreach ($codePoint in (Get-CodePoint -Text $text)) {
        if ($codePoint -eq 0x5C) {
            [void]$builder.Append('\\')
        } elseif ($codePoint -eq 0x22) {
            [void]$builder.Append('\"')
        } elseif ((Test-ForbiddenCodePoint -CodePoint $codePoint) -or ($codePoint -ne 0x20 -and [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($codePoint) -eq [System.Globalization.UnicodeCategory]::SpaceSeparator)) {
            [void]$builder.Append((ConvertTo-EscapedCodePoint -CodePoint $codePoint))
        } else {
            [void]$builder.Append([char]::ConvertFromUtf32($codePoint))
        }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

# 端末へ出す文字列から禁止文字だけを \uXXXX にする（引用符は付けない）。-KeepNewline のときは改行（LF）だけ残す（複数行のエラー文用）。
function ConvertTo-EscapedDisplayText {
    param([AllowNull()][object]$Value, [switch]$KeepNewline)
    $text = if ($null -eq $Value) { '' } else { [string]$Value } # 退避する文字列。
    if ($text -cmatch '^[\x20-\x7E]*\z') { return $text }
    $builder = [System.Text.StringBuilder]::new() # 組み立て中の表示文字列。
    foreach ($codePoint in (Get-CodePoint -Text $text)) {
        if ((Test-ForbiddenCodePoint -CodePoint $codePoint) -and -not ($KeepNewline -and $codePoint -eq 0x0A)) {
            [void]$builder.Append((ConvertTo-EscapedCodePoint -CodePoint $codePoint))
        } else {
            [void]$builder.Append([char]::ConvertFromUtf32($codePoint))
        }
    }
    return $builder.ToString()
}

# ConvertTo-Json の出力に残る禁止文字を、JSONとして同じ値の \uXXXX（BMP外はサロゲート対）へ置き換える。
# ConvertTo-Json は U+0020 未満を必ず退避するので、置き換えるのは DEL 以降の文字だけ（字下げの改行は残る）。
function ConvertTo-TerminalJson {
    param([string]$Json)
    if ($Json -cmatch '^[\x00-\x7E]*\z') { return $Json }
    $builder = [System.Text.StringBuilder]::new() # 組み立て中のJSON文字列。
    foreach ($codePoint in (Get-CodePoint -Text $Json)) {
        if ($codePoint -lt 0x7F -or -not (Test-ForbiddenCodePoint -CodePoint $codePoint)) {
            [void]$builder.Append([char]::ConvertFromUtf32($codePoint))
        } elseif ($codePoint -le 0xFFFF) {
            [void]$builder.Append(('\u{0:x4}' -f $codePoint))
        } else {
            $pair = [char]::ConvertFromUtf32($codePoint) # サロゲート対の2単位。
            [void]$builder.Append(('\u{0:x4}\u{1:x4}' -f [int]$pair[0], [int]$pair[1]))
        }
    }
    return $builder.ToString()
}

# 設定・公開範囲のうち利用者に表示する文字列を、Label（項目名。配列は 項目名[番号]、0始まり）と Value の組で設定の順に返す。
function Get-DisplayedValue {
    param([object]$Source, [string[]]$TextFields)
    if ($Source -isnot [System.Management.Automation.PSCustomObject]) { return }
    # 項目の有無は PSObject.Properties[名前] で確かめる（項目が1つも無い {} に .PSObject.Properties.Name を読むと、StrictMode では例外になる）。
    foreach ($name in $TextFields) {
        if ($null -ne $Source.PSObject.Properties[$name] -and $Source.$name -is [string]) { [pscustomobject]@{ Label = $name; Value = [string]$Source.$name } }
    }
    foreach ($name in @('allowFiles', 'denyDirectories')) {
        if ($null -eq $Source.PSObject.Properties[$name] -or $null -eq $Source.$name) { continue }
        $items = @($Source.$name) # 配列の要素。
        for ($index = 0; $index -lt $items.Count; $index++) {
            if ($items[$index] -is [string]) { [pscustomobject]@{ Label = ('{0}[{1}]' -f $name, $index); Value = [string]$items[$index] } }
        }
    }
    if ($null -ne $Source.PSObject.Properties['allowDirectories'] -and $null -ne $Source.allowDirectories) {
        $rules = @($Source.allowDirectories) # 公開ディレクトリの規則。
        for ($index = 0; $index -lt $rules.Count; $index++) {
            $rule = $rules[$index]
            if ($rule -is [System.Management.Automation.PSCustomObject] -and $null -ne $rule.PSObject.Properties['path'] -and $rule.path -is [string]) {
                [pscustomobject]@{ Label = ('allowDirectories[{0}].path' -f $index); Value = [string]$rule.path }
            }
        }
    }
}

# 表示する値に禁止文字があれば、承認の確認へ進まずに止めるためのエラー文を返す（サーバー側の拒否に加えた二重の防御）。無ければ空文字を返す。
function Get-ForbiddenValueMessage {
    param([object]$Source, [string[]]$TextFields)
    foreach ($item in @(Get-DisplayedValue -Source $Source -TextFields $TextFields)) {
        if (Test-ForbiddenCharacter -Text $item.Value) { return "公開範囲の設定に使えない文字が含まれています: $($item.Label) = $(ConvertTo-DisplayQuoted -Value $item.Value)" }
    }
    return ''
}

# 指定されたプロジェクトフォルダーを絶対パスへ解決する。改行・制御文字・書式文字など（共通仕様S1の禁止文字）を含むパスは拒否する。
function Resolve-BridgeProjectRoot {
    param([string]$Path)
    if (Test-ForbiddenCharacter -Text $Path) {
        throw "ProjectRootに改行・制御文字・書式文字などを含むパスは使用できません: $(ConvertTo-DisplayQuoted -Value $Path)"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "プロジェクトフォルダーが存在しません: $(ConvertTo-DisplayQuoted -Value $Path)"
    }
    $resolvedInfo = Resolve-Path -LiteralPath $Path # 解決結果（プロバイダーとパス）。
    if ($resolvedInfo.Provider.Name -ne 'FileSystem') { throw "ProjectRootにはファイルシステムのフォルダーを指定してください: $(ConvertTo-DisplayQuoted -Value $Path)" }
    $resolved = [System.IO.Path]::GetFullPath($resolvedInfo.ProviderPath) # 解決後の絶対パス。.Path はUNCのとき Microsoft.PowerShell.Core\FileSystem:: が付くため使わない。UNCでは Resolve-Path が . や .. や / を残すため GetFullPath で畳む。
    if (Test-ForbiddenCharacter -Text $resolved) {
        throw "ProjectRootに改行・制御文字・書式文字などを含むパスは使用できません: $(ConvertTo-DisplayQuoted -Value $resolved)"
    }
    return $resolved
}

# 利用者が入力したパス（まだ無くてもよい）を、PowerShellの現在位置（cd した後の場所）を基準にファイルシステムの絶対パスへ変換する。
# [System.IO.Path]::GetFullPath($Path) だけではプロセスの現在フォルダーが基準になり、PowerShellの現在位置とずれる。
function Resolve-UserFilePath {
    param([string]$Path)
    $basePath = (Get-Location -PSProvider FileSystem).ProviderPath # 相対パスの基準にする、ファイルシステム上の現在位置。
    return [System.IO.Path]::GetFullPath($Path, $basePath)
}

# UTF-8（BOMなし）でテキストを保存する。
function Write-Utf8Text {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# 既存パスがシンボリックリンクやジャンクションなら読み書きを拒否する。
function Assert-NotReparsePoint {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label にリンクやジャンクションは使用できません: $Path"
    }
}

# Base の下から Path までの途中の要素（Path 自身を含み、Base そのものは含まない）に、リンクやジャンクションが1つでもあれば拒否する。
# まだ存在しない要素から先は調べない。Path が Base の配下でなければ止める。
function Assert-NoReparsePointBelow {
    param([string]$Base, [string]$Path, [string]$Label)
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/') # 調べ始めるフォルダー。
    $prefix = $baseFull + [System.IO.Path]::DirectorySeparatorChar # Base の配下を表す接頭辞。
    $targetFull = [System.IO.Path]::GetFullPath($Path) # 調べ終える要素。
    if (-not $targetFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Label が想定の場所の外を指しています: $Path" }
    $cursor = $baseFull # 調べている要素。
    foreach ($segment in $targetFull.Substring($prefix.Length).Split([System.IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $segment
        if (-not (Test-Path -LiteralPath $cursor)) { return }
        Assert-NotReparsePoint -Path $cursor -Label $Label
    }
}

# 同じフォルダーの一時ファイルへUTF-8（BOMなし）で書いてから置き換える（Python版の atomic_write_text と同じ）。
# 置き換え先がリンクやジャンクションなら拒否する。置き換えはリンクを辿らず、置き換え先そのものを入れ替える。
function Write-AtomicUtf8Text {
    param([string]$Path, [string]$Content, [string]$Label)
    Assert-NotReparsePoint -Path $Path -Label $Label
    $temporary = Join-Path ([System.IO.Path]::GetDirectoryName($Path)) ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp') # 原子的に置き換えるための一時ファイル。
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Content) # 書き込む内容。
        $stream = [System.IO.FileStream]::new($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None) # 既存のファイルを開かないよう、新規作成だけを許す。
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        # 置き換え先を他のプログラム（起動中のMCPサーバーやウイルス対策）が読んでいる間は、置き換えが「アクセスが拒否されました」で失敗する。
        # 読み終わるのは一瞬なので、短く待って最大20回（約1秒）やり直す。
        for ($attempt = 1; $true; $attempt++) {
            Assert-NotReparsePoint -Path $Path -Label $Label # 書いている間にリンクへ差し替えられていないかを、置き換えの直前に毎回確かめる。
            try {
                [System.IO.File]::Move($temporary, $Path, $true)
                break
            } catch [System.UnauthorizedAccessException], [System.IO.IOException] {
                if ($attempt -ge 20) { throw "$Label を置き換えられません（他のプログラムが開いている可能性があります）: ${Path}: $($_.Exception.Message)" }
                Start-Sleep -Milliseconds 50
            }
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

# 設定由来の相対ファイル名を検証し、必ずプロジェクト内の絶対パスへ変換する。
function Resolve-SafeProjectFilePath {
    param([string]$Root, [string]$RelativePath, [string]$Label)
    if (Test-ForbiddenCharacter -Text $RelativePath) {
        throw "公開範囲の設定に使えない文字が含まれています: $Label = $(ConvertTo-DisplayQuoted -Value $RelativePath)"
    }
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Label はプロジェクト相対パスで指定してください: $RelativePath"
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label がプロジェクト外を指しています: $RelativePath"
    }
    # 最後の要素だけでなく、ルートから対象までの途中のフォルダーも調べる（途中がジャンクションやシンボリックリンクだと、プロジェクト外へ読み書きしうる）。
    Assert-NoReparsePointBelow -Base $Root -Path $full -Label $Label
    return $full
}

# JSON設定を読み込む。
function Read-BridgeConfig {
    param([string]$Root)
    $configPath = Join-Path $Root $script:ConfigName
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "bridge設定がありません。先に -Action Init を実行してください: $configPath"
    }
    Assert-NotReparsePoint -Path $configPath -Label 'bridge設定'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json # 読み込んだ設定。
    if ($config -isnot [System.Management.Automation.PSCustomObject]) { throw "bridge設定の形式が不正です（JSONの最上位がオブジェクトではありません）: $configPath" }
    # 手で書いた設定などで任意の項目が欠けていても、読む側・書く側が止まらないよう $null で補う（StrictMode では無い項目の読み書きが例外になる。Init が作る設定には3つともある）。
    foreach ($optionalKey in @('profileName', 'tunnelId', 'healthPort')) {
        if ($null -eq $config.PSObject.Properties[$optionalKey]) { $config | Add-Member -NotePropertyName $optionalKey -NotePropertyValue $null }
    }
    return $config
}

# JSON設定を安定したUTF-8で、同じフォルダーの一時ファイルから原子的に保存する。改行はハブ設定と同じくLFに揃える（ConvertTo-Json はWindowsでCRLFを出す）。
function Write-BridgeConfig {
    param([string]$Root, [object]$Config)
    $configPath = Join-Path $Root $script:ConfigName
    Write-AtomicUtf8Text -Path $configPath -Content ((($Config | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") + "`n") -Label 'bridge設定'
}

# プロジェクト名からTunnelプロファイルに使える短い名前を作る。
function New-ProfileName {
    param([string]$Name, [string]$Root)
    $slug = $Name.ToLowerInvariant() -replace '[^a-z0-9-]+', '-'
    $slug = $slug.Trim('-')
    $hashBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes(([System.IO.Path]::GetFullPath($Root)).ToLowerInvariant()))
    $pathHash = [System.Convert]::ToHexString($hashBytes).Substring(0, 8).ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'project' }
    if ($slug.Length -gt 42) { $slug = $slug.Substring(0, 42).TrimEnd('-') }
    return "chatgpt-$slug-$pathHash"
}

# すべてのActionで共通してプロファイル名を検証する。
function Assert-ProfileName {
    param([string]$Name)
    # Python版の PROFILE_PATTERN.fullmatch と同じ（大文字小文字を区別し、末尾の改行も許さない）。以前のWindows版は大文字を通していたため、直し方も伝える。
    if ($Name -cnotmatch '^[a-z0-9][a-z0-9._-]{0,62}\z') { throw "プロファイル名が不正です: $($Name)（英小文字か数字で始め、英小文字・数字・. _ - だけで63文字以内にします。大文字を含む既存のプロファイルは、小文字の名前で設定し直してください）" }
    return $Name
}

# 設定値、明示引数、プロジェクト名の順でプロファイル名を決める。
function Resolve-ProfileName {
    param([object]$Config, [string]$ExplicitProfile, [string]$Root)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitProfile)) { return Assert-ProfileName -Name $ExplicitProfile }
    if ($null -ne $Config.PSObject.Properties['profileName'] -and -not [string]::IsNullOrWhiteSpace([string]$Config.profileName)) {
        return Assert-ProfileName -Name ([string]$Config.profileName)
    }
    return Assert-ProfileName -Name (New-ProfileName -Name ([string]$Config.projectName) -Root $Root)
}

# Node.js 18以上の実行ファイルを取得する。
function Find-NodeExecutable {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { throw 'Node.jsが見つかりません。サポート中のNode.js LTSを導入してください。' }
    # node・tunnel-client は、作業フォルダーをプロジェクトの外（このスキルの配置ルート）にして起動する。WindowsのNodeは、パスを含まない
    # コマンド名をPATHより先に作業フォルダーから探すため、プロジェクト直下に置かれた git.exe などが実行されうる（多重の防御）。渡すパスはすべて絶対パス。
    Push-Location -LiteralPath $script:SkillRoot
    try {
        $versionText = & $nodeCommand.Source --version
        if ($LASTEXITCODE -ne 0) { throw "Node.jsを実行できません。終了コード: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $major = [int](($versionText -replace '^v', '').Split('.')[0])
    if ($major -lt 18) { throw "Node.js 18以上が必要です。現在: $versionText" }
    return $nodeCommand.Source
}

# tunnel-client.exeを明示パス、PATH、既知候補から探す。
function Find-TunnelClient {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) { throw "Tunnel Clientが見つかりません: $ExplicitPath" }
        return (Resolve-Path -LiteralPath $ExplicitPath).ProviderPath
    }
    $command = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'ChatGPTProjectBridge\bin\tunnel-client.exe'), # install-windows.ps1 が導入する場所（LocalBin）。
        (Join-Path $env:LOCALAPPDATA 'OpenAI\tunnel-client\tunnel-client.exe'),
        (Join-Path $env:USERPROFILE 'Tools\tunnel-client\tunnel-client.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).ProviderPath }
    }
    throw 'Tunnel Clientが見つかりません。公式最新版を入手するか -TunnelClientPath を指定してください。'
}

# 18080以降からローカルで利用可能な管理画面ポートを選ぶ。
function Find-FreeHealthPort {
    param([int]$Start = 18080)
    for ($port = $Start; $port -le [Math]::Min($Start + 200, 65535); $port++) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try {
            $listener.Start()
            return $port
        } catch {
            continue
        } finally {
            try { $listener.Stop() } catch { }
        }
    }
    throw "利用可能な管理画面ポートが見つかりません: $Start 以降"
}

# パスをTunnelのコマンド文字列で扱いやすいスラッシュ形式へ変換する。
function ConvertTo-CommandPath {
    param([string]$Path)
    return $Path.Replace('\', '/')
}

# Gitを対話なし・fsmonitorなし・ロックなしで実行する（共通仕様S5）。
# 標準出力の行を返し、Gitが無い・失敗したときは空配列を返す。-Raw のときは行をLFでつないだ1つの文字列を返し、失敗なら $null を返す。
function Invoke-SafeGit {
    param([string]$Root, [string[]]$GitArgs, [switch]$Raw)
    $previousPreference = $ErrorActionPreference
    $previousPrompt = Get-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue # 呼び出し前の値。終わったら戻す。
    $safeOptions = $script:GitSafeOptions # すべての呼び出しに付けるオプション。
    $ErrorActionPreference = 'Continue'
    try {
        $env:GIT_TERMINAL_PROMPT = '0' # 認証の入力待ちで止まらないようにする。
        $output = & git @safeOptions -C $Root @GitArgs 2>$null
        $failed = $LASTEXITCODE -ne 0 # 外部コマンドの失敗。
    } catch {
        $output = $null
        $failed = $true # Gitが見つからない。
    } finally {
        if ($null -ne $previousPrompt) { $env:GIT_TERMINAL_PROMPT = $previousPrompt.Value } else { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
        $ErrorActionPreference = $previousPreference
    }
    if ($Raw) {
        if ($failed) { return $null }
        return (@($output) -join "`n")
    }
    if ($failed -or $null -eq $output) { return @() }
    return @($output)
}

# プロジェクト自身がGitルートで、.git/config に実行を伴いうる設定が無いときだけGit情報を集めてよい（共通仕様S5）。
# Allowed（集めてよいか）と Reason（集めない理由。Gitが無い・Gitリポジトリでない・別のリポジトリの配下のときは空）を返す。
function Get-GitCollectionState {
    param([string]$Root)
    $topLevel = (Invoke-SafeGit -Root $Root -GitArgs @('rev-parse', '--show-toplevel')) -join ''
    if ([string]::IsNullOrWhiteSpace($topLevel)) { return [pscustomobject]@{ Allowed = $false; Reason = '' } }
    $resolvedTopLevel = [System.IO.Path]::GetFullPath($topLevel).TrimEnd('\', '/')
    $resolvedRequestedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not $resolvedTopLevel.Equals($resolvedRequestedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Allowed = $false; Reason = '' }
    }
    $listing = Invoke-SafeGit -Root $Root -GitArgs @('config', '--list', '--show-scope', '-z') -Raw # 設定を読むだけで、何も実行しない。
    if ($null -eq $listing) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Git の情報を取得しません: Git の設定（git config --list --show-scope）を読み取れません。' }
    }
    # 出力は「scope NUL キー LF 値 NUL」の並び（値の無いキーは LF 以降が無い）。
    $tokens = $listing.Split([char]0) # scope と「キー LF 値」が交互に並ぶ。
    for ($index = 0; $index + 1 -lt $tokens.Count; $index += 2) {
        $scope = $tokens[$index].Trim().ToLowerInvariant() # 設定の置き場所。
        if ($scope -notin @('local', 'worktree')) { continue }
        $entry = $tokens[$index + 1] # 「キー LF 値」。
        $separatorIndex = $entry.IndexOf([char]10) # 値の無いキーでは -1。
        $key = if ($separatorIndex -ge 0) { $entry.Substring(0, $separatorIndex) } else { $entry } # 設定のキー。
        $value = if ($separatorIndex -ge 0) { $entry.Substring($separatorIndex + 1) } else { $null } # 設定の値。
        $isUnsafe = $false # 実行を伴いうるキーか。
        foreach ($pattern in $script:GitUnsafeConfigPatterns) {
            if ($key -match $pattern) { $isUnsafe = $true; break }
        }
        if (-not $isUnsafe) { continue }
        # 例外E1: Git LFS の正規の設定は、キーと値が大文字小文字を区別して完全に一致するときだけ危険とみなさない（ハッシュ表の照合は大文字小文字を区別しないため -cin で確かめる）。
        if ($null -ne $value -and ($key -cin @($script:GitLfsSafeValues.Keys)) -and ($value -cin @($script:GitLfsSafeValues[$key]))) { continue }
        return [pscustomobject]@{ Allowed = $false; Reason = "Git の情報を取得しません: .git/config に実行を伴いうる設定があります: $(ConvertTo-EscapedDisplayText -Value $key)" }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = '' }
}

# Get-GitCollectionState で許可されたときだけGitを読み取り専用で実行し、許可されない・利用不能なら空配列を返す。
function Invoke-ReadOnlyGit {
    param([string]$Root, [string[]]$GitArgs, [object]$State)
    if (-not $State.Allowed) { return @() }
    return @(Invoke-SafeGit -Root $Root -GitArgs $GitArgs)
}

# bridge設定のgitExposureを読み、キーが無ければ非公開として返す。
# 本物の真偽値 true のときだけ公開にする（サーバーの === true、Python版の is True と同じ）。-eq $true は文字列 "true" や数値 1 も真にするため使わない。
function Get-GitExposureSetting {
    param([object]$Config)
    $paths = $false # 変更ファイル名とサブモジュールのパスを公開するか。
    $commitSubjects = $false # コミット件名を公開するか。
    if ($null -ne $Config.PSObject.Properties['gitExposure'] -and $Config.gitExposure -is [System.Management.Automation.PSCustomObject]) {
        $exposure = $Config.gitExposure # gitExposure の設定（JSON object）。
        $paths = $null -ne $exposure.PSObject.Properties['paths'] -and $exposure.paths -is [bool] -and $exposure.paths
        $commitSubjects = $null -ne $exposure.PSObject.Properties['commitSubjects'] -and $exposure.commitSubjects -is [bool] -and $exposure.commitSubjects
    }
    return [pscustomobject]@{ Paths = $paths; CommitSubjects = $commitSubjects }
}

# 状態文書のAUTO Gitブロックだけをライブ値で更新する。名前を含む項目はgitExposureに従う。
function Update-ProjectStatus {
    param([string]$Root)
    $config = Read-BridgeConfig -Root $Root
    $statusRelative = if ($null -ne $config.PSObject.Properties['statusFile']) { [string]$config.statusFile } else { $script:StatusName }
    $statusPath = Resolve-SafeProjectFilePath -Root $Root -RelativePath $statusRelative -Label 'statusFile'
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { throw "状態文書がありません: $statusPath" }
    $gitExposure = Get-GitExposureSetting -Config $config # 状態文書へ書く名前の範囲。
    $gitState = Get-GitCollectionState -Root $Root # Git情報を集めてよいか。実行を伴う設定があれば「Git情報なし」と同じ扱いにする。
    if (-not [string]::IsNullOrEmpty($gitState.Reason)) { Write-Host "警告: $($gitState.Reason)" }

    $branch = (Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')) -join ''
    $headFormat = if ($gitExposure.CommitSubjects) { '--format=%h|%H|%ci|%s' } else { '--format=%h|%H|%ci' } # HEAD表示の書式。
    $recentFormat = if ($gitExposure.CommitSubjects) { '--format=- %h %ci %s' } else { '--format=- %h %ci' } # 直近コミット表示の書式。
    $head = (Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs (@('log', '-1') + $script:GitNoDiffProgramOptions + @($headFormat))) -join ''
    $aheadBehind = (Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs @('rev-list', '--left-right', '--count', 'HEAD...origin/main')) -join ' '
    # --ignore-submodules=dirty: サブモジュールの中で子のgit（検査していない子の .git/config のフィルターなど）を起動しない。
    $porcelain = @(Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs @('status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'))
    $recent = @(Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs (@('log', '-10') + $script:GitNoDiffProgramOptions + @($recentFormat)))
    $submodules = @(if ($gitExposure.Paths) { Invoke-ReadOnlyGit -Root $Root -State $gitState -GitArgs @('submodule', 'status') }) # 公開時だけ収集するサブモジュール一覧。if の結果を @() で包み、0件・1件でも配列のままにする（.Count がStrictModeで例外にならない）。
    $modified = 0
    $added = 0
    $deleted = 0
    $untracked = 0
    foreach ($line in $porcelain) {
        if ($line.Length -lt 2) { continue }
        $code = $line.Substring(0, 2)
        if ($code -eq '??') { $untracked++; continue }
        if ($code.Contains('D')) { $deleted++; continue }
        if ($code.Contains('A')) { $added++; continue }
        if ($code -match '[MRTU]') { $modified++; continue }
    }
    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
    $recentText = if ($recent.Count -gt 0) { $recent -join "`n" } else { '- Git履歴なし、またはGitリポジトリではありません。' }
    $submoduleText = if (-not $gitExposure.Paths) { '- 非公開（gitExposure.paths が false）' } elseif ($submodules.Count -gt 0) { ($submodules | ForEach-Object { "- $_" }) -join "`n" } else { '- なし、または取得不能' }
    $autoBody = @"
## Git自動収集

- 収集日時：$timestamp
- ブランチ：$(if ($branch) { $branch } else { 'Git情報なし' })
- HEAD：$(if ($head) { $head } else { 'Git情報なし' })
- origin/mainとの差：$(if ($aheadBehind) { $aheadBehind } else { '取得不能' })
- 作業ツリー：変更 $modified / 追加 $added / 削除 $deleted / 未追跡 $untracked

### 直近コミット

$recentText

### サブモジュール

$submoduleText
"@.Trim()
    $begin = '<!-- AUTO:BEGIN git -->'
    $end = '<!-- AUTO:END git -->'
    $replacement = "$begin`n$autoBody`n$end"
    # 不正なバイトで例外を投げるUTF-8デコーダーで読む。Get-Content -Encoding UTF8 は不正なUTF-8（Shift_JIS保存など）を黙ってU+FFFDにし、書き戻しで元の文字が失われる。
    try {
        $statusBytes = [System.IO.File]::ReadAllBytes($statusPath) # 状態文書の中身。
    } catch {
        throw "状態文書を読み取れません: ${statusPath}: $($_.Exception.Message)"
    }
    $bomLength = if ($statusBytes.Length -ge 3 -and $statusBytes[0] -eq 0xEF -and $statusBytes[1] -eq 0xBB -and $statusBytes[2] -eq 0xBF) { 3 } else { 0 } # BOM付きUTF-8ならBOMを取り除く。
    try {
        $content = [System.Text.UTF8Encoding]::new($false, $true).GetString($statusBytes, $bomLength, $statusBytes.Length - $bomLength) # 空のファイルは空文字になる。
    } catch {
        throw "状態文書を読み取れません（UTF-8 ではありません）: $statusPath"
    }
    $pattern = [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
    if ([regex]::IsMatch($content, $pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)) {
        $updated = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement }, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    } else {
        $updated = $content.TrimEnd() + "`n`n" + $replacement + "`n"
    }
    Write-AtomicUtf8Text -Path $statusPath -Content $updated -Label 'statusFile'
    Write-Host "状態文書のAUTO Gitブロックを更新しました: $statusPath"
}

# Windows DPAPIで保存したキーを一時的に環境変数へ設定して処理する。
function Invoke-WithRuntimeKey {
    param([string]$ProfileName, [scriptblock]$Operation)
    $keyPath = Join-Path $env:APPDATA "tunnel-client\$ProfileName.key.dpapi"
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw "保存キーがありません。先に -Action SaveKey を実行してください: $keyPath" }
    $ciphertext = Get-Content -LiteralPath $keyPath -Raw -Encoding ASCII
    $secureKey = ConvertTo-SecureString $ciphertext
    $credential = [pscredential]::new('tunnel-client', $secureKey)
    $plainKey = $credential.GetNetworkCredential().Password
    $previousItem = Get-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    try {
        $env:CONTROL_PLANE_API_KEY = $plainKey
        & $Operation
    } finally {
        if ($null -ne $previousItem) { $env:CONTROL_PLANE_API_KEY = $previousItem.Value }
        else { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
        $plainKey = $null
        $credential = $null
        $secureKey = $null
        $ciphertext = $null
    }
}

# Initで必要な3ファイルを既存内容を守りながら作成する。
function Initialize-ProjectBridge {
    param([string]$Root, [string]$Name, [switch]$Replace)
    $configPath = Join-Path $Root $script:ConfigName
    if ((Test-Path -LiteralPath $configPath) -and -not $Replace) {
        throw "bridge設定は既にあります。置き換える場合だけ -Force を指定してください: $configPath"
    }
    $resolvedName = if ([string]::IsNullOrWhiteSpace($Name)) { Split-Path $Root -Leaf } else { $Name }
    if (Test-ForbiddenCharacter -Text $resolvedName) { # 設定・文書を書く前に止め、何も作らない。
        throw "公開範囲の設定に使えない文字が含まれています: projectName = $(ConvertTo-DisplayQuoted -Value $resolvedName)"
    }
    $profileName = New-ProfileName -Name $resolvedName -Root $Root
    $config = [ordered]@{
        schemaVersion = 1
        projectName = $resolvedName
        contextFile = $script:ContextName
        statusFile = $script:StatusName
        profileName = $profileName
        tunnelId = $null
        healthPort = $null
        allowFiles = @($script:ContextName, $script:StatusName, 'README.md')
        allowDirectories = @()
        denyDirectories = @('.git', '.codex', '.claude', 'node_modules', 'Saved', 'Prompts', 'Documents', 'Build', 'Builds', 'dist', 'out', 'zzz-Temp')
        maxDocumentBytes = 524288
        gitExposure = [ordered]@{ paths = $false; commitSubjects = $false } # Gitのファイル名とコミット件名は既定で非公開。
    }
    Write-BridgeConfig -Root $Root -Config $config

    $today = (Get-Date).ToString('yyyy-MM-dd')
    foreach ($template in @(
        @{ Source = 'CHATGPT_PROJECT_CONTEXT.template.md'; Target = $script:ContextName },
        @{ Source = 'CHATGPT_PROJECT_STATUS.template.md'; Target = $script:StatusName }
    )) {
        $targetPath = Join-Path $Root $template.Target
        Assert-NotReparsePoint -Path $targetPath -Label $template.Target
        if (Test-Path -LiteralPath $targetPath) {
            Write-Host "既存文書を保持しました: $targetPath"
            continue
        }
        $sourcePath = Join-Path $script:SkillRoot "assets\$($template.Source)"
        $content = (Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8).Replace('{{PROJECT_NAME}}', $resolvedName).Replace('{{TODAY}}', $today)
        Write-AtomicUtf8Text -Path $targetPath -Content $content -Label $template.Target
        Write-Host "文書を作成しました: $targetPath"
    }
    Update-ProjectStatus -Root $Root
    Write-Host "bridge設定を作成しました: $configPath"
    Write-Host '公開範囲を確認してからTunnelを設定してください。既定では概要、状態、ルートREADMEだけです。Gitのファイル名とコミット件名は公開しません。'
}

# プロジェクトの設定を使ってローカルstdio自己試験と公開境界の自己試験を実行する。
function Test-ProjectBridge {
    param([string]$Root)
    $nodePath = Find-NodeExecutable
    $configPath = Join-Path $Root $script:ConfigName
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        & $nodePath $script:SelfTestPath --project-root $Root --config $configPath
        if ($LASTEXITCODE -ne 0) { throw "MCP自己試験に失敗しました。終了コード: $LASTEXITCODE" }
        & $nodePath $script:SecuritySelfTestPath
        if ($LASTEXITCODE -ne 0) { throw "公開境界の自己試験に失敗しました。終了コード: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# プロファイルごとの公開範囲承認ファイルのパスを返す。プロジェクト外のユーザー領域に置く。
function Get-ApprovalPath {
    param([string]$ProfileName)
    [void](Assert-ProfileName -Name $ProfileName)
    return Join-Path $env:APPDATA "chatgpt-project-bridge\approvals\$ProfileName.json"
}

# 承認ファイルの保存フォルダーと、%APPDATA% からそこまでの途中のフォルダー（chatgpt-project-bridge・approvals）に、リンクやジャンクションがあれば止める。
# 書き込みだけでなく読み取り（ShowExposure・Doctor・Start など）でも同じ検査をする（Python版の find_approval_path と同じ趣旨）。フォルダーは作らない。
# %APPDATA% の外にある承認ファイル（手で書き換えたハブ設定など）は、保存フォルダーそのものだけを調べる。
function Assert-ApprovalDirectory {
    param([string]$ApprovalPath)
    $approvalDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ApprovalPath)) # 承認ファイルの保存フォルダー。
    if ([string]::IsNullOrEmpty($approvalDirectory)) { throw "承認ファイルのパスが不正です（ドライブや共有の直下を指しています）: $ApprovalPath" } # 手で書き換えたハブ設定の approvalFile が C:\ などのとき。
    $appDataPrefix = [System.IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar # %APPDATA% の配下を表す接頭辞。
    if ($approvalDirectory.StartsWith($appDataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Assert-NoReparsePointBelow -Base $env:APPDATA -Path $approvalDirectory -Label '承認ファイルの保存フォルダー'
    } else {
        Assert-NotReparsePoint -Path $approvalDirectory -Label '承認ファイルの保存フォルダー'
    }
}

# MCPサーバー自身に公開範囲を正規化させ、指紋と内容を返す。表示する値に禁止文字があれば、承認の確認へ進まずに止める。
# CandidateText（2.8.0）を渡すと、実際の設定ファイルではなく、その候補の設定（JSONの文字列。一時フォルダーのファイルに書く）の公開範囲を求める。実際の設定は書かない。
function Get-BridgeExposure {
    param([string]$Root, [string]$CandidateText)
    $nodePath = Find-NodeExecutable
    $configPath = Join-Path $Root $script:ConfigName
    Assert-NotReparsePoint -Path $configPath -Label 'bridge設定'
    $hasCandidate = -not [string]::IsNullOrEmpty($CandidateText) # 候補の設定で求めるか。
    $displayedConfig = if ($hasCandidate) { $CandidateText | ConvertFrom-Json } else { Read-BridgeConfig -Root $Root } # 表示する値の検査に使う設定。
    $forbiddenMessage = Get-ForbiddenValueMessage -Source $displayedConfig -TextFields $script:ConfigTextFields # 設定そのものに禁止文字があるときのエラー文。
    if (-not [string]::IsNullOrEmpty($forbiddenMessage)) { throw $forbiddenMessage }
    $candidateDirectory = $null # 候補の設定を置く一時フォルダー。
    $serverConfigPath = $configPath # サーバーに読ませる設定。
    if ($hasCandidate) {
        $candidateDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('bridge-permission-' + [guid]::NewGuid().ToString('N'))
        [System.IO.Directory]::CreateDirectory($candidateDirectory) | Out-Null
        $serverConfigPath = Join-Path $candidateDirectory $script:ConfigName
        Write-Utf8Text -Path $serverConfigPath -Content $CandidateText
    }
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        $output = & $nodePath $script:ServerPath --print-exposure --project-root $Root --config $serverConfigPath
        if ($LASTEXITCODE -ne 0) { throw "公開範囲を取得できません。終了コード: $LASTEXITCODE" }
    } finally {
        Pop-Location
        if ($null -ne $candidateDirectory -and (Test-Path -LiteralPath $candidateDirectory)) { Remove-Item -LiteralPath $candidateDirectory -Recurse -Force }
    }
    try {
        $printed = ($output -join "`n") | ConvertFrom-Json -NoEnumerate # サーバーが出力した公開範囲と指紋。
    } catch {
        throw "公開範囲を取得できません: サーバーの出力をJSONとして読めません: $($_.Exception.Message)" # 出力が途中で切れた・壊れた。
    }
    if ($printed -isnot [System.Management.Automation.PSCustomObject] -or $null -eq $printed.PSObject.Properties['sha256'] -or [string]$printed.sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw '公開範囲の指紋が不正です。' }
    if ($null -eq $printed.PSObject.Properties['exposure'] -or $printed.exposure -isnot [System.Management.Automation.PSCustomObject]) { throw '公開範囲の内容が不正です。' }
    $forbiddenMessage = Get-ForbiddenValueMessage -Source $printed.exposure -TextFields $script:ExposureTextFields
    if (-not [string]::IsNullOrEmpty($forbiddenMessage)) { throw $forbiddenMessage }
    return $printed
}

# 承認ファイルを読み、無いか壊れているか、JSONの最上位が object でなければ $null を返す（未承認として扱う）。
function Read-ExposureApproval {
    param([string]$ApprovalPath)
    Assert-ApprovalDirectory -ApprovalPath $ApprovalPath
    Assert-NotReparsePoint -Path $ApprovalPath -Label '公開範囲の承認ファイル'
    if (-not (Test-Path -LiteralPath $ApprovalPath -PathType Leaf)) { return $null }
    try { $approval = Get-Content -LiteralPath $ApprovalPath -Raw -Encoding UTF8 | ConvertFrom-Json -NoEnumerate } catch { return $null } # 配列を要素へ分けずに読み、形を確かめる。
    if ($approval -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    return $approval
}

# 承認ファイルに記録された指紋を返す。[string] で小文字16進64桁のときだけ返し、それ以外は空文字を返す。
function Get-ApprovedSha256 {
    param([object]$Approval)
    if ($null -eq $Approval -or $null -eq $Approval.PSObject.Properties['sha256']) { return '' }
    $recorded = $Approval.sha256 # 記録された値（型は確かめていない）。
    if ($recorded -is [string] -and $recorded -cmatch '^[0-9a-f]{64}\z') { return $recorded }
    return ''
}

# 承認ファイルに記録された公開範囲を返す。無い・形が不正なら $null を返す。
function Get-ApprovedExposure {
    param([object]$Approval)
    if ($null -eq $Approval -or $null -eq $Approval.PSObject.Properties['exposure']) { return $null }
    if ($Approval.exposure -is [System.Management.Automation.PSCustomObject]) { return $Approval.exposure }
    return $null
}

# 承認ファイルに記録されたプロジェクトルートを返す（共通仕様S4）。無い・壊れている・文字列でなければ $null を返す。
function Get-ApprovedProjectRoot {
    param([object]$Approval)
    $previous = Get-ApprovedExposure -Approval $Approval # 前回承認した公開範囲。
    if ($null -ne $previous -and $null -ne $previous.PSObject.Properties['projectRoot'] -and $previous.projectRoot -is [string]) { return [string]$previous.projectRoot }
    return $null
}

# 前回承認した公開範囲と現在の公開範囲を項目ごとに比べ、変わった項目を「項目名: 前 -> 後」の文字列で1件ずつ返す。表示は呼び出し側が行う。
# ConvertTo-Json が退避しない禁止文字（書式文字など）は \uXXXX にして、行の形は変えない。
function Get-ExposureChangeLine {
    param([object]$Exposure, [object]$PreviousExposure)
    if ($null -eq $PreviousExposure) { return }
    $fieldNames = @('projectRoot', 'contextFile', 'statusFile', 'allowFiles', 'allowDirectories', 'denyDirectories', 'maxDocumentBytes', 'gitExposure') # 比較対象の項目。
    # 2.5.0 の詳細取得の公開設定は、どちらかにあるときだけ比べる（どちらにも無いときに「なし」と「null」の偽の差分を出さない）。
    if ($null -ne $PreviousExposure.PSObject.Properties['detailExposure'] -or $null -ne $Exposure.PSObject.Properties['detailExposure']) { $fieldNames += 'detailExposure' }
    # 2.6.0 のソース読み取り範囲を広げる設定も同様に、どちらかにあるときだけ比べる。
    if ($null -ne $PreviousExposure.PSObject.Properties['sourceScope'] -or $null -ne $Exposure.PSObject.Properties['sourceScope']) { $fieldNames += 'sourceScope' }
    # 2.7.0 のClaude Codeのジョブ実行を許可する設定も同様に、どちらかにあるときだけ比べる。
    if ($null -ne $PreviousExposure.PSObject.Properties['claudeCode'] -or $null -ne $Exposure.PSObject.Properties['claudeCode']) { $fieldNames += 'claudeCode' }
    foreach ($name in $fieldNames) {
        # 項目の有無は PSObject.Properties[名前] で確かめる（{} に .PSObject.Properties.Name を読むと StrictMode で例外になる）。
        $before = if ($null -ne $PreviousExposure.PSObject.Properties[$name]) { ConvertTo-Json -InputObject $PreviousExposure.$name -Depth 6 -Compress } else { '(なし)' }
        $after = if ($null -ne $Exposure.PSObject.Properties[$name]) { ConvertTo-Json -InputObject $Exposure.$name -Depth 6 -Compress } else { 'null' }
        if ($before -cne $after) { "${name}: $(ConvertTo-EscapedDisplayText -Value $before) -> $(ConvertTo-EscapedDisplayText -Value $after)" }
    }
}

# 公開範囲の項目の値を配列として返す。無い・$null なら空配列を返す。
function Get-ExposureItem {
    param([object]$Exposure, [string]$Name)
    if ($null -eq $Exposure.PSObject.Properties[$Name] -or $null -eq $Exposure.$Name) { return @() }
    return @($Exposure.$Name)
}

# 公開範囲の全項目を、承認する前に読む順で表示する。値はすべて引用し、配列は1項目1行で件数とともに省略せず出す。
# 最後の4行は要約と指紋で、承認のプロンプトの直前に来る。OtherRoot は同じプロファイル名で承認された別フォルダー（無ければ空文字）。
function Show-ExposureDetails {
    param([object]$Exposure, [object]$PreviousExposure, [string]$Sha256, [string]$ProfileName, [string]$OtherRoot)
    $files = @(Get-ExposureItem -Exposure $Exposure -Name 'allowFiles') # 公開ファイル。
    $directories = @(Get-ExposureItem -Exposure $Exposure -Name 'allowDirectories' | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] }) # 公開ディレクトリの規則。
    $denied = @(Get-ExposureItem -Exposure $Exposure -Name 'denyDirectories') # 拒否ディレクトリ。
    $recursiveFlags = @($directories | ForEach-Object { $null -ne $_.PSObject.Properties['recursive'] -and $_.recursive -is [bool] -and $_.recursive }) # 規則ごとの「配下すべて」か。
    $recursiveCount = @($recursiveFlags | Where-Object { $_ }).Count # 配下すべてを公開するディレクトリの数。
    $git = if ($null -ne $Exposure.PSObject.Properties['gitExposure'] -and $Exposure.gitExposure -is [System.Management.Automation.PSCustomObject]) { $Exposure.gitExposure } else { [pscustomobject]@{} } # Git情報の公開設定。
    $gitPaths = $null -ne $git.PSObject.Properties['paths'] -and $git.paths -is [bool] -and $git.paths # Gitのファイル名を公開するか。
    $gitSubjects = $null -ne $git.PSObject.Properties['commitSubjects'] -and $git.commitSubjects -is [bool] -and $git.commitSubjects # Gitのコミット件名を公開するか。
    $gitLine = "Git のファイル名: $(if ($gitPaths) { '公開' } else { '非公開' }) / Git のコミット件名: $(if ($gitSubjects) { '公開' } else { '非公開' })" # Git情報の公開設定の1行。
    # 2.5.0 の詳細取得ツールの公開設定。設定が無ければ $null（すべて非公開）で、1行も出さない。
    $detailLine = $null # 詳細取得ツールの公開設定の1行。
    if ($null -ne $Exposure.PSObject.Properties['detailExposure'] -and $Exposure.detailExposure -is [System.Management.Automation.PSCustomObject]) {
        $detail = $Exposure.detailExposure # 詳細取得ツールの公開設定（JSON object）。
        $detailBranches = $null -ne $detail.PSObject.Properties['branchNames'] -and $detail.branchNames -is [bool] -and $detail.branchNames # ブランチ名を公開するか。
        $detailDiffs = $null -ne $detail.PSObject.Properties['diffExcerpts'] -and $detail.diffExcerpts -is [bool] -and $detail.diffExcerpts # 差分の抜粋を公開するか。
        $detailSource = $null -ne $detail.PSObject.Properties['sourceText'] -and $detail.sourceText -is [bool] -and $detail.sourceText # ファイル本文を公開するか。
        $detailLine = "詳細取得ツール: ブランチ名 $(if ($detailBranches) { '公開' } else { '非公開' }) / 差分の抜粋 $(if ($detailDiffs) { '公開' } else { '非公開' }) / ファイル本文（設定・ソース・記録） $(if ($detailSource) { '公開' } else { '非公開' })"
    }
    # 2.6.0 のソース読み取り範囲を広げる設定。設定が無ければ $null（広げない）で、1行も出さない。
    $scopeLine = $null # ソース読み取り範囲の公開設定の1行。
    if ($null -ne $Exposure.PSObject.Properties['sourceScope'] -and $Exposure.sourceScope -is [System.Management.Automation.PSCustomObject]) {
        $scope = $Exposure.sourceScope # ソース読み取り範囲を広げる設定（JSON object）。
        $scopeAdditional = @(Get-ExposureItem -Exposure $scope -Name 'additionalDirectories') # 既定除外のうち明示的に開けるディレクトリ。
        $scopeLogs = @(Get-ExposureItem -Exposure $scope -Name 'logDirectories' | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] }) # read_test_log が読んでよい場所。
        $scopeAdditionalText = if ($scopeAdditional.Count -gt 0) { '（' + (($scopeAdditional | ForEach-Object { ConvertTo-DisplayQuoted -Value $_ }) -join '、') + '）' } else { '' } # 追加で開けるディレクトリの表示。
        $scopeLogsText = if ($scopeLogs.Count -gt 0) {
            '（' + (($scopeLogs | ForEach-Object {
                $logPath = if ($null -ne $_.PSObject.Properties['path']) { $_.path } else { '' } # 規則のパス。
                $logRecursive = $null -ne $_.PSObject.Properties['recursive'] -and $_.recursive -is [bool] -and $_.recursive # 配下すべてか。
                "$(ConvertTo-DisplayQuoted -Value $logPath)$(if ($logRecursive) { '（配下すべて）' } else { '（直下だけ）' })"
            }) -join '、') + '）'
        } else { '' } # ログの読み取り場所の表示。
        $scopeLine = "ソース読み取り範囲: 追加で開けるディレクトリ $($scopeAdditional.Count) 件$scopeAdditionalText / ログの読み取り場所 $($scopeLogs.Count) 件$scopeLogsText"
    }
    # 2.7.0 のClaude Codeのジョブ実行を許可する設定。設定が無ければ $null（無効）で、1行も出さない。
    $claudeCodeLine = $null # Claude Codeのジョブ実行を許可する設定の1行。
    $claudeCodeWarning = $null # claudeCode.enabled が true のときに必ず出す警告（文言は固定）。
    if ($null -ne $Exposure.PSObject.Properties['claudeCode'] -and $Exposure.claudeCode -is [System.Management.Automation.PSCustomObject]) {
        $claudeCode = $Exposure.claudeCode # Claude Codeのジョブ実行を許可する設定（JSON object）。
        $claudeEnabled = $null -ne $claudeCode.PSObject.Properties['enabled'] -and $claudeCode.enabled -is [bool] -and $claudeCode.enabled # ChatGPTからClaude Codeのジョブ実行を許可するか。
        $claudeCommands = @(Get-ExposureItem -Exposure $claudeCode -Name 'allowedCommands') # 確認なしで実行してよいコマンド。
        $claudeCommandsText = if ($claudeCommands.Count -gt 0) {
            "コマンドの実行（$($claudeCommands.Count) 件。確認なしで実行できます）: " + (($claudeCommands | ForEach-Object { ConvertTo-DisplayQuoted -Value $_ }) -join '、')
        } else { 'コマンドの実行: なし（ファイルの編集だけ）' } # コマンドの実行の表示。
        $claudeModel = if ($null -ne $claudeCode.PSObject.Properties['model'] -and $claudeCode.model -is [string]) { ConvertTo-DisplayQuoted -Value $claudeCode.model } else { '（指定なし）' } # 使うモデルの表示。
        $claudeEffort = if ($null -ne $claudeCode.PSObject.Properties['effort'] -and $claudeCode.effort -is [string]) { ConvertTo-DisplayQuoted -Value $claudeCode.effort } else { '（指定なし）' } # 思考の強さの表示。
        $claudeMinutes = if ($null -ne $claudeCode.PSObject.Properties['maxMinutes']) { $claudeCode.maxMinutes } else { '' } # 1ジョブの制限時間（分）。
        $claudeBudget = if ($null -ne $claudeCode.PSObject.Properties['maxBudgetUsd'] -and $null -ne $claudeCode.maxBudgetUsd) { '$' + (ConvertTo-EscapedDisplayText -Value ([string]$claudeCode.maxBudgetUsd)) } else { '（指定なし）' } # 推定コストの上限の表示。
        $claudeCodeLine = "Claude Code のジョブ: $(if ($claudeEnabled) { '有効' } else { '無効' }) / $claudeCommandsText / model: $claudeModel / effort: $claudeEffort / 制限時間: $(ConvertTo-EscapedDisplayText -Value ([string]$claudeMinutes)) 分 / 推定コストの上限: $claudeBudget"
        if ($claudeEnabled) {
            $claudeCodeWarning = '警告: この承認で、ChatGPT から Claude Code を起動し、このプロジェクトの作業ツリーのファイルを書き換えさせ、次のコマンドを確認なしで実行させられるようになります（git の commit・push はできません。Claude Code の利用枠を消費します）。許可したコマンドがプロジェクト内のスクリプトを実行する場合、Claude Code はそのスクリプトを書き換えてから実行できるため、実質的に任意のコードを実行できます。'
        }
    }
    $projectRoot = if ($null -ne $Exposure.PSObject.Properties['projectRoot']) { $Exposure.projectRoot } else { '' } # 公開するプロジェクトのフォルダー。
    $maxBytes = if ($null -ne $Exposure.PSObject.Properties['maxDocumentBytes']) { $Exposure.maxDocumentBytes } else { '' } # 文書1件の上限。
    if (-not [string]::IsNullOrEmpty($OtherRoot)) {
        Write-Host ('!' * 60)
        Write-Host "警告: このプロファイル名は別のフォルダー $(ConvertTo-DisplayQuoted -Value $OtherRoot) の承認に使われています。承認すると、そのフォルダーの承認が上書きされます。"
        Write-Host ('!' * 60)
    }
    Write-Host "公開範囲の確認（承認状態: $(if ($null -ne $PreviousExposure) { '前回から変更あり' } else { '未承認' })）"
    Write-Host "プロジェクトルート: $(ConvertTo-DisplayQuoted -Value $projectRoot)"
    Write-Host "プロファイル: $(ConvertTo-DisplayQuoted -Value $ProfileName)"
    if ($null -ne $PreviousExposure) {
        $changes = @(Get-ExposureChangeLine -Exposure $Exposure -PreviousExposure $PreviousExposure) # 前回の承認から変わった項目。
        Write-Host "前回の承認から変わった項目（$($changes.Count) 件）:"
        foreach ($changeLine in $changes) { Write-Host "  - $changeLine" }
    }
    Write-Host "公開ファイル（$($files.Count) 件）:"
    for ($index = 0; $index -lt $files.Count; $index++) { Write-Host "  $($index + 1). $(ConvertTo-DisplayQuoted -Value $files[$index])" }
    Write-Host "公開ディレクトリ（$($directories.Count) 件）:"
    for ($index = 0; $index -lt $directories.Count; $index++) {
        $rulePath = if ($null -ne $directories[$index].PSObject.Properties['path']) { $directories[$index].path } else { '' } # 規則のパス。
        Write-Host "  $($index + 1). $(ConvertTo-DisplayQuoted -Value $rulePath)$(if ($recursiveFlags[$index]) { '（配下すべて）' } else { '（直下だけ）' })"
    }
    Write-Host "拒否ディレクトリ（$($denied.Count) 件）:"
    for ($index = 0; $index -lt $denied.Count; $index++) { Write-Host "  $($index + 1). $(ConvertTo-DisplayQuoted -Value $denied[$index])" }
    Write-Host $gitLine
    if ($null -ne $detailLine) { Write-Host $detailLine }
    if ($null -ne $scopeLine) { Write-Host $scopeLine }
    if ($null -ne $claudeCodeLine) { Write-Host $claudeCodeLine }
    if ($null -ne $claudeCodeWarning) { Write-Host $claudeCodeWarning }
    Write-Host "文書 1 件の上限: $(ConvertTo-EscapedDisplayText -Value $maxBytes) バイト"
    Write-Host '─── 承認する内容の要約（最終確認） ───'
    Write-Host "公開ファイル $($files.Count) 件 / 公開ディレクトリ $($directories.Count) 件（うち配下すべて $recursiveCount 件） / 拒否ディレクトリ $($denied.Count) 件"
    Write-Host $gitLine
    if ($null -ne $detailLine) { Write-Host $detailLine }
    if ($null -ne $scopeLine) { Write-Host $scopeLine }
    if ($null -ne $claudeCodeLine) { Write-Host $claudeCodeLine }
    if ($null -ne $claudeCodeWarning) { Write-Host $claudeCodeWarning }
    Write-Host "公開範囲の指紋（SHA-256）: $Sha256"
}

# 公開範囲が承認済みかを確認し、未承認なら内容を表示して承認を求める。承認済みなら $true を返す。
function Confirm-BridgeExposure {
    param([string]$Root, [string]$ProfileName, [string]$ExpectedSha256, [switch]$NoPrompt)
    $printed = Get-BridgeExposure -Root $Root
    $approvalPath = Get-ApprovalPath -ProfileName $ProfileName
    $approval = Read-ExposureApproval -ApprovalPath $approvalPath
    $approvedSha = Get-ApprovedSha256 -Approval $approval # 前回承認した指紋。形が不正なら空文字。
    if ($approvedSha -ne '' -and $approvedSha -ceq [string]$printed.sha256) {
        Write-Host "公開範囲は承認済みです（指紋 $($printed.sha256)）。"
        return $true
    }
    $previous = Get-ApprovedExposure -Approval $approval # 前回承認した公開範囲。
    $recordedRoot = Get-ApprovedProjectRoot -Approval $approval # 同じプロファイル名で承認されたフォルダー。
    $currentRoot = if ($null -ne $printed.exposure.PSObject.Properties['projectRoot']) { [string]$printed.exposure.projectRoot } else { '' } # 今回のフォルダー。
    # 別フォルダーの承認を上書きするときだけ警告する。Windows（NTFS）は通常パスの大文字小文字を区別しないため、大文字小文字だけ違う同じフォルダーを
    # 別物としないよう OrdinalIgnoreCase で比べる。-ine はカルチャ依存の比較で、NFC/NFD・ゼロ幅文字・ケルビン記号（U+212A）だけ違う別のパスも同じとみなすため使わない。
    # 指紋には projectRoot が入っており、指紋そのものは上の -ceq の完全一致で比べている。
    $otherRoot = if ($null -ne $recordedRoot -and -not [string]::Equals($recordedRoot, $currentRoot, [System.StringComparison]::OrdinalIgnoreCase)) { $recordedRoot } else { '' }
    Show-ExposureDetails -Exposure $printed.exposure -PreviousExposure $previous -Sha256 ([string]$printed.sha256) -ProfileName $ProfileName -OtherRoot $otherRoot
    if ($NoPrompt) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        if ($ExpectedSha256.Trim().ToLowerInvariant() -cne [string]$printed.sha256) { throw '-ExposureSha256 が現在の公開範囲の指紋と一致しません。表示された内容を確認してください。' }
    } else {
        $answer = (Read-Host 'この公開範囲をChatGPTへ公開することを承認しますか? [yes/NO]').Trim().ToLowerInvariant()
        if ($answer -notin @('yes', 'y')) { throw '公開範囲が承認されなかったため中止しました。' }
    }
    Save-ExposureApproval -ApprovalPath $approvalPath -Printed $printed
    Write-Host "公開範囲の承認を保存しました: $approvalPath"
    return $true
}

# 公開範囲の承認ファイルを、同じフォルダーの一時ファイルから原子的に保存する（承認の確認を終えたあとだけ呼ぶ）。
function Save-ExposureApproval {
    param([string]$ApprovalPath, [object]$Printed)
    $approvalDirectory = Split-Path $ApprovalPath -Parent
    [System.IO.Directory]::CreateDirectory($approvalDirectory) | Out-Null
    Assert-ApprovalDirectory -ApprovalPath $ApprovalPath # 作ったフォルダーと途中のフォルダーがリンクやジャンクションでないことを確かめる。
    $record = [ordered]@{ schemaVersion = 1; sha256 = [string]$Printed.sha256; approvedAt = (Get-Date).ToString('o'); exposure = $Printed.exposure } # 保存する承認内容。
    $temporary = "$ApprovalPath.$([guid]::NewGuid().ToString('N')).tmp" # 原子的に置き換えるための一時ファイル。
    try {
        Write-Utf8Text -Path $temporary -Content ((($record | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n") # ハブ設定と同じく、ConvertTo-JsonのCRLFをLFへ揃える。
        Move-Item -LiteralPath $temporary -Destination $ApprovalPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

# 公開範囲・指紋・承認状態・前回承認との差分を、機械可読なJSON文字列1つとして返す。読み取り専用で、承認ファイルもプロジェクト設定も作らない。
# CandidateText（2.8.0）を渡すと、設定をその候補（JSONの文字列）に変えた場合の公開範囲として求める（承認状態は、いまの承認ファイルと比べる。候補は一時フォルダーに置き、終わると消す）。
function Get-ExposureReport {
    param([string]$Root, [string]$ProfileName, [string]$CandidateText)
    $printed = Get-BridgeExposure -Root $Root -CandidateText $CandidateText
    $approval = Read-ExposureApproval -ApprovalPath (Get-ApprovalPath -ProfileName $ProfileName)
    $approvedSha = Get-ApprovedSha256 -Approval $approval # 承認済みの指紋。承認が無いか、指紋が小文字16進64桁の文字列でなければ空。
    $approvalState = if ($null -eq $approval) { 'unapproved' } elseif ($approvedSha -ne '' -and $approvedSha -ceq [string]$printed.sha256) { 'approved' } else { 'changed' } # 承認ファイルが無ければ未承認、指紋が一致すれば承認済み、違えば変更あり。
    $approvedValue = if ($approvedSha -ne '') { $approvedSha } else { $null } # JSONへ入れる承認済みの指紋。承認が無ければnull。
    $previous = Get-ApprovedExposure -Approval $approval # 前回承認した公開範囲。
    $changes = @() # 前回承認との差分。差分が無い、または未承認なら空配列のまま。
    if ($approvalState -eq 'changed' -and $null -ne $previous) { $changes = @(Get-ExposureChangeLine -Exposure $printed.exposure -PreviousExposure $previous) }
    $report = [ordered]@{
        schemaVersion = 1
        projectRoot = $Root
        profile = $ProfileName
        exposureSha256 = [string]$printed.sha256
        approvalState = $approvalState
        approvedSha256 = $approvedValue
        approvedProjectRoot = (Get-ApprovedProjectRoot -Approval $approval) # 承認ファイルに記録されたフォルダー（共通仕様S4）。別のフォルダーなら、承認すると上書きになる。
        exposure = $printed.exposure
        changes = $changes
    } # 出力するJSONの内容。changesは配列のまま渡す（単一要素でも配列として出る）。
    return (ConvertTo-TerminalJson -Json ($report | ConvertTo-Json -Depth 10))
}

<#
  公開設定に、権限の切り替え（2.8.0）を反映した候補を、Node.js の部品（bridge-permission.mjs。Ubuntu版と同じ変換）で作る。実際の設定は書かない。
  - SourceRead on: detailExposure.sourceText と gitExposure.paths を true にする。off: detailExposure.sourceText だけ false にする（paths は残す）。
  - ClaudeCode on / off: claudeCode.enabled を true / false にする（claudeCode が無い on は {"enabled": true}＝許可コマンドなしで作る。無い off は何もしない）。
  - AllowedCommand: 渡したときだけ claudeCode.allowedCommands を置き換える（書けないコマンドの検証は、公開範囲を求めるときにサーバーが行う）。
  指定しなかった項目は変えない。戻り値: Text（候補のJSONの文字列）と Changed（設定が変わるか）を持つオブジェクト。
#>
function New-PermissionCandidate {
    param([string]$Root, [string]$SourceRead, [string]$ClaudeCode, [string[]]$AllowedCommand)
    $nodePath = Find-NodeExecutable
    $configPath = Join-Path $Root $script:ConfigName
    Assert-NotReparsePoint -Path $configPath -Label 'bridge設定'
    $workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('bridge-permission-' + [guid]::NewGuid().ToString('N')) # 候補を受け取る一時フォルダー。
    [System.IO.Directory]::CreateDirectory($workDirectory) | Out-Null
    try {
        $outputPath = Join-Path $workDirectory 'candidate.json' # 候補の保存先（部品が新しく作る）。
        $helperArguments = @($script:PermissionHelperPath, '--config', $configPath, '--output', $outputPath) # 部品に渡す引数。
        if (-not [string]::IsNullOrEmpty($SourceRead)) { $helperArguments += @('--source-read', $SourceRead.ToLowerInvariant()) }
        if (-not [string]::IsNullOrEmpty($ClaudeCode)) { $helperArguments += @('--claude-code', $ClaudeCode.ToLowerInvariant()) }
        # -File で起動すると、同じ引数を複数回は指定できない（配列は1つの値になる）。そのため 1 つの値に改行で区切って複数を渡せる（コマンドのパターンに改行は含められない）。
        foreach ($command in @(@($AllowedCommand) | ForEach-Object { [string]$_ -split "`r?`n" })) {
            if (-not [string]::IsNullOrWhiteSpace($command)) { $helperArguments += @('--allowed-command', $command.Trim()) }
        }
        Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
        try {
            $helperOutput = @(& $nodePath @helperArguments 2>&1)
            $helperExitCode = $LASTEXITCODE # 部品の終了コード。
        } finally {
            Pop-Location
        }
        $helperMessages = @($helperOutput | ForEach-Object { [string]$_ }) -join "`n" # 部品の出力（成功なら JSON 1つ、失敗なら理由）。
        if ($helperExitCode -ne 0) { throw "権限の変更を設定へ反映できません: $helperMessages" }
        try {
            $helperResult = $helperMessages | ConvertFrom-Json # 部品が出した結果。
            $candidateText = [System.IO.File]::ReadAllText($outputPath, [System.Text.UTF8Encoding]::new($false, $true))
        } catch {
            throw "権限の変更の結果を読めません: $($_.Exception.Message)"
        }
        return [pscustomobject]@{ Text = $candidateText; Changed = ($helperResult.changed -eq $true) }
    } finally {
        if (Test-Path -LiteralPath $workDirectory) { Remove-Item -LiteralPath $workDirectory -Recurse -Force }
    }
}

# 権限（ソースの読み取り・Claude Codeの起動・許可コマンド）の切り替えを、変更と承認を1つの操作にして行う（2.8.0）。
# 指紋なし: 変更後の公開範囲の確認結果（ShowExposure と同じ形のJSON）を出すだけで、設定も承認も書かない。
# 指紋付き: 変更後の指紋と一致するときだけ、設定を書き、実物の設定の指紋を確かめてから承認を書く。途中で失敗したら設定を元のバイト列に戻す。
function Set-ProjectPermission {
    param([string]$Root, [string]$RequestedProfile, [string]$SourceRead, [string]$ClaudeCode, [string[]]$AllowedCommand, [string]$ExpectedSha256)
    $config = Read-BridgeConfig -Root $Root # いまの公開設定（プロファイル名を決めるために読む）。
    $profileName = Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root # 承認ファイルを決めるプロファイル名。
    $candidate = New-PermissionCandidate -Root $Root -SourceRead $SourceRead -ClaudeCode $ClaudeCode -AllowedCommand $AllowedCommand # 変更後の設定の候補。
    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        Write-Output (Get-ExposureReport -Root $Root -ProfileName $profileName -CandidateText $candidate.Text)
        return
    }
    $expected = Get-BridgeExposure -Root $Root -CandidateText $candidate.Text # 変更後の公開範囲。
    if ($ExpectedSha256.Trim().ToLowerInvariant() -cne [string]$expected.sha256) { throw '-ExposureSha256 が変更後の公開範囲の指紋と一致しません。確認の結果を読み直してください。設定も承認も変えていません。' }
    $configPath = Join-Path $Root $script:ConfigName # プロジェクトの公開設定。
    $originalBytes = [System.IO.File]::ReadAllBytes($configPath) # 元のバイト列（失敗時に戻す）。
    $originalAttributes = [System.IO.File]::GetAttributes($configPath) # 元の属性（Hidden などを保つ）。
    if (($originalAttributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) { throw "bridge設定が読み取り専用です。属性を外してからやり直してください: $configPath" }
    # 置き換えが済んだあとで、元の属性（Hidden など。置き換えで新しいファイルの属性になる）へ戻す。置き換え中は Hidden を外す（Hidden のファイルは上書きで拒否されうる）。
    $replaceConfig = {
        param([string]$Content)
        [System.IO.File]::SetAttributes($configPath, [System.IO.FileAttributes]::Normal)
        try {
            Write-AtomicUtf8Text -Path $configPath -Content $Content -Label 'bridge設定'
        } finally {
            [System.IO.File]::SetAttributes($configPath, $originalAttributes)
        }
    }
    if ($candidate.Changed) { & $replaceConfig $candidate.Text }
    try {
        $applied = Get-BridgeExposure -Root $Root # 書いた実物の設定から求め直した公開範囲。
        if ([string]$applied.sha256 -cne [string]$expected.sha256) { throw '書いた設定の公開範囲の指紋が、確認した内容と一致しません。設定を元に戻しました。' }
        Save-ExposureApproval -ApprovalPath (Get-ApprovalPath -ProfileName $profileName) -Printed $applied
    } catch {
        if ($candidate.Changed) { & $replaceConfig ([System.Text.UTF8Encoding]::new($false, $true).GetString($originalBytes)) }
        throw
    }
    Write-Output "$(if ($candidate.Changed) { '設定を変更し、' } else { '設定は変わりません。' })公開範囲の承認を保存しました（指紋 $($applied.sha256)）。ハブの再起動は要りません。"
}

# 公開範囲から、ソースの読み取りの状態を求める。on = sourceText と paths が両方 true、partial = sourceText だけ true（ファイル名が無く使えない）、off = それ以外。
function Get-SourceReadState {
    param([object]$Exposure)
    $detail = if ($null -ne $Exposure.PSObject.Properties['detailExposure']) { $Exposure.detailExposure } else { $null } # 詳細取得の公開設定（全部falseなら項目ごと無い）。
    $gitExposure = if ($null -ne $Exposure.PSObject.Properties['gitExposure']) { $Exposure.gitExposure } else { $null } # Git情報の公開設定。
    $textAllowed = $detail -is [System.Management.Automation.PSCustomObject] -and $null -ne $detail.PSObject.Properties['sourceText'] -and $detail.sourceText -is [bool] -and $detail.sourceText # 本文の公開。
    $pathsAllowed = $gitExposure -is [System.Management.Automation.PSCustomObject] -and $null -ne $gitExposure.PSObject.Properties['paths'] -and $gitExposure.paths -is [bool] -and $gitExposure.paths # ファイル名の公開。
    if ($textAllowed -and $pathsAllowed) { return 'on' }
    if ($textAllowed) { return 'partial' }
    return 'off'
}

# 公開範囲から、Claude Codeの起動の状態を求める。on / off / unset（claudeCode の設定が無い）。
function Get-ClaudeCodeState {
    param([object]$Exposure)
    if ($null -eq $Exposure.PSObject.Properties['claudeCode'] -or $Exposure.claudeCode -isnot [System.Management.Automation.PSCustomObject]) { return 'unset' }
    $section = $Exposure.claudeCode # Claude Codeのジョブの設定。
    if ($null -ne $section.PSObject.Properties['enabled'] -and $section.enabled -is [bool] -and $section.enabled) { return 'on' }
    return 'off'
}

# ハブの1プロジェクトの権限の状態を、何も書き込まずに求める。1件の失敗は、そのプロジェクトの error に入れて残りを続ける。
function Get-HubPermissionEntry {
    param([object]$Entry)
    $profileName = [System.IO.Path]::GetFileNameWithoutExtension([string]$Entry.approvalFile) # ハブの承認に使うプロファイル名（approvalFile の拡張子を除いた名前）。
    $result = [ordered]@{
        name = [string]$Entry.name
        root = [string]$Entry.root
        profile = $profileName
        approvalState = 'unavailable'
        sourceRead = $null
        claudeCode = $null
        allowedCommandCount = 0
        error = $null
    } # 1プロジェクトの状態。
    try {
        $printed = Get-BridgeExposure -Root ([string]$Entry.root)
        $approval = Read-ExposureApproval -ApprovalPath ([string]$Entry.approvalFile)
        $approvedSha = Get-ApprovedSha256 -Approval $approval # 承認済みの指紋。形が不正なら空文字。
        $result.approvalState = if ($approvedSha -ne '' -and $approvedSha -ceq [string]$printed.sha256) { 'approved' } elseif ($null -ne $approval) { 'changed' } else { 'unapproved' }
        $result.sourceRead = Get-SourceReadState -Exposure $printed.exposure
        $result.claudeCode = Get-ClaudeCodeState -Exposure $printed.exposure
        if ($null -ne $printed.exposure.PSObject.Properties['claudeCode'] -and $printed.exposure.claudeCode -is [System.Management.Automation.PSCustomObject] -and $null -ne $printed.exposure.claudeCode.PSObject.Properties['allowedCommands']) {
            $result.allowedCommandCount = @($printed.exposure.claudeCode.allowedCommands).Count
        }
    } catch {
        $result.error = $_.Exception.Message
    }
    return $result
}

# ハブの全プロジェクトについて、ソースの読み取りとClaude Codeの起動の状態・承認の状態を、JSON 1つで標準出力へ出す（2.8.0）。何も書き込まない。
function Show-HubPermission {
    $hub = Read-HubConfig # 現在のハブ設定。
    $entries = @(@($hub.projects) | ForEach-Object { Get-HubPermissionEntry -Entry $_ }) # 各プロジェクトの権限の状態。
    $report = [ordered]@{ schemaVersion = 1; projects = $entries } # 出力するJSONの内容。
    Write-Output (ConvertTo-TerminalJson -Json ($report | ConvertTo-Json -Depth 6))
}

# Tunnelプロファイルの中身に、パスが1つの値として含まれるかを返す。Windowsのパスとして大文字小文字を区別せず（OrdinalIgnoreCase）、末尾の区切り文字（/）の有無は問わない。
# プロファイルは公式の tunnel-client init が書くため、--mcp-command の引用がどう保存されるか（"..."・\"...\"・'...'・引数ごとの要素）は決め打ちしない。
# U:/Proj/Foo が U:/Proj/Foo2 や U:/Proj/Foo/sub、"U:/Proj/Foo Bar" に部分一致しないよう、値の始まりと終わりを次のように確かめる。
# - 直前が引用符（" か '）のとき: 直後が同じ引用符か、\"（YAMLの二重引用符の中の退避）であること。
# - それ以外のとき: 直前が先頭・空白・[・, で、直後が末尾・空白・]・引用符・「, と空白」であること（YAMLのフロー形式 [a, b] も通す）。
function Test-ProfileContainsPath {
    param([string]$Content, [string]$CommandPath)
    $needle = $CommandPath.TrimEnd('/') # 末尾の区切り文字を除いた、探すパス。
    if ($needle.Length -eq 0) { return $false }
    $position = $Content.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) # 見つかった位置。
    while ($position -ge 0) {
        $after = $position + $needle.Length # パスの直後の位置。
        while ($after -lt $Content.Length -and $Content[$after] -ceq [char]'/') { $after++ } # 末尾の区切り文字は問わない。
        $previousCharacter = if ($position -gt 0) { $Content[$position - 1] } else { [char]' ' } # パスの直前の文字（先頭なら空白とみなす）。
        $nextCharacter = if ($after -lt $Content.Length) { $Content[$after] } else { [char]' ' } # パスの直後の文字（末尾なら空白とみなす）。
        $followingCharacter = if (($after + 1) -lt $Content.Length) { $Content[$after + 1] } else { [char]' ' } # パスの2文字後（末尾なら空白とみなす）。
        if ($previousCharacter -ceq [char]'"' -or $previousCharacter -ceq [char]"'") {
            $matched = $nextCharacter -ceq $previousCharacter -or ($previousCharacter -ceq [char]'"' -and $nextCharacter -ceq [char]'\' -and $followingCharacter -ceq [char]'"') # 引用符で始まった値が、同じ引用符か \" で終わるか。
        } else {
            $startsValue = [char]::IsWhiteSpace($previousCharacter) -or $previousCharacter -ceq [char]'[' -or $previousCharacter -ceq [char]',' # 引用符の無い値の始まりか。
            # 引用符の無い値の終わりか。直後の引用符は、値を含む外側の文字列の閉じ（"node server --project-root U:/Proj/Foo" など）。Windowsのパスは " を含められない。
            $endsValue = [char]::IsWhiteSpace($nextCharacter) -or $nextCharacter -ceq [char]']' -or $nextCharacter -ceq [char]'"' -or $nextCharacter -ceq [char]"'" -or ($nextCharacter -ceq [char]',' -and [char]::IsWhiteSpace($followingCharacter))
            $matched = $startsValue -and $endsValue
        }
        if ($matched) { return $true }
        $position = $Content.IndexOf($needle, $position + 1, [System.StringComparison]::OrdinalIgnoreCase)
    }
    return $false
}

# 既存プロファイルが同じプロジェクトとTunnelを参照し、承認ファイル付きの起動コマンドであることを確認する。
function Test-TunnelProfileBinding {
    param([string]$Root, [string]$ProfileName, [string]$ExpectedTunnelId, [switch]$Require, [switch]$AllowLegacyProfile)
    # 空のTunnel IDでは下の Contains が常に真になるため、形式を先に確かめる。
    if ($ExpectedTunnelId -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw "Tunnel IDが未設定か、形式が不正です（tunnel_ に32桁の小文字16進数が続く形式）: $(ConvertTo-DisplayQuoted -Value $ExpectedTunnelId)" }
    $profilePath = Join-Path $env:APPDATA "tunnel-client\$ProfileName.yaml"
    if (-not (Test-Path -LiteralPath $profilePath)) {
        if ($Require) { throw "Tunnelプロファイルがありません: $profilePath" }
        return $false
    }
    Assert-NotReparsePoint -Path $profilePath -Label 'Tunnelプロファイル'
    $profileItem = Get-Item -LiteralPath $profilePath -Force
    if ($profileItem.PSIsContainer) { throw "Tunnelプロファイルが通常ファイルではありません: $profilePath" }
    $content = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 # プロファイルの中身。
    if ($null -eq $content) { $content = '' } # 空のファイルは $null で返るため、空文字にする（[string] への変換では $null のまま）。
    $rootNeedle = ConvertTo-CommandPath $Root # Configure-TunnelProfile が --mcp-command に書いた形のプロジェクトルート。
    if (-not (Test-ProfileContainsPath -Content $content -CommandPath $rootNeedle) -or -not $content.Contains($ExpectedTunnelId)) {
        throw "既存Tunnelプロファイルは別ルートまたは別Tunnelを参照しています: $profilePath"
    }
    if (-not $content.Contains('--approval-file') -and -not $AllowLegacyProfile) {
        throw "既存Tunnelプロファイルは公開範囲の承認に対応していません（2.0.0で作成）。AddProjectを -ForceReconfigure 付きで実行して再生成してください: $profilePath"
    }
    return $true
}

# Tunnel Clientのプロファイルを公式initコマンドで生成する。
function Configure-TunnelProfile {
    param([string]$Root, [string]$RequestedProfile, [string]$RequestedTunnelId, [string]$ClientPath, [int]$RequestedPort, [switch]$Replace)
    if ($RequestedTunnelId -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'TunnelIdは tunnel_ に32桁の小文字16進数が続く形式です。' } # Python版の TUNNEL_PATTERN.fullmatch と同じ。
    $config = Read-BridgeConfig -Root $Root
    $profileName = Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root
    $tunnelClient = Find-TunnelClient -ExplicitPath $ClientPath
    $nodePath = Find-NodeExecutable
    $port = if ($RequestedPort -gt 0) { $RequestedPort } else { Find-FreeHealthPort }
    $profilePath = Join-Path $env:APPDATA "tunnel-client\$profileName.yaml"
    $existingTunnel = if ($null -ne $config.PSObject.Properties['tunnelId']) { [string]$config.tunnelId } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($existingTunnel) -and $existingTunnel -ne $RequestedTunnelId -and -not $Replace) {
        throw "既存設定のTunnel IDと一致しません。別Tunnelへの変更は明示的な -Force が必要です: $existingTunnel"
    }
    if (Test-Path -LiteralPath $profilePath) {
        $bindingMatches = $false
        try { $bindingMatches = Test-TunnelProfileBinding -Root $Root -ProfileName $profileName -ExpectedTunnelId $RequestedTunnelId } catch { if (-not $Replace) { throw } }
        if ($bindingMatches -and -not $Replace) {
            $config.profileName = $profileName
            $config.tunnelId = $RequestedTunnelId
            Write-BridgeConfig -Root $Root -Config $config
            Write-Host "同じTunnelプロファイルを再利用します: $profilePath"
            return
        }
    }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match "--profile\s+$([regex]::Escape($profileName))(?:\s|$)" })
    if ($running.Count -gt 0) {
        throw "Tunnel Client実行中はプロファイルを再設定できません。先に停止してください。PID: $($running.ProcessId -join ', ')"
    }
    $nodeCommandPath = ConvertTo-CommandPath $nodePath
    $serverCommandPath = ConvertTo-CommandPath $script:ServerPath
    $rootCommandPath = ConvertTo-CommandPath $Root
    $configCommandPath = ConvertTo-CommandPath (Join-Path $Root $script:ConfigName)
    $approvalCommandPath = ConvertTo-CommandPath (Get-ApprovalPath -ProfileName $profileName) # サーバーが照合するプロジェクト外の承認ファイル。
    $accessLogCommandPath = ConvertTo-CommandPath (Join-Path $env:APPDATA "chatgpt-project-bridge\access-$profileName.log") # ChatGPTからのアクセスを記録するログ。
    $mcpCommand = "`"$nodeCommandPath`" `"$serverCommandPath`" --stdio --project-root `"$rootCommandPath`" --config `"$configCommandPath`" --approval-file `"$approvalCommandPath`" --notify --access-log `"$accessLogCommandPath`""
    $initArgs = @('init', '--sample', 'sample_mcp_stdio_local', '--profile', $profileName, '--tunnel-id', $RequestedTunnelId, '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY', '--health-listen-addr', "127.0.0.1:$port", '--mcp-command', $mcpCommand)
    if ($Replace) { $initArgs += '--force' }
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        & $tunnelClient @initArgs
        if ($LASTEXITCODE -ne 0) { throw "Tunnelプロファイルの生成に失敗しました。終了コード: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $config.profileName = $profileName
    $config.tunnelId = $RequestedTunnelId
    $config.healthPort = $port
    Write-BridgeConfig -Root $Root -Config $config
    Write-Host "Tunnelプロファイルを設定しました: $profilePath"
    Write-Host "ローカル管理画面: http://127.0.0.1:$port/ui"
}

# Runtime API Keyを非表示入力で受け、明示許可のない既存キー上書きを拒否してDPAPI保存する。
function Save-RuntimeKey {
    param([string]$Root, [string]$RequestedProfile, [switch]$Replace)
    $config = Read-BridgeConfig -Root $Root
    $profileName = Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root
    $configuredTunnel = if ($null -ne $config.PSObject.Properties['tunnelId']) { [string]$config.tunnelId } else { '' }
    if ($configuredTunnel -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'Runtime API Keyを保存する前にConfigureTunnelを成功させてください。' }
    [void](Test-TunnelProfileBinding -Root $Root -ProfileName $profileName -ExpectedTunnelId $configuredTunnel -Require)
    Save-ProfileRuntimeKey -ProfileName $profileName -Replace:$Replace
}

# 指定プロファイル用のRuntime API Keyを非表示入力で受け、DPAPIで保存する。既存キーは -Replace のときだけ上書きする。
function Save-ProfileRuntimeKey {
    param([string]$ProfileName, [switch]$Replace)
    [void](Assert-ProfileName -Name $ProfileName)
    $profileName = $ProfileName # 保存先を決めるプロファイル名。
    $keyDirectory = Join-Path $env:APPDATA 'tunnel-client'
    [System.IO.Directory]::CreateDirectory($keyDirectory) | Out-Null
    Assert-NotReparsePoint -Path $keyDirectory -Label 'キー保存フォルダー'
    $keyPath = Join-Path $keyDirectory "$profileName.key.dpapi"
    Assert-NotReparsePoint -Path $keyPath -Label '既存Runtime API Key'
    if ((Test-Path -LiteralPath $keyPath) -and -not $Replace) { throw "Runtime API Keyは既にあります。置き換える場合だけ -ReplaceKey を指定してください: $keyPath" }
    $secureKey = Read-Host 'Runtime API Key（入力内容は表示されません）' -AsSecureString
    $credential = [pscredential]::new('tunnel-client', $secureKey)
    $plainKey = $credential.GetNetworkCredential().Password
    try {
        if ($plainKey.Length -lt 20) { throw '入力されたキーが短すぎます。Runtime API Keyを確認してください。' }
        Write-Utf8Text -Path $keyPath -Content (ConvertFrom-SecureString $secureKey)
        Write-Host "暗号化キーを保存しました: $keyPath"
        Write-Host 'このファイルは別PCや別Windowsユーザーへコピーせず、移行先で再入力してください。'
    } finally {
        $plainKey = $null
        $credential = $null
        $secureKey = $null
    }
}

# ローカル管理画面の詳細状態を秘密値なしで要約する。
function Show-BridgeStatus {
    param([string]$Root)
    $config = Read-BridgeConfig -Root $Root
    if ($null -eq $config.PSObject.Properties['healthPort'] -or $null -eq $config.healthPort) {
        throw 'healthPortが未設定です。先に -Action ConfigureTunnel を実行してください。'
    }
    Show-ProfileStatus -ProfileName ([string]$config.profileName) -TunnelId ([string]$config.tunnelId) -Port ([int]$config.healthPort)
}

# 指定プロファイルのローカル管理画面から、秘密値なしの状態を要約して表示する。
function Show-ProfileStatus {
    param([string]$ProfileName, [string]$TunnelId, [int]$Port)
    $port = $Port # 管理画面のポート。
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health?details=true" -TimeoutSec 5
    } catch {
        throw "Tunnel Clientは停止中、または管理画面へ接続できません: http://127.0.0.1:$port/ui"
    }
    [pscustomobject]@{
        Profile = $ProfileName
        TunnelId = $TunnelId
        Live = $health.live
        Ready = $health.ready
        ControlPlane = $health.components.'control-plane'.state
        MCP = $health.components.mcp.state
        Completed = $health.components.dispatcher.details.completed
        Failures = $health.components.dispatcher.details.failures
        ResponseCompleted = $health.components.'response-delivery'.details.completed
        ResponseFailures = $health.components.'response-delivery'.details.terminal_failures
        AdminUI = "http://127.0.0.1:$port/ui"
    } | Format-List
}

# 正確なクラウド設定URLを表示し、許可時だけ既定browserで開く。
function Show-CloudUrl {
    param([string]$Label, [string]$Url, [switch]$SkipBrowser)
    Write-Host "${Label}: $Url"
    if (-not $SkipBrowser) { Start-Process $Url }
}

# パスがネットワーク共有（UNC、または割り当て済みのネットワークドライブ）の上にあるかを返す。判定できないときは $false を返す。
function Test-NetworkSharePath {
    param([string]$Path)
    if ($Path.StartsWith('\\', [System.StringComparison]::Ordinal)) { return $true } # UNC（\\server\share\...）。
    try {
        $driveRoot = [System.IO.Path]::GetPathRoot($Path) # ドライブのルート（例: U:\）。
        if ([string]::IsNullOrEmpty($driveRoot)) { return $false }
        return [System.IO.DriveInfo]::new($driveRoot).DriveType -eq [System.IO.DriveType]::Network
    } catch {
        return $false
    }
}

# プロジェクトがネットワーク共有の上にあれば、リンクの検査が効かないことを1行で警告する（公開は止めない）。ShowExposure（JSONだけを出す経路）では呼ばない。
# Samba などは共有元のシンボリックリンクを辿って通常のファイルに見せるため、このPCからはリンクを検出できない（コードでは防げない制約）。
function Show-NetworkShareWarning {
    param([string]$Root)
    if (Test-NetworkSharePath -Path $Root) {
        Write-Host '警告: プロジェクトはネットワーク共有上にあります。共有元のシンボリックリンクはこのPCから検出できないため、共有元で follow symlinks = no にするか、共有元のPCでbridgeを動かしてください。'
    }
}

# 保存済みプロファイルを公式doctorで検証し、公開範囲の承認状態も表示する。
function Invoke-BridgeDoctor {
    param([string]$Root, [string]$RequestedProfile, [string]$ClientPath)
    $config = Read-BridgeConfig -Root $Root
    $profileName = Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root
    $configuredTunnel = if ($null -ne $config.PSObject.Properties['tunnelId']) { [string]$config.tunnelId } else { '' } # 設定に記録されたTunnel ID。
    if ($configuredTunnel -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'Doctorの前に -Action ConfigureTunnel で同じプロジェクトとTunnelのプロファイルを設定してください（設定の tunnelId が未設定か、形式が不正です）。' }
    [void](Test-TunnelProfileBinding -Root $Root -ProfileName $profileName -ExpectedTunnelId $configuredTunnel -Require)
    Show-NetworkShareWarning -Root $Root
    if (-not (Confirm-BridgeExposure -Root $Root -ProfileName $profileName -NoPrompt)) {
        Write-Host '警告: 公開範囲が未承認です。承認されるまでChatGPTからのツール呼び出しは拒否されます。Start時に承認を求めます。'
    }
    $tunnelClient = Find-TunnelClient -ExplicitPath $ClientPath
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        Invoke-WithRuntimeKey -ProfileName $profileName -Operation {
            & $tunnelClient doctor --profile $profileName --explain
            if ($LASTEXITCODE -ne 0) { throw "doctorに失敗しました。終了コード: $LASTEXITCODE" }
        }
    } finally {
        Pop-Location
    }
}

# 公開範囲の承認を確かめてから、同一プロファイルの重複起動を避けてTunnel Clientをforegroundで実行する。
function Start-BridgeTunnel {
    param([string]$Root, [string]$RequestedProfile, [string]$ClientPath, [string]$ExpectedSha256)
    $config = Read-BridgeConfig -Root $Root
    $profileName = Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root
    $configuredTunnel = if ($null -ne $config.PSObject.Properties['tunnelId']) { [string]$config.tunnelId } else { '' } # 設定に記録されたTunnel ID。
    if ($configuredTunnel -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'Startの前に -Action ConfigureTunnel で同じプロジェクトとTunnelのプロファイルを設定してください（設定の tunnelId が未設定か、形式が不正です）。' }
    [void](Test-TunnelProfileBinding -Root $Root -ProfileName $profileName -ExpectedTunnelId $configuredTunnel -Require)
    [void](Confirm-BridgeExposure -Root $Root -ProfileName $profileName -ExpectedSha256 $ExpectedSha256)
    Start-ProfileTunnel -ProfileName $profileName -ClientPath $ClientPath -TunnelId $configuredTunnel -Port ([int]$config.healthPort)
}

# 指定プロファイルのTunnel Clientを、同一プロファイルの重複起動を避けてforegroundで実行する。
function Start-ProfileTunnel {
    param([string]$ProfileName, [string]$ClientPath, [string]$TunnelId, [int]$Port)
    $profileName = $ProfileName # 起動するプロファイル名。
    $tunnelClient = Find-TunnelClient -ExplicitPath $ClientPath
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match "--profile\s+$([regex]::Escape($profileName))(?:\s|$)" })
    if ($existing.Count -gt 0) {
        Write-Host "同じプロファイルは既に起動中です。PID: $($existing.ProcessId -join ', ')"
        Show-ProfileStatus -ProfileName $profileName -TunnelId $TunnelId -Port $Port
        return
    }
    $runtimeDirectory = Join-Path $env:APPDATA 'tunnel-client\runtime'
    [System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $pidPath = Join-Path $runtimeDirectory "$profileName.pid"
    $logPath = Join-Path $runtimeDirectory "$profileName.log"
    Write-Host "Tunnel Clientを開始します。終了はCtrl+Cです。ログ: $logPath"
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        Invoke-WithRuntimeKey -ProfileName $profileName -Operation {
            & $tunnelClient run --profile $profileName --pid.file $pidPath --log.file $logPath
            if ($LASTEXITCODE -ne 0) { throw "Tunnel Clientが異常終了しました。終了コード: $LASTEXITCODE" }
        }
    } finally {
        Pop-Location
    }
}

# 初回・再開の状態を判定し、公開範囲の承認後に設定、鍵、doctor、foreground起動を順番に行う。
function Add-ChatGptProject {
    param(
        [string]$Root,
        [string]$Name,
        [string]$RequestedProfile,
        [string]$RequestedTunnelId,
        [string]$ClientPath,
        [switch]$SkipBrowser,
        [switch]$SkipStart,
        [switch]$Reconfigure,
        [switch]$ReplaceExistingKey,
        [string]$ExpectedSha256
    )
    $configPath = Join-Path $Root $script:ConfigName
    $existingConfig = Test-Path -LiteralPath $configPath
    $config = if ($existingConfig) { Read-BridgeConfig -Root $Root } else { $null }
    $resolvedName = if (-not [string]::IsNullOrWhiteSpace($Name)) { $Name } elseif ($null -ne $config) { [string]$config.projectName } else { Split-Path $Root -Leaf }
    Show-CloudUrl -Label 'Tunnel作成・管理' -Url $script:TunnelsUrl -SkipBrowser:$SkipBrowser
    $resolvedTunnelId = $RequestedTunnelId
    if ([string]::IsNullOrWhiteSpace($resolvedTunnelId)) { $resolvedTunnelId = Read-Host 'Tunnel ID (tunnel_...)' }
    if ($resolvedTunnelId -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'Tunnel IDは tunnel_ に32桁の小文字16進数が続く形式です。' }
    if ($null -ne $config -and -not [string]::IsNullOrWhiteSpace([string]$config.tunnelId) -and [string]$config.tunnelId -ne $resolvedTunnelId) {
        throw "既存設定のTunnel IDと一致しません。別プロジェクト用Tunnelとして扱ってください: $($config.tunnelId)"
    }
    $profileName = if ($null -ne $config) { Resolve-ProfileName -Config $config -ExplicitProfile $RequestedProfile -Root $Root } elseif (-not [string]::IsNullOrWhiteSpace($RequestedProfile)) { Assert-ProfileName -Name $RequestedProfile } else { New-ProfileName -Name $resolvedName -Root $Root }
    $profileExists = Test-Path -LiteralPath (Join-Path $env:APPDATA "tunnel-client\$profileName.yaml")
    if ($profileExists) { [void](Test-TunnelProfileBinding -Root $Root -ProfileName $profileName -ExpectedTunnelId $resolvedTunnelId -Require -AllowLegacyProfile:$Reconfigure) }

    $createdScaffold = $false # このActionでbridge設定と文書を新規作成したか。
    if ($null -eq $config) {
        Initialize-ProjectBridge -Root $Root -Name $resolvedName -Replace:$false
        $createdScaffold = $true
        $config = Read-BridgeConfig -Root $Root
    }
    Test-ProjectBridge -Root $Root
    Write-Host "解決済みプロジェクトルート: $Root"
    Show-NetworkShareWarning -Root $Root
    try {
        [void](Confirm-BridgeExposure -Root $Root -ProfileName $profileName -ExpectedSha256 $ExpectedSha256)
    } catch {
        if ($createdScaffold) { Write-Host "作成したbridge設定と文書は公開されていません。不要なら削除してください: $(Join-Path $Root $script:ConfigName)" }
        throw
    }
    if (-not $profileExists -or $Reconfigure -or [string]::IsNullOrWhiteSpace([string]$config.tunnelId)) {
        Configure-TunnelProfile -Root $Root -RequestedProfile $profileName -RequestedTunnelId $resolvedTunnelId -ClientPath $ClientPath -RequestedPort 0 -Replace:$Reconfigure
    } else {
        Write-Host "同じTunnelプロファイルを再利用します: $(Join-Path $env:APPDATA "tunnel-client\$profileName.yaml")"
    }

    $keyPath = Join-Path $env:APPDATA "tunnel-client\$profileName.key.dpapi"
    Assert-NotReparsePoint -Path $keyPath -Label '既存Runtime API Key'
    $keyExists = Test-Path -LiteralPath $keyPath -PathType Leaf
    if ($ReplaceExistingKey -or -not $keyExists) {
        Show-CloudUrl -Label 'Runtime API Key' -Url $script:ApiKeysUrl -SkipBrowser:$SkipBrowser
        Save-RuntimeKey -Root $Root -RequestedProfile $profileName -Replace:$ReplaceExistingKey
    } else {
        Write-Host "既存Runtime API Keyを存在確認だけで再利用します: $keyPath"
    }
    Invoke-BridgeDoctor -Root $Root -RequestedProfile $profileName -ClientPath $ClientPath
    Show-CloudUrl -Label 'ChatGPT Plugins' -Url $script:PluginsUrl -SkipBrowser:$SkipBrowser
    if ($SkipStart) { Write-Host 'Tunnel Clientのforeground起動は -NoStart により省略しました。'; return }
    Start-BridgeTunnel -Root $Root -RequestedProfile $profileName -ClientPath $ClientPath -ExpectedSha256 $ExpectedSha256
}

# ---------------------------------------------------------------------------
# ハブ方式: PCごとに1つのTunnel・App・Runtime API Keyで、複数プロジェクトを公開する。
# ハブ設定は %APPDATA%\chatgpt-project-bridge\hub.json（プロジェクトの外）に置く。
# ---------------------------------------------------------------------------

# ハブ設定ファイルのパスを返す。
function Get-HubPath {
    return Join-Path $env:APPDATA 'chatgpt-project-bridge\hub.json'
}

# このPCのハブ用Tunnelプロファイル名を、ハブ設定のパスから決める。
function Get-HubProfileName {
    $hashBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes((Get-HubPath).ToLowerInvariant())) # パスのハッシュ。
    return 'chatgpt-hub-' + [System.Convert]::ToHexString($hashBytes).Substring(0, 8).ToLowerInvariant()
}

# ハブ設定を読む。無ければ空のハブを返す。形式が不正なら止める。
function Read-HubConfig {
    $hubPath = Get-HubPath # ハブ設定ファイル。
    Assert-NotReparsePoint -Path $hubPath -Label 'ハブ設定'
    $defaultNotifications = [pscustomobject]@{ start = $true; access = $true; intervalSeconds = 60 } # 既定の通知設定（起動時とアクセス時に通知、同じプロジェクトは60秒に1回まで）。
    $defaultAccessLog = Join-Path $env:APPDATA 'chatgpt-project-bridge\access.log' # 既定のアクセスログ。
    if (-not (Test-Path -LiteralPath $hubPath -PathType Leaf)) {
        return [pscustomobject]@{ schemaVersion = 1; profileName = (Get-HubProfileName); tunnelId = $null; healthPort = $null; notifications = $defaultNotifications; accessLog = $defaultAccessLog; projects = @() }
    }
    $hub = Get-Content -LiteralPath $hubPath -Raw -Encoding UTF8 | ConvertFrom-Json
    # 最上位がオブジェクトでない（null・配列）ときと、schemaVersion が数でない（"abc" など）ときも、型変換の例外ではなく同じ文で止める。
    if ($hub -isnot [System.Management.Automation.PSCustomObject] -or $null -eq $hub.PSObject.Properties['schemaVersion'] -or [string]$hub.schemaVersion -cne '1' -or $null -eq $hub.PSObject.Properties['projects']) { throw "ハブ設定の形式が不正です: $hubPath" }
    if ($null -eq $hub.projects) { $hub.projects = @() }
    foreach ($entry in @($hub.projects)) {
        foreach ($key in @('name', 'root', 'approvalFile')) {
            # 項目の有無は PSObject.Properties[名前] で確かめる（{} に .PSObject.Properties.Name を読むと StrictMode で例外になる）。
            if ($entry -isnot [System.Management.Automation.PSCustomObject] -or $null -eq $entry.PSObject.Properties[$key] -or $entry.$key -isnot [string]) { throw "ハブ設定の登録プロジェクトの形式が不正です（name・root・approvalFile が文字列ではありません）: $hubPath" }
        }
    }
    # 2.2.1 以前のハブ設定には通知とアクセスログの項目が無いので、既定値を補う。
    if ($null -eq $hub.PSObject.Properties['notifications'] -or $null -eq $hub.notifications) { $hub | Add-Member -NotePropertyName notifications -NotePropertyValue $defaultNotifications -Force }
    if ($null -eq $hub.PSObject.Properties['accessLog'] -or [string]::IsNullOrWhiteSpace([string]$hub.accessLog)) { $hub | Add-Member -NotePropertyName accessLog -NotePropertyValue $defaultAccessLog -Force }
    # 手で書いたハブ設定などで項目が欠けていても止まらないよう、ハブ設定が無いときと同じ既定値を補う（StrictMode では無い項目の読み書きが例外になる）。
    if ($null -eq $hub.PSObject.Properties['profileName'] -or [string]::IsNullOrWhiteSpace([string]$hub.profileName)) { $hub | Add-Member -NotePropertyName profileName -NotePropertyValue (Get-HubProfileName) -Force }
    foreach ($optionalKey in @('tunnelId', 'healthPort')) {
        if ($null -eq $hub.PSObject.Properties[$optionalKey]) { $hub | Add-Member -NotePropertyName $optionalKey -NotePropertyValue $null }
    }
    return $hub
}

# ハブ設定を原子的に保存する。
function Write-HubConfig {
    param([object]$Hub)
    $hubPath = Get-HubPath # ハブ設定ファイル。
    $hubDirectory = Split-Path $hubPath -Parent # ハブ設定の保存フォルダー。
    [System.IO.Directory]::CreateDirectory($hubDirectory) | Out-Null
    Assert-NotReparsePoint -Path $hubDirectory -Label 'ハブ設定の保存フォルダー'
    Assert-NotReparsePoint -Path $hubPath -Label 'ハブ設定'
    $record = [ordered]@{
        schemaVersion = 1
        profileName = [string]$Hub.profileName
        tunnelId = $Hub.tunnelId
        healthPort = $Hub.healthPort
        notifications = $Hub.notifications
        accessLog = [string]$Hub.accessLog
        projects = @($Hub.projects | ForEach-Object { [ordered]@{ name = [string]$_.name; root = [string]$_.root; approvalFile = [string]$_.approvalFile } })
    } # 保存するハブ設定。
    $temporary = "$hubPath.$([guid]::NewGuid().ToString('N')).tmp" # 原子的に置き換えるための一時ファイル。
    try {
        Write-Utf8Text -Path $temporary -Content ((($record | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n")
        Move-Item -LiteralPath $temporary -Destination $hubPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

# プロジェクト名から、ハブ内で使う名前（英数字と . _ -）を作る。
function New-HubProjectName {
    param([string]$Name)
    $slug = ($Name -replace '[^A-Za-z0-9._-]+', '-').Trim('-', '.', '_') # 使えない文字を置き換えた名前。
    if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'project' }
    if ($slug.Length -gt 63) { $slug = $slug.Substring(0, 63).TrimEnd('-', '.', '_') }
    return $slug
}

# 2つのプロジェクトルートが同じフォルダーかを返す。Windowsのパスとして大文字小文字だけを無視して（OrdinalIgnoreCase）比べ、末尾の \ は問わない。
# -eq / -ne と ToLowerInvariant はカルチャ依存の比較や小文字化で、NFC/NFD・ゼロ幅文字・ケルビン記号（U+212A）だけ違う別のパスを同じとみなしうるため使わない。
function Test-SameProjectRoot {
    param([string]$Left, [string]$Right)
    return [string]::Equals([System.IO.Path]::GetFullPath($Left).TrimEnd('\'), [System.IO.Path]::GetFullPath($Right).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
}

# ハブ用プロファイルが、このPCのハブ設定と指定Tunnelを参照していることを確かめる。
function Test-HubProfileBinding {
    param([string]$ProfileName, [string]$ExpectedTunnelId, [switch]$Require)
    # 空や途中までのTunnel IDでは下の Contains が真になりうるため、形式を先に確かめる（Python版の hub-doctor / hub-start と同じ）。
    if ($ExpectedTunnelId -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw "ハブのTunnel IDが未設定か、形式が不正です（tunnel_ に32桁の小文字16進数が続く形式）: $(ConvertTo-DisplayQuoted -Value $ExpectedTunnelId)" }
    $profilePath = Join-Path $env:APPDATA "tunnel-client\$ProfileName.yaml" # ハブ用プロファイル。
    if (-not (Test-Path -LiteralPath $profilePath)) {
        if ($Require) { throw "ハブ用Tunnelプロファイルがありません。先に HubAdd を実行してください: $profilePath" }
        return $false
    }
    Assert-NotReparsePoint -Path $profilePath -Label 'ハブ用Tunnelプロファイル'
    $content = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 # プロファイルの中身。
    if ($null -eq $content) { $content = '' } # 空のファイルは $null で返るため、空文字にする。
    # ハブ設定のパスは Test-TunnelProfileBinding と同じ規則で探す（大文字小文字を区別せず、hub.json.bak のような別のパスへの部分一致は通さない）。
    if (-not $content.Contains('--hub') -or -not (Test-ProfileContainsPath -Content $content -CommandPath (ConvertTo-CommandPath (Get-HubPath))) -or -not $content.Contains($ExpectedTunnelId)) {
        throw "既存のハブ用Tunnelプロファイルは、このPCのハブ設定または指定Tunnelを参照していません: $profilePath"
    }
    return $true
}

# ハブ用Tunnelプロファイルを公式initで生成し、ハブ設定にTunnel IDと管理ポートを記録する。
function Initialize-HubTunnelProfile {
    param([object]$Hub, [string]$TunnelId, [string]$ClientPath, [switch]$Replace)
    $profileName = [string]$Hub.profileName # ハブ用プロファイル名。
    $tunnelClient = Find-TunnelClient -ExplicitPath $ClientPath
    $nodePath = Find-NodeExecutable
    $port = Find-FreeHealthPort # ハブの管理画面ポート。
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match "--profile\s+$([regex]::Escape($profileName))(?:\s|$)" })
    if ($running.Count -gt 0) { throw "ハブのTunnel Client実行中はプロファイルを再設定できません。先に停止してください。PID: $($running.ProcessId -join ', ')" }
    $mcpCommand = "`"$(ConvertTo-CommandPath $nodePath)`" `"$(ConvertTo-CommandPath $script:ServerPath)`" --stdio --hub `"$(ConvertTo-CommandPath (Get-HubPath))`"" # ハブモードのMCP起動コマンド。
    $initArgs = @('init', '--sample', 'sample_mcp_stdio_local', '--profile', $profileName, '--tunnel-id', $TunnelId, '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY', '--health-listen-addr', "127.0.0.1:$port", '--mcp-command', $mcpCommand)
    if ($Replace) { $initArgs += '--force' }
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        & $tunnelClient @initArgs
        if ($LASTEXITCODE -ne 0) { throw "ハブ用Tunnelプロファイルの生成に失敗しました。終了コード: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $Hub.tunnelId = $TunnelId
    $Hub.healthPort = $port
    Write-HubConfig -Hub $Hub
    Write-Host "ハブ用Tunnelプロファイルを設定しました: $(Join-Path $env:APPDATA "tunnel-client\$profileName.yaml")"
    Write-Host "ローカル管理画面: http://127.0.0.1:$port/ui"
}

# ハブ内の各プロジェクトについて、名前・ルート・承認状態を返す。値は端末へそのまま出せる形（制御文字を退避済み）にする。
# 1つのプロジェクトで例外が起きても、そのプロジェクトを「使用不可」にして残りを続ける。
function Get-HubProjectState {
    param([object]$Hub)
    foreach ($entry in @($Hub.projects)) {
        $state = '承認済み' # 表示する承認状態。
        try {
            $printed = Get-BridgeExposure -Root ([string]$entry.root)
            $approval = Read-ExposureApproval -ApprovalPath ([string]$entry.approvalFile)
            $approvedSha = Get-ApprovedSha256 -Approval $approval # 承認済みの指紋。形が不正なら空文字。
            if ($approvedSha -eq '' -or $approvedSha -cne [string]$printed.sha256) { $state = '未承認（設定が変わったか、まだ承認していない）' }
        } catch {
            $state = "使用不可（$(ConvertTo-EscapedDisplayText -Value $_.Exception.Message)）"
        }
        [pscustomobject]@{ Name = (ConvertTo-EscapedDisplayText -Value ([string]$entry.name)); State = $state; Root = (ConvertTo-DisplayQuoted -Value ([string]$entry.root)) }
    }
}

<#
  プロジェクトをハブへ追加する。初回だけTunnelプロファイル・キー・doctor・起動まで行う。
  順序: scaffold → 自己試験 → 公開範囲の承認 → ハブ設定へ追加 →（初回）Tunnel・キー・doctor・起動。
  承認を得るまでTunnelプロファイルやキーは変更しない。
#>
function Add-HubProject {
    param(
        [string]$Root,
        [string]$Name,
        [string]$HubProjectName,
        [string]$RequestedTunnelId,
        [string]$ClientPath,
        [switch]$SkipBrowser,
        [switch]$SkipStart,
        [switch]$Reconfigure,
        [switch]$ReplaceExistingKey,
        [string]$ExpectedSha256
    )
    $hub = Read-HubConfig # 現在のハブ設定。
    $hubTunnel = if ($null -ne $hub.tunnelId) { [string]$hub.tunnelId } else { '' } # ハブに記録済みのTunnel ID。
    $resolvedTunnelId = $RequestedTunnelId # このActionで使うTunnel ID。
    if ([string]::IsNullOrWhiteSpace($hubTunnel)) {
        Show-CloudUrl -Label 'Tunnel作成・管理（このPCのハブ用に1つ作成）' -Url $script:TunnelsUrl -SkipBrowser:$SkipBrowser
        if ([string]::IsNullOrWhiteSpace($resolvedTunnelId)) { $resolvedTunnelId = Read-Host 'Tunnel ID (tunnel_...)' }
    } else {
        if (-not [string]::IsNullOrWhiteSpace($resolvedTunnelId) -and $resolvedTunnelId -ne $hubTunnel) { throw "このPCのハブは別のTunnelを使っています: $hubTunnel" }
        $resolvedTunnelId = $hubTunnel
    }
    if ($resolvedTunnelId -cnotmatch '^tunnel_[0-9a-f]{32}\z') { throw 'Tunnel IDは tunnel_ に32桁の小文字16進数が続く形式です。' }
    $profileName = [string]$hub.profileName # ハブ用プロファイル名。
    $profileExists = Test-Path -LiteralPath (Join-Path $env:APPDATA "tunnel-client\$profileName.yaml") # ハブ用プロファイルの有無。
    if ($profileExists -and -not $Reconfigure) { [void](Test-HubProfileBinding -ProfileName $profileName -ExpectedTunnelId $resolvedTunnelId -Require) }

    $configPath = Join-Path $Root $script:ConfigName # プロジェクトの公開設定。
    $createdScaffold = $false # このActionで scaffold を作ったか。
    if (-not (Test-Path -LiteralPath $configPath)) {
        Initialize-ProjectBridge -Root $Root -Name $(if ([string]::IsNullOrWhiteSpace($Name)) { Split-Path $Root -Leaf } else { $Name }) -Replace:$false
        $createdScaffold = $true
    }
    $config = Read-BridgeConfig -Root $Root
    if ($null -ne $config.PSObject.Properties['tunnelId'] -and -not [string]::IsNullOrWhiteSpace([string]$config.tunnelId)) {
        Write-Host "注意: このプロジェクトには従来方式のTunnel（$(ConvertTo-EscapedDisplayText -Value $config.tunnelId)）も設定されています。同じプロジェクトを従来方式とハブ方式で同時に起動しないでください。"
    }
    $projectProfile = Resolve-ProfileName -Config $config -ExplicitProfile '' -Root $Root # 承認ファイルを決めるプロジェクトのプロファイル名。
    Test-ProjectBridge -Root $Root
    Write-Host "解決済みプロジェクトルート: $Root"
    Show-NetworkShareWarning -Root $Root
    try {
        [void](Confirm-BridgeExposure -Root $Root -ProfileName $projectProfile -ExpectedSha256 $ExpectedSha256)
    } catch {
        if ($createdScaffold) { Write-Host "作成したbridge設定と文書は公開されていません。不要なら削除してください: $configPath" }
        throw
    }

    $existingEntry = @($hub.projects | Where-Object { Test-SameProjectRoot -Left ([string]$_.root) -Right $Root }) # 既に登録済みの同じルート。
    $entryName = if ($existingEntry.Count -gt 0) { [string]$existingEntry[0].name } elseif (-not [string]::IsNullOrWhiteSpace($HubProjectName)) { $HubProjectName } else { New-HubProjectName -Name ([string]$config.projectName) } # ハブ内の名前。
    if ($entryName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\z') { throw "ハブ内の名前は英数字で始まり、英数字と . _ - の63文字以内です: $entryName" } # Python版の HUB_NAME_PATTERN.fullmatch と同じ。
    $nameClash = @($hub.projects | Where-Object { [string]::Equals([string]$_.name, $entryName, [System.StringComparison]::OrdinalIgnoreCase) -and -not (Test-SameProjectRoot -Left ([string]$_.root) -Right $Root) }) # 同じ名前の別プロジェクト。
    if ($nameClash.Count -gt 0) { throw "ハブには同じ名前の別プロジェクトがあります: $entryName（-HubName で別の名前を指定してください）" }
    $entry = [pscustomobject]@{ name = $entryName; root = $Root; approvalFile = (Get-ApprovalPath -ProfileName $projectProfile) } # 登録内容。
    $hub.projects = @(@($hub.projects | Where-Object { -not (Test-SameProjectRoot -Left ([string]$_.root) -Right $Root) }) + $entry)
    Write-HubConfig -Hub $hub
    Write-Host "ハブに登録しました: $entryName（$Root）"

    $needProfile = (-not $profileExists) -or $Reconfigure -or [string]::IsNullOrWhiteSpace($hubTunnel) # ハブ用プロファイルの生成が必要か。
    $keyPath = Join-Path $env:APPDATA "tunnel-client\$profileName.key.dpapi" # ハブ用Runtime API Key。
    Assert-NotReparsePoint -Path $keyPath -Label '既存Runtime API Key'
    $keyExists = Test-Path -LiteralPath $keyPath -PathType Leaf # キーが保存済みか。
    if (-not $needProfile -and $keyExists -and -not $ReplaceExistingKey) {
        Write-Host 'このPCのハブは設定済みです。起動中のハブには再起動なしで反映されます。ChatGPTでは list_projects で確認できます。'
        return
    }
    if ($needProfile) {
        Initialize-HubTunnelProfile -Hub $hub -TunnelId $resolvedTunnelId -ClientPath $ClientPath -Replace:($Reconfigure -and $profileExists)
    } else {
        Write-Host 'ハブ用プロファイルは設定済みですが、Runtime API Keyが保存されていません。キーの入力から続けます。'
    }
    if ($ReplaceExistingKey -or -not $keyExists) {
        Show-CloudUrl -Label 'Runtime API Key（このPC用に1つ作成）' -Url $script:ApiKeysUrl -SkipBrowser:$SkipBrowser
        Save-ProfileRuntimeKey -ProfileName $profileName -Replace:$ReplaceExistingKey
    } else {
        Write-Host "既存Runtime API Keyを存在確認だけで再利用します: $keyPath"
    }
    Invoke-HubDoctor -ClientPath $ClientPath
    Show-CloudUrl -Label 'ChatGPT Plugins（このPCのハブ用にAppを1つ作成）' -Url $script:PluginsUrl -SkipBrowser:$SkipBrowser
    if ($SkipStart) { Write-Host 'ハブのforeground起動は -NoStart により省略しました。'; return }
    Start-HubTunnel -ClientPath $ClientPath
}

# ハブから指定プロジェクトを外す。プロジェクトのファイルと承認ファイルには触れない。
function Remove-HubProject {
    param([string]$Root, [string]$HubProjectName)
    $hub = Read-HubConfig # 現在のハブ設定。
    $before = @($hub.projects).Count # 削除前の件数。
    if (-not [string]::IsNullOrWhiteSpace($HubProjectName)) {
        $hub.projects = @($hub.projects | Where-Object { -not [string]::Equals([string]$_.name, $HubProjectName, [System.StringComparison]::OrdinalIgnoreCase) })
    } else {
        $hub.projects = @($hub.projects | Where-Object { -not (Test-SameProjectRoot -Left ([string]$_.root) -Right $Root) })
    }
    if (@($hub.projects).Count -eq $before) { throw 'ハブに該当するプロジェクトがありません。HubList で確認してください。' }
    Write-HubConfig -Hub $hub
    Write-Host 'ハブから外しました。起動中のハブにも再起動なしで反映されます。プロジェクトのファイルと承認ファイルは残しています。'
}

# ハブの設定と、登録プロジェクトの承認状態を表示する。
function Show-HubList {
    $hub = Read-HubConfig # 現在のハブ設定。
    Write-Host "ハブ設定: $(Get-HubPath)"
    Write-Host "プロファイル: $(ConvertTo-EscapedDisplayText -Value $hub.profileName)  Tunnel: $(if ($hub.tunnelId) { ConvertTo-EscapedDisplayText -Value $hub.tunnelId } else { '未設定' })"
    $states = @(Get-HubProjectState -Hub $hub) # 各プロジェクトの状態。
    if ($states.Count -eq 0) { Write-Host '登録プロジェクト: なし（HubAdd で追加します）'; return }
    $states | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

# ハブ用プロファイルを公式doctorで検証し、各プロジェクトの承認状態も表示する。
function Invoke-HubDoctor {
    param([string]$ClientPath)
    $hub = Read-HubConfig # 現在のハブ設定。
    if ([string]::IsNullOrWhiteSpace([string]$hub.tunnelId)) { throw 'ハブのTunnelが未設定です。先に HubAdd を実行してください。' }
    $profileName = [string]$hub.profileName # ハブ用プロファイル名。
    [void](Test-HubProfileBinding -ProfileName $profileName -ExpectedTunnelId ([string]$hub.tunnelId) -Require)
    foreach ($state in @(Get-HubProjectState -Hub $hub)) { Write-Host "  $($state.Name): $($state.State)" }
    Show-HubAutoStartState
    $tunnelClient = Find-TunnelClient -ExplicitPath $ClientPath
    Push-Location -LiteralPath $script:SkillRoot # 作業フォルダーをプロジェクトの外にする（Find-NodeExecutable と同じ理由）。
    try {
        Invoke-WithRuntimeKey -ProfileName $profileName -Operation {
            & $tunnelClient doctor --profile $profileName --explain
            if ($LASTEXITCODE -ne 0) { throw "doctorに失敗しました。終了コード: $LASTEXITCODE" }
        }
    } finally {
        Pop-Location
    }
}

# 全プロジェクトの公開範囲の承認を確かめてから、ハブのTunnel Clientをforegroundで起動する。
# -Service（自動起動用）のときは入力を求めず、未承認のプロジェクトは公開しないまま起動する。
function Start-HubTunnel {
    param([string]$ClientPath, [switch]$Service)
    $hub = Read-HubConfig # 現在のハブ設定。
    if ([string]::IsNullOrWhiteSpace([string]$hub.tunnelId)) { throw 'ハブのTunnelが未設定です。先に HubAdd を実行してください。' }
    $profileName = [string]$hub.profileName # ハブ用プロファイル名。
    [void](Test-HubProfileBinding -ProfileName $profileName -ExpectedTunnelId ([string]$hub.tunnelId) -Require)
    Write-HubConfig -Hub $hub # 2.2.1 以前のハブ設定へ、通知とアクセスログの既定値を書き足す。
    foreach ($entry in @($hub.projects)) {
        $displayName = ConvertTo-EscapedDisplayText -Value ([string]$entry.name) # 端末へ出すハブ内の名前。
        Write-Host "--- $displayName（$(ConvertTo-DisplayQuoted -Value ([string]$entry.root))）"
        # 対話の起動では止める（承認の拒否を含む）。自動起動では、例外の種類によらず、このプロジェクトだけを公開せずに残りとハブを起動する。
        try {
            $approvalName = [System.IO.Path]::GetFileNameWithoutExtension([string]$entry.approvalFile) # 承認ファイルを決めるプロジェクトのプロファイル名。
            $approved = Confirm-BridgeExposure -Root ([string]$entry.root) -ProfileName $approvalName -NoPrompt:$Service # 承認済みか。
            if (-not $approved) { Write-Host "警告: $displayName は未承認のため公開しません。Approve で承認すると、再起動なしで公開されます。" }
        } catch {
            if (-not $Service) { throw }
            Write-Host "警告: $displayName を確認できないため公開しません: $(ConvertTo-EscapedDisplayText -Value $_.Exception.Message)"
        }
    }
    Start-ProfileTunnel -ProfileName $profileName -ClientPath $ClientPath -TunnelId ([string]$hub.tunnelId) -Port ([int]$hub.healthPort)
}

# 動いているハブのTunnel Clientを止め、止まったことを確かめる。動いていなければ $false を返す。
function Stop-HubTunnel {
    $hub = Read-HubConfig # 現在のハブ設定。
    $profileName = [string]$hub.profileName # ハブ用プロファイル名。
    $pattern = "--profile\s+$([regex]::Escape($profileName))(?:\s|$)" # このハブのTunnel Clientを見分ける引数。
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match $pattern })
    if ($running.Count -eq 0) { Write-Host 'ハブは起動していません。'; return $false }
    foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force -Confirm:$false }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match $pattern })
        if ($remaining.Count -eq 0) { Write-Host "ハブを停止しました。PID: $($running.ProcessId -join ', ')"; return $true }
        Start-Sleep -Milliseconds 500
    }
    throw "ハブのTunnel Clientを停止できませんでした。PID: $($running.ProcessId -join ', ')"
}

# 自動起動（Install-HubAutoStartが作るショートカット）の登録状態を調べる。ショートカットの存在、ターゲットのpwshの実在、
# 引数がこのproject-bridge.ps1（$PSScriptRoot）を指しているかを見る。Install-HubAutoStart / Uninstall-HubAutoStartの挙動は変えない。
# 戻り値は 'registered'（登録済み）/ 'not_registered'（未登録）/ 'mismatch'（壊れている・別のパスを指している）のいずれか。
# StartupFolderは試験用（実物のスタートアップフォルダーに触れずに確かめられるようにする）。既定はInstall-HubAutoStartと同じ実際のフォルダー。
function Get-HubAutoStartState {
    param([string]$StartupFolder = ([Environment]::GetFolderPath('Startup')))
    $shortcutPath = Join-Path $StartupFolder 'ChatGPT Project Bridge Hub.lnk' # Install-HubAutoStartと同じ名前。
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return 'not_registered' }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $targetPath = [string]$shortcut.TargetPath # ショートカットが指すpwsh。
        $arguments = [string]$shortcut.Arguments # 自動起動で渡す引数（-File "<project-bridge.ps1>" ...）。
    } catch {
        return 'mismatch' # ショートカット自体が壊れていて読めない。
    }
    $expectedBridgePath = Join-Path $PSScriptRoot 'project-bridge.ps1' # 自動起動が呼ぶべき、このproject-bridge.ps1自身。
    # Windowsのパスは大文字小文字を区別しないため、OrdinalIgnoreCaseで比べる。
    if ([string]::IsNullOrWhiteSpace($targetPath) -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf) -or $arguments.IndexOf($expectedBridgePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return 'mismatch'
    }
    return 'registered'
}

# 自動起動の登録状態を1行で表示する（HubStatus・HubDoctorから共通で呼ぶ）。未登録・不整合は警告として登録の案内を添えるが、
# 呼び出し元の操作自体は失敗にしない。
function Show-HubAutoStartState {
    switch (Get-HubAutoStartState) {
        'registered' { Write-Host '自動起動: 登録済みです（サインイン時に起動します。自動サインインの前は起動しません）。' }
        'not_registered' { Write-Host '警告: 自動起動は未登録です。PCを再起動するとハブは止まったままになります。登録: -Action HubServiceInstall' }
        'mismatch' { Write-Host "警告: 自動起動の登録が壊れているか、このスクリプト（$PSScriptRoot）とは別の場所を指しています。PCを再起動するとハブは止まったままになります。登録し直す: -Action HubServiceInstall" }
    }
}

# ログイン時にハブを自動起動するショートカットを、スタートアップ フォルダーへ登録する（管理者権限は不要）。
function Install-HubAutoStart {
    param([switch]$SkipStart)
    $hub = Read-HubConfig # 現在のハブ設定。
    if ([string]::IsNullOrWhiteSpace([string]$hub.tunnelId)) { throw 'ハブのTunnelが未設定です。先に HubAdd を実行してください。' }
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatGPT Project Bridge Hub.lnk' # 自動起動のショートカット。
    $pwshPath = (Get-Process -Id $PID).Path # 現在のPowerShell 7。
    # Microsoft Store版は ...\WindowsApps\Microsoft.PowerShell_<版>...\pwsh.exe という版付きのパスになり、ストアの更新で消えるため、
    # 版に依存しない実行エイリアスがあればそれを使う（install-windows.ps1 の Find-PwshExecutable と同じ考え方）。
    if ($pwshPath.IndexOf('\WindowsApps\', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $storeAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe' # Microsoft Store版の、版に依存しない実行エイリアス。
        if (Test-Path -LiteralPath $storeAlias -PathType Leaf) { $pwshPath = $storeAlias }
    }
    $bridgePath = Join-Path $PSScriptRoot 'project-bridge.ps1' # 自動起動で呼ぶ管理スクリプト。
    $arguments = "-NoLogo -NoProfile -WindowStyle Hidden -File `"$bridgePath`" -Action HubStart -Service" # 入力を求めない起動。
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $pwshPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'ChatGPT Project Bridge hub (Tunnel Client)'
    $shortcut.Save()
    Write-Host "自動起動を登録しました: $shortcutPath"
    Write-Host '次回のサインインから、ハブが自動で起動します。解除は -Action HubServiceUninstall です。'
    Write-Host '注意: サインインしている間は、承認済みのプロジェクトがChatGPTから常に読める状態になります。'
    if ($SkipStart) { return }
    $pattern = "--profile\s+$([regex]::Escape([string]$hub.profileName))(?:\s|$)" # このハブのTunnel Clientを見分ける引数。
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object { $_.CommandLine -match $pattern })
    if ($running.Count -gt 0) { Write-Host "ハブは既に起動中です。PID: $($running.ProcessId -join ', ')"; return }
    Start-Process -FilePath $pwshPath -ArgumentList $arguments -WindowStyle Hidden
    Write-Host 'ハブをバックグラウンドで起動しました。状態は -Action HubStatus で確認できます。'
}

# 自動起動のショートカットを削除する。動いているハブは止めない。
function Uninstall-HubAutoStart {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatGPT Project Bridge Hub.lnk' # 自動起動のショートカット。
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { Write-Host '自動起動は登録されていません。'; return }
    Remove-Item -LiteralPath $shortcutPath -Force -Confirm:$false
    Write-Host "自動起動を解除しました: $shortcutPath"
    Write-Host '動いているハブは止めていません。止める場合は -Action HubStop を実行してください。'
}

# 単一Manifestを検証し、配布対象の安全な絶対パスとmodeを返す。
function Get-DistributionSources {
    Assert-NotReparsePoint -Path $script:ManifestPath -Label 'distribution manifest'
    if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) { throw "distribution manifestがありません: $script:ManifestPath" }
    $manifest = Get-Content -LiteralPath $script:ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$manifest.version)) { throw 'distribution manifestの版が不正です。' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $sources = foreach ($entry in @($manifest.files)) {
        $relative = [string]$entry.path
        $modeText = [string]$entry.mode
        if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or ($relative -split '/') -contains '..' -or $modeText -cnotmatch '^0[67][0-7]{2}\z' -or -not $seen.Add($relative)) {
            throw "distribution manifestのpath、mode、または重複が不正です: $relative"
        }
        $cursor = $script:SkillRoot
        foreach ($segment in ($relative -split '/')) {
            $cursor = Join-Path $cursor $segment
            if (-not (Test-Path -LiteralPath $cursor)) { throw "配布対象がありません: $relative" }
            Assert-NotReparsePoint -Path $cursor -Label "配布対象 $relative"
        }
        if (-not (Test-Path -LiteralPath $cursor -PathType Leaf)) { throw "配布対象が通常ファイルではありません: $relative" }
        [pscustomobject]@{ Relative = $relative; Source = $cursor; Mode = [Convert]::ToInt32($modeText, 8) }
    }
    if (-not $seen.Contains('distribution.json')) { throw 'distribution manifest自身をfilesへ含めてください。' }
    return [pscustomobject]@{ Version = [string]$manifest.version; Sources = @($sources) }
}

# Manifest順の通常ファイルだけをdirectory entryなしのZIPへ書く。
function New-DistributionZip {
    param([object[]]$Sources, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression
    $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($outputStream, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
        try {
            foreach ($source in $Sources) {
                $entry = $archive.CreateEntry(($source.Relative -replace '\\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
                $entry.ExternalAttributes = ((0x8000 -bor [int]$source.Mode) -shl 16)
                $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $entryStream = $entry.Open()
                $sourceStream = [System.IO.File]::Open($source.Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                try { $sourceStream.CopyTo($entryStream) } finally { $sourceStream.Dispose(); $entryStream.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $outputStream.Dispose() }
}

# Manifest modeを保持し、directory entryなしの再現可能なtar.gzを書く。
function New-DistributionTarGz {
    param([object[]]$Sources, [string]$Destination)
    Add-Type -AssemblyName System.Formats.Tar
    $fileStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $gzipStream = [System.IO.Compression.GZipStream]::new($fileStream, [System.IO.Compression.CompressionLevel]::Optimal, $false)
        try {
            $writer = [System.Formats.Tar.TarWriter]::new($gzipStream, [System.Formats.Tar.TarEntryFormat]::Ustar, $true)
            try {
                foreach ($source in $Sources) {
                    $entryName = 'chatgpt-project-bridge/' + ($source.Relative -replace '\\', '/')
                    $entry = [System.Formats.Tar.UstarTarEntry]::new([System.Formats.Tar.TarEntryType]::RegularFile, $entryName)
                    $entry.Mode = [System.IO.UnixFileMode][int]$source.Mode
                    $entry.ModificationTime = [DateTimeOffset]::FromUnixTimeSeconds(0)
                    $entry.Uid = 0
                    $entry.Gid = 0
                    $entry.UserName = ''
                    $entry.GroupName = ''
                    $entry.DataStream = [System.IO.File]::Open($source.Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                    try { $writer.WriteEntry($entry) } finally { $entry.DataStream.Dispose() }
                }
            } finally { $writer.Dispose() }
        } finally { $gzipStream.Dispose() }
    } finally { $fileStream.Dispose() }
}

# Windows/Ubuntuの1コマンド導入Bundleを同じManifestから作る。
function Export-BridgeBundle {
    param([string]$Path, [switch]$Replace, [string]$SigningKeyPath)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'ExportBundleでは -OutputPath が必須です。' }
    $sshKeygen = $null # 署名に使うssh-keygenの絶対パス。署名しない場合は $null。
    if (-not [string]::IsNullOrWhiteSpace($SigningKeyPath)) {
        if (-not (Test-Path -LiteralPath $SigningKeyPath -PathType Leaf)) { throw "署名鍵がありません: $SigningKeyPath" }
        $SigningKeyPath = (Resolve-Path -LiteralPath $SigningKeyPath).ProviderPath
        $sshKeygenCommand = Get-Command ssh-keygen -ErrorAction SilentlyContinue
        if ($null -eq $sshKeygenCommand) { throw 'ssh-keygenが見つかりません。OpenSSHクライアントを有効にしてください。' }
        $sshKeygen = $sshKeygenCommand.Source
    }
    $destination = Resolve-UserFilePath -Path $Path
    $skillPrefix = $script:SkillRoot.TrimEnd('\') + '\'
    if ($destination.Equals($script:SkillRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($skillPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Bundleの出力先にSkill本体の配下は指定できません。' }
    Assert-NotReparsePoint -Path $destination -Label 'Bundle出力先'
    if ((Test-Path -LiteralPath $destination) -and -not (Test-Path -LiteralPath $destination -PathType Container)) { throw "Bundle出力先がフォルダーではありません: $destination" }
    [System.IO.Directory]::CreateDirectory($destination) | Out-Null
    $bundleNames = @('Windows', 'Ubuntu') # 既存出力ルート内で交換を許可する子フォルダー。
    foreach ($name in $bundleNames) {
        $target = Join-Path $destination $name
        Assert-NotReparsePoint -Path $target -Label "$name Bundle"
        if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Container)) { throw "Bundle対象がフォルダーではありません: $target" }
        if ((Test-Path -LiteralPath $target) -and -not $Replace) { throw "Bundle対象は既にあります。置き換える場合だけ -Force を指定してください: $target" }
    }
    $distribution = Get-DistributionSources
    $stage = Join-Path $destination ('.chatgpt-project-bridge.bundle.' + [guid]::NewGuid().ToString('N'))
    $backups = @{}
    $installed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    try {
        $windows = Join-Path $stage 'Windows'
        $ubuntu = Join-Path $stage 'Ubuntu'
        [System.IO.Directory]::CreateDirectory($windows) | Out-Null
        [System.IO.Directory]::CreateDirectory($ubuntu) | Out-Null
        $windowsArchive = Join-Path $windows 'chatgpt-project-bridge.zip'
        $ubuntuArchive = Join-Path $ubuntu 'chatgpt-project-bridge.tar.gz'
        New-DistributionZip -Sources $distribution.Sources -Destination $windowsArchive
        New-DistributionTarGz -Sources $distribution.Sources -Destination $ubuntuArchive
        Copy-Item -LiteralPath (Join-Path $script:SkillRoot 'scripts\install-windows.ps1') -Destination (Join-Path $windows 'install.ps1')
        Copy-Item -LiteralPath (Join-Path $script:SkillRoot 'scripts\install-ubuntu.sh') -Destination (Join-Path $ubuntu 'install.sh')
        foreach ($bundle in @(
            @{ Directory = $windows; Files = @('chatgpt-project-bridge.zip', 'install.ps1', 'VERSION.txt') },
            @{ Directory = $ubuntu; Files = @('chatgpt-project-bridge.tar.gz', 'install.sh', 'VERSION.txt') }
        )) {
            Write-Utf8Text -Path (Join-Path $bundle.Directory 'VERSION.txt') -Content ($distribution.Version + "`n")
            $lines = foreach ($name in $bundle.Files) { '{0}  {1}' -f (Get-FileHash -LiteralPath (Join-Path $bundle.Directory $name) -Algorithm SHA256).Hash.ToLowerInvariant(), $name }
            $sumsPath = Join-Path $bundle.Directory 'SHA256SUMS.txt' # 人が別経路で照合する対象の一覧。
            Write-Utf8Text -Path $sumsPath -Content (($lines -join "`n") + "`n")
            if ($null -ne $sshKeygen) {
                & $sshKeygen -Y sign -f $SigningKeyPath -n $script:SignatureNamespace $sumsPath
                if ($LASTEXITCODE -ne 0) { throw "SHA256SUMS.txtへの署名に失敗しました。終了コード: $LASTEXITCODE" }
            }
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        foreach ($name in $bundleNames) {
            $target = Join-Path $destination $name
            if (Test-Path -LiteralPath $target) {
                $backup = Join-Path $destination ".$name.backup.$stamp.$PID"
                if (Test-Path -LiteralPath $backup) { throw "Bundle backup先が既にあります: $backup" }
                Move-Item -LiteralPath $target -Destination $backup
                $backups[$name] = $backup
            }
            Move-Item -LiteralPath (Join-Path $stage $name) -Destination $target
            [void]$installed.Add($name)
        }
        foreach ($backup in $backups.Values) { if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force } }
    } catch {
        foreach ($name in @($bundleNames[($bundleNames.Count - 1)..0])) {
            $target = Join-Path $destination $name
            if ($installed.Contains($name) -and (Test-Path -LiteralPath $target)) { Remove-Item -LiteralPath $target -Recurse -Force }
            if ($backups.ContainsKey($name) -and (Test-Path -LiteralPath $backups[$name])) { Move-Item -LiteralPath $backups[$name] -Destination $target }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
    Write-Host "Bundleを作成しました: $destination"
    Write-Host '導入先で実行前に照合する指紋（SHA256SUMS.txt のSHA-256）。Bundleとは別の経路で伝えてください:'
    foreach ($name in $bundleNames) {
        $fingerprint = (Get-FileHash -LiteralPath (Join-Path $destination "$name\SHA256SUMS.txt") -Algorithm SHA256).Hash.ToLowerInvariant() # 一覧ファイル自体の指紋。
        Write-Host "  ${name}: $fingerprint"
    }
    if ($null -ne $sshKeygen) {
        Write-Host "SHA256SUMS.txt.sig を作成しました（名前空間 $script:SignatureNamespace）。署名鍵の指紋:"
        & $sshKeygen -l -f $SigningKeyPath
    } else {
        Write-Host '署名していません。署名する場合は -SigningKey でSSH秘密鍵を指定してください。'
    }
}

# 来歴証明の検証に使うGitHub CLIを、明示パス、PATH、既定の導入先の順に探す。見つからなければ止める。
function Find-GhExecutable {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) { throw "GitHub CLIが見つかりません: $ExplicitPath" }
        return (Resolve-Path -LiteralPath $ExplicitPath).ProviderPath
    }
    $command = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\gh\bin\gh.exe' # 手順書が案内する既定の導入先。
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    throw 'Tunnel Clientの来歴証明を検証するGitHub CLI（gh）が見つかりません。手順書の「Bundle作成（保守者向け）」に従って導入するか、-GhPath で指定してください。'
}

# Tunnel ClientのアーカイブをSLSA来歴証明（Sigstore bundle）で検証する。署名ワークフロー・タグ・コミットまで照合し、失敗なら止める。
function Assert-TunnelProvenance {
    param([string]$Gh, [string]$Artifact, [string]$Bundle, [string]$Repository, [string]$SignerWorkflow, [string]$SourceRef, [string]$SourceDigest, [string]$PredicateType)
    $output = & $Gh attestation verify $Artifact --bundle $Bundle --repo $Repository --signer-workflow $SignerWorkflow --source-ref $SourceRef --source-digest $SourceDigest --predicate-type $PredicateType 2>&1 # 検証結果の出力。
    if ($LASTEXITCODE -ne 0) { throw "Tunnel Clientの来歴証明の検証に失敗しました: $(Split-Path $Artifact -Leaf)`n$(($output | ForEach-Object { [string]$_ }) -join "`n")" }
}

# 依存物（Tunnel Client / Node.js）の版とSHA-256をロックファイルへ固定する。保守者がSkillのソース上で実行する。
# Tunnel Clientは公開SHA256SUMS.txtとの一致に加え、SLSA来歴証明をGitHub CLIで検証できた版だけを固定する。
function Update-DependencyLock {
    param([string]$RequestedTunnelVersion, [string]$RequestedNodeVersion, [string]$GhPath)
    # 入力の形式検査は Python版の re.fullmatch と同じ規則にする（大文字小文字を区別する -cnotmatch と、末尾の改行を許さない \z）。
    if (-not [string]::IsNullOrWhiteSpace($RequestedTunnelVersion) -and $RequestedTunnelVersion -cnotmatch '^v[0-9A-Za-z.\-]+\z') { throw "TunnelClientVersionの形式が不正です: $RequestedTunnelVersion" }
    if (-not [string]::IsNullOrWhiteSpace($RequestedNodeVersion) -and $RequestedNodeVersion -cnotmatch '^v\d+\.\d+\.\d+\z') { throw "NodeVersionは v22.11.0 の形式で指定してください: $RequestedNodeVersion" }
    $gh = Find-GhExecutable -ExplicitPath $GhPath # 来歴証明の検証に使うGitHub CLI。
    $ghVersionLines = @(& $gh --version) # GitHub CLIの版表示。
    if ($LASTEXITCODE -ne 0 -or $ghVersionLines.Count -eq 0) { throw "GitHub CLIを実行できません: $gh" }
    $ghVersion = [string]$ghVersionLines[0] # ロックへ記録する検証ツールの版。
    $provenanceRepository = 'openai/tunnel-client' # 来歴証明で要求するリポジトリ。
    $provenanceWorkflow = 'openai/tunnel-client/.github/workflows/release.yml' # 来歴証明で要求する署名ワークフロー。
    $provenancePredicate = 'https://slsa.dev/provenance/v1' # 来歴証明で要求する述語の種類。
    $tunnelDownloadPrefix = 'https://github.com/openai/tunnel-client/releases/download/' # 許可するTunnel Client取得元。
    $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'chatgpt-project-bridge-lock-updater' } # GitHub API要求ヘッダー。
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('chatgpt-project-bridge-lock-' + [guid]::NewGuid().ToString('N')) # 検証用ダウンロード先。
    [System.IO.Directory]::CreateDirectory($temporary) | Out-Null
    try {
        $releaseUri = if ([string]::IsNullOrWhiteSpace($RequestedTunnelVersion)) { 'https://api.github.com/repos/openai/tunnel-client/releases/latest' } else { "https://api.github.com/repos/openai/tunnel-client/releases/tags/$RequestedTunnelVersion" }
        $release = Invoke-RestMethod -Headers $headers -Uri $releaseUri
        $tunnelVersion = [string]$release.tag_name # 固定するTunnel Clientのリリースタグ。
        $sumsAsset = @($release.assets | Where-Object { $_.name -ceq 'SHA256SUMS.txt' })
        if ($sumsAsset.Count -ne 1) { throw 'Tunnel ClientのSHA256SUMS.txtを一意に特定できません。' }
        $tunnelSumsPath = Join-Path $temporary 'tunnel-SHA256SUMS.txt'
        Invoke-WebRequest -UseBasicParsing -Uri $sumsAsset[0].browser_download_url -OutFile $tunnelSumsPath
        $tunnelSums = @(Get-Content -LiteralPath $tunnelSumsPath -Encoding UTF8) # 公開されたハッシュ一覧。
        $bundleAsset = @($release.assets | Where-Object { $_.name -cmatch '^tunnel-client-v[^/]+-provenance\.sigstore\.json\z' })
        if ($bundleAsset.Count -ne 1) { throw 'Tunnel Clientの来歴証明（*-provenance.sigstore.json）を一意に特定できません。' }
        $bundleName = [string]$bundleAsset[0].name # 来歴証明のファイル名。
        $bundleUrl = [string]$bundleAsset[0].browser_download_url # 来歴証明の取得元。
        if (-not $bundleUrl.StartsWith($tunnelDownloadPrefix, [System.StringComparison]::Ordinal)) { throw "想定外の取得元です: $bundleUrl" }
        $bundlePath = Join-Path $temporary $bundleName
        Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $bundlePath
        $commit = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/openai/tunnel-client/commits/$tunnelVersion"
        $sourceDigest = [string]$commit.sha # タグが指すコミット。来歴証明のビルド元と照合する。
        if ($sourceDigest -cnotmatch '^[0-9a-f]{40}\z') { throw "タグ $tunnelVersion のコミットを特定できません。" }
        $sourceRef = "refs/tags/$tunnelVersion" # 来歴証明で要求するビルド元の参照。
        $tunnelAssets = [ordered]@{} # 固定するTunnel Clientのプラットフォーム別アセット。
        foreach ($platform in @('windows-amd64', 'linux-amd64', 'linux-arm64')) {
            $matching = @($release.assets | Where-Object { $_.name -cmatch "^tunnel-client-v[^/]+-$([regex]::Escape($platform))\.zip\z" })
            if ($matching.Count -ne 1) { throw "Tunnel Clientの $platform アセットを一意に特定できません。" }
            $assetName = [string]$matching[0].name
            $assetUrl = [string]$matching[0].browser_download_url
            if (-not $assetUrl.StartsWith($tunnelDownloadPrefix, [System.StringComparison]::Ordinal)) { throw "想定外の取得元です: $assetUrl" }
            $downloaded = Join-Path $temporary $assetName
            Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $downloaded
            $actual = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
            $published = @($tunnelSums | Where-Object { $_ -cmatch "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($assetName))\z" } | ForEach-Object { ($_ -split '\s+')[0].ToLowerInvariant() })
            if ($published.Count -ne 1 -or $published[0] -ne $actual) { throw "Tunnel Clientの $platform アセットのSHA-256が公開値と一致しません。" }
            Assert-TunnelProvenance -Gh $gh -Artifact $downloaded -Bundle $bundlePath -Repository $provenanceRepository -SignerWorkflow $provenanceWorkflow -SourceRef $sourceRef -SourceDigest $sourceDigest -PredicateType $provenancePredicate
            $tunnelAssets[$platform] = [ordered]@{ name = $assetName; url = $assetUrl; sha256 = $actual }
        }
        $tunnelProvenance = [ordered]@{
            bundle = [ordered]@{ name = $bundleName; url = $bundleUrl; sha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant() }
            repository = $provenanceRepository
            signerWorkflow = $provenanceWorkflow
            sourceRef = $sourceRef
            sourceDigest = $sourceDigest
            predicateType = $provenancePredicate
            verifiedWith = [string]$ghVersion
        } # ロックへ記録する来歴証明の検証条件。

        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
        $nodeRelease = if ([string]::IsNullOrWhiteSpace($RequestedNodeVersion)) { @($index | Where-Object { $_.lts })[0] } else { @($index | Where-Object { $_.version -eq $RequestedNodeVersion })[0] }
        if ($null -eq $nodeRelease -or -not $nodeRelease.lts) { throw 'Node.jsのLTS版を特定できません。-NodeVersion にLTS版を指定してください。' }
        $nodeVersionTag = [string]$nodeRelease.version # 固定するNode.jsの版。
        $nodeSumsPath = Join-Path $temporary 'node-SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$nodeVersionTag/SHASUMS256.txt" -OutFile $nodeSumsPath
        $nodeSums = @(Get-Content -LiteralPath $nodeSumsPath -Encoding UTF8) # 公開されたハッシュ一覧。
        $nodeAssets = [ordered]@{} # 固定するNode.jsのLinux向けアセット。
        foreach ($architecture in @('x64', 'arm64')) {
            $assetName = "node-$nodeVersionTag-linux-$architecture.tar.xz"
            $assetUrl = "https://nodejs.org/dist/$nodeVersionTag/$assetName"
            $downloaded = Join-Path $temporary $assetName
            Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $downloaded
            $actual = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
            $published = @($nodeSums | Where-Object { $_ -cmatch "^([0-9a-fA-F]{64})\s+$([regex]::Escape($assetName))\z" } | ForEach-Object { ($_ -split '\s+')[0].ToLowerInvariant() })
            if ($published.Count -ne 1 -or $published[0] -ne $actual) { throw "Node.jsの linux-$architecture アセットのSHA-256が公開値と一致しません。" }
            $nodeAssets["linux-$architecture"] = [ordered]@{ name = $assetName; url = $assetUrl; sha256 = $actual }
        }
        $wingetVersion = $nodeVersionTag.TrimStart('v') # Windowsでwingetに指定する版。
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($null -ne $winget) {
            $null = & $winget.Source show --exact --id OpenJS.NodeJS.LTS --version $wingetVersion --accept-source-agreements --disable-interactivity 2>&1
            if ($LASTEXITCODE -ne 0) { throw "wingetに OpenJS.NodeJS.LTS $wingetVersion がありません。-NodeVersion でwingetにある版を指定してください。" }
        } else {
            Write-Host "警告: wingetが無いため、OpenJS.NodeJS.LTS $wingetVersion の存在は確認していません。"
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }

    $lock = [ordered]@{
        schemaVersion = 1
        tunnelClient = [ordered]@{ version = $tunnelVersion; assets = $tunnelAssets; provenance = $tunnelProvenance }
        node = [ordered]@{ version = $nodeVersionTag; wingetVersion = $wingetVersion; assets = $nodeAssets }
    } # 書き込むロック内容。
    $previous = if (Test-Path -LiteralPath $script:LockPath -PathType Leaf) { Get-Content -LiteralPath $script:LockPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } # 更新前のロック。
    Assert-NotReparsePoint -Path $script:LockPath -Label '依存物ロック'
    $temporaryLock = "$($script:LockPath).$([guid]::NewGuid().ToString('N')).tmp" # 原子的に置き換えるための一時ファイル。
    try {
        Write-Utf8Text -Path $temporaryLock -Content ((($lock | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n") # ソースはLFで管理するため、ConvertTo-JsonのCRLFをLFへ揃える。
        Move-Item -LiteralPath $temporaryLock -Destination $script:LockPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryLock) { Remove-Item -LiteralPath $temporaryLock -Force }
    }
    $previousTunnel = if ($null -ne $previous) { [string]$previous.tunnelClient.version } else { '(なし)' } # 更新前のTunnel Client版。
    $previousNode = if ($null -ne $previous) { [string]$previous.node.version } else { '(なし)' } # 更新前のNode.js版。
    Write-Host "依存物ロックを更新しました: $($script:LockPath)"
    Write-Host "  Tunnel Client: $previousTunnel -> $tunnelVersion"
    foreach ($platform in $tunnelAssets.Keys) { Write-Host "    ${platform}: $($tunnelAssets[$platform].sha256)" }
    Write-Host "    来歴証明: 3アセットとも検証済み（$provenanceWorkflow、$sourceRef、コミット $sourceDigest、$ghVersion）"
    Write-Host "  Node.js: $previousNode -> $nodeVersionTag（winget $wingetVersion）"
    foreach ($platform in $nodeAssets.Keys) { Write-Host "    ${platform}: $($nodeAssets[$platform].sha256)" }
    Write-Host '差分を確認してからコミットし、ExportBundleでBundleを作り直してください。'
}

# 処理が途中で止まったとき、エラー文に設定値・パス由来の制御文字（ESC・OSCなど）があれば退避して表示し、終了コード1で終える。
# 退避するものが無ければ、PowerShellの通常のエラー表示に任せる。複数行の文のため改行だけ残す。
trap {
    $safeMessage = ConvertTo-EscapedDisplayText -Value $_.Exception.Message -KeepNewline # 端末へ出せる形のエラー文。
    if ($safeMessage -cne $_.Exception.Message) {
        [Console]::Error.WriteLine("ERROR: $safeMessage")
        exit 1
    }
    break
}

$rootlessActions = @('ExportSkill', 'ExportBundle', 'UpdateLock', 'HubList', 'HubStart', 'HubStop', 'HubRestart', 'HubDoctor', 'HubStatus', 'HubServiceInstall', 'HubServiceUninstall', 'HubPermissions') # プロジェクトルートを使わない操作。
$resolvedRoot = if ($Action -in $rootlessActions -or ($Action -eq 'HubRemove' -and -not [string]::IsNullOrWhiteSpace($HubName))) { $null } else { Resolve-BridgeProjectRoot -Path $ProjectRoot } # 通常操作の対象ルート。

switch ($Action) {
    'Init' {
        Initialize-ProjectBridge -Root $resolvedRoot -Name $ProjectName -Replace:$Force
        Test-ProjectBridge -Root $resolvedRoot
    }
    'ConfigureTunnel' {
        Configure-TunnelProfile -Root $resolvedRoot -RequestedProfile $Profile -RequestedTunnelId $TunnelId -ClientPath $TunnelClientPath -RequestedPort $HealthPort -Replace:$Force
    }
    'SaveKey' {
        Save-RuntimeKey -Root $resolvedRoot -RequestedProfile $Profile -Replace:$ReplaceKey
    }
    'Update' {
        Update-ProjectStatus -Root $resolvedRoot
    }
    'Test' {
        Test-ProjectBridge -Root $resolvedRoot
    }
    'Doctor' {
        Invoke-BridgeDoctor -Root $resolvedRoot -RequestedProfile $Profile -ClientPath $TunnelClientPath
    }
    'Start' {
        Start-BridgeTunnel -Root $resolvedRoot -RequestedProfile $Profile -ClientPath $TunnelClientPath -ExpectedSha256 $ExposureSha256
    }
    'Status' {
        Show-BridgeStatus -Root $resolvedRoot
    }
    'AddProject' {
        Add-ChatGptProject -Root $resolvedRoot -Name $ProjectName -RequestedProfile $Profile -RequestedTunnelId $TunnelId -ClientPath $TunnelClientPath -SkipBrowser:$NoBrowser -SkipStart:$NoStart -Reconfigure:$ForceReconfigure -ReplaceExistingKey:$ReplaceKey -ExpectedSha256 $ExposureSha256
    }
    'Approve' {
        $approveConfig = Read-BridgeConfig -Root $resolvedRoot # 承認対象のbridge設定。
        $approveProfile = Resolve-ProfileName -Config $approveConfig -ExplicitProfile $Profile -Root $resolvedRoot # 承認ファイルを決めるプロファイル名。
        [void](Confirm-BridgeExposure -Root $resolvedRoot -ProfileName $approveProfile -ExpectedSha256 $ExposureSha256)
    }
    'ShowExposure' {
        $showConfig = Read-BridgeConfig -Root $resolvedRoot # 公開範囲を表示する対象のbridge設定。
        $showProfile = Resolve-ProfileName -Config $showConfig -ExplicitProfile $Profile -Root $resolvedRoot # 承認ファイルを決めるプロファイル名（Approveと同じ解決方法）。
        Write-Output (Get-ExposureReport -Root $resolvedRoot -ProfileName $showProfile)
    }
    'SetPermission' {
        Set-ProjectPermission -Root $resolvedRoot -RequestedProfile $Profile -SourceRead $SourceRead -ClaudeCode $ClaudeCode -AllowedCommand $AllowedCommand -ExpectedSha256 $ExposureSha256
    }
    'HubPermissions' {
        Show-HubPermission
    }
    'HubAdd' {
        Add-HubProject -Root $resolvedRoot -Name $ProjectName -HubProjectName $HubName -RequestedTunnelId $TunnelId -ClientPath $TunnelClientPath -SkipBrowser:$NoBrowser -SkipStart:$NoStart -Reconfigure:$ForceReconfigure -ReplaceExistingKey:$ReplaceKey -ExpectedSha256 $ExposureSha256
    }
    'HubRemove' {
        Remove-HubProject -Root $resolvedRoot -HubProjectName $HubName
    }
    'HubList' {
        Show-HubList
    }
    'HubStart' {
        Start-HubTunnel -ClientPath $TunnelClientPath -Service:$Service
    }
    'HubStop' {
        [void](Stop-HubTunnel)
    }
    'HubRestart' {
        [void](Stop-HubTunnel)
        Start-HubTunnel -ClientPath $TunnelClientPath -Service:$Service
    }
    'HubServiceInstall' {
        Install-HubAutoStart -SkipStart:$NoStart
    }
    'HubServiceUninstall' {
        Uninstall-HubAutoStart
    }
    'HubDoctor' {
        Invoke-HubDoctor -ClientPath $TunnelClientPath
    }
    'HubStatus' {
        $statusHub = Read-HubConfig # 表示するハブ設定。
        if ($null -eq $statusHub.healthPort) { throw 'ハブのTunnelが未設定です。先に HubAdd を実行してください。' }
        Show-HubAutoStartState # ハブが止まっていると Show-ProfileStatus は例外で終わるため、先に表示する。
        Show-ProfileStatus -ProfileName ([string]$statusHub.profileName) -TunnelId ([string]$statusHub.tunnelId) -Port ([int]$statusHub.healthPort)
    }
    'UpdateLock' {
        Update-DependencyLock -RequestedTunnelVersion $TunnelClientVersion -RequestedNodeVersion $NodeVersion -GhPath $GhPath
    }
    'ExportSkill' {
        if ([string]::IsNullOrWhiteSpace($OutputPath)) { throw 'ExportSkillでは -OutputPath が必須です。' }
        $destination = Resolve-UserFilePath -Path $OutputPath
        $destinationDirectory = Split-Path $destination -Parent
        if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) { throw "出力先フォルダーがありません: $destinationDirectory" }
        $skillPrefix = $script:SkillRoot.TrimEnd('\') + '\'
        if ($destination.Equals($script:SkillRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($skillPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw '配布物の出力先にスキル本体の配下は指定できません。'
        }
        if ([System.IO.Path]::GetExtension($destination) -ne '.zip') { throw 'Windows版の配布形式は .zip を指定してください。' }
        if (Test-Path -LiteralPath $destination) {
            $destinationItem = Get-Item -LiteralPath $destination -Force
            if (($destinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "symlinkの出力先は拒否しました: $destination" }
        }
        if ((Test-Path -LiteralPath $destination) -and -not $Force) { throw "ZIPは既にあります。置き換える場合だけ -Force を指定してください: $destination" }
        $sources = (Get-DistributionSources).Sources
        $temporary = Join-Path $destinationDirectory ('.chatgpt-project-bridge-' + [guid]::NewGuid().ToString('N') + '.zip')
        try {
            New-DistributionZip -Sources $sources -Destination $temporary
            [System.IO.File]::Move($temporary, $destination, $true)
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
        Write-Host "別PC用のスキルZIPを作成しました: $destination"
    }
    'ExportBundle' {
        Export-BridgeBundle -Path $OutputPath -Replace:$Force -SigningKeyPath $SigningKey
    }
}

# 正常に終わったことを、同じプロセスから呼んだ側（管理画面の補助役・add-project.ps1・hub-add.ps1）へ終了コード0で伝える。
# 途中で呼んで失敗として扱わなかった外部コマンドの終了コードが $LASTEXITCODE に残るため（pwsh -File で起動したときは、ここまで来れば元から0）。
$global:LASTEXITCODE = 0
