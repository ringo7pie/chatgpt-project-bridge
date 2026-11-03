#Requires -Version 5.1
<#
.SYNOPSIS
  Windows 10/11 x64へChatGPT Project Bridgeを1コマンドで導入する。
#>
[CmdletBinding()]
param(
    # 署名または指紋の照合を済ませた場合に、実行前の確認を省略する。
    [switch]$Verified
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:ArchiveName = 'chatgpt-project-bridge.zip' # Bundle内の検証対象アーカイブ名。
$script:TunnelDownloadPrefix = 'https://github.com/openai/tunnel-client/releases/download/' # 許可するTunnel Client取得元。
$script:SkillTarget = Join-Path $env:USERPROFILE '.codex\skills\chatgpt-project-bridge' # Codexが探索する導入先。
$script:LocalRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTProjectBridge' # ユーザー専用バイナリ・lock配置先。
$script:LocalBin = Join-Path $script:LocalRoot 'bin' # PATHへ追加するランチャー配置先。

# 現在のMachine/User PATHをプロセスへ反映する。
function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user) -join ';'
}

# wingetを正確なIDで非対話インストールする。Versionを渡すとその版に固定する。
function Install-WingetPackage {
    param([string]$Id, [string]$Version)
    $wingetArgs = @('install', '--exact', '--id', $Id, '--accept-package-agreements', '--accept-source-agreements', '--silent') # winget引数。
    if (-not [string]::IsNullOrWhiteSpace($Version)) { $wingetArgs += @('--version', $Version) }
    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0) { throw "winget installに失敗しました: $Id $Version (終了コード $LASTEXITCODE)" }
    Update-ProcessPath
}

# 指定コマンドがなければwingetで補う。
function Ensure-Command {
    param([string]$Name, [string]$WingetId)
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) { Install-WingetPackage -Id $WingetId }
    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "導入後もコマンドを検出できません: $Name" }
}

# winget導入直後のPATH反映差を吸収してPowerShell 7の絶対パスを返す。
function Find-PwshExecutable {
    $command = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).ProviderPath }
    }
    return $null
}

# Node.js 18以上がなければ、ロックで固定した版のLTSを導入する。
function Ensure-Node {
    param([string]$WingetVersion)
    $supported = $false
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $node) {
        $version = (& $node.Source --version) -replace '^v', ''
        $major = 0
        if ([int]::TryParse(($version -split '\.')[0], [ref]$major) -and $major -ge 18) { $supported = $true }
    }
    if (-not $supported) { Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Version $WingetVersion }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'Node.js LTSを検出できません。' }
    Write-Host "Node.js: $(& $node.Source --version) ($($node.Source))"
}

# ユーザーPATHへ重複なしで追加し、setxによる切り詰めを避ける。
# [Environment]::SetEnvironmentVariable はPATHを展開済みのREG_SZで書き戻し、%USERPROFILE% などの参照を固定値にしてしまうため、
# レジストリを展開せずに読み、元の型（通常はREG_EXPAND_SZ）のまま書き戻す。
function Add-UserPath {
    param([string]$Path)
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') # ユーザー環境変数のレジストリキー（書き込み可）。
    try {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString # 書き戻すときの型。値が無ければREG_EXPAND_SZで作る。
        if ($environmentKey.GetValueNames() -contains 'Path') {
            $currentKind = $environmentKey.GetValueKind('Path') # 既存の値の型。
            if ($currentKind -eq [Microsoft.Win32.RegistryValueKind]::String) { $kind = $currentKind }
        }
        $current = [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) # 展開前のユーザーPATH。
        $entries = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if (-not ($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $Path.TrimEnd('\') })) {
            $updated = (@($entries) + $Path) -join ';'
            $environmentKey.SetValue('Path', $updated, $kind)
            # 開いているエクスプローラーなどへ環境変数の変更を知らせる（WM_SETTINGCHANGE）。
            # SetEnvironmentVariable はレジストリを変えた後に必ずこの通知を送るので、存在しない変数の削除（値は何も変わらない）で通知だけを送る。
            [Environment]::SetEnvironmentVariable('CHATGPT_PROJECT_BRIDGE_SETTING_CHANGE', $null, 'User')
        }
    } finally {
        $environmentKey.Dispose()
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $Path.TrimEnd('\') })) { $env:Path = "$Path;$env:Path" }
}

# 既存パスがreparse pointならトランザクション対象にしない。
function Assert-NotReparsePoint {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label にreparse pointは使用できません: $Path" }
}

# 導入先の既存祖先を順に確認し、junctionを介した境界変更を拒否する。
function Assert-NoReparseAncestors {
    param([string]$Path, [string]$Label)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $cursor = $root
    foreach ($segment in $full.Substring($root.Length).Split([System.IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) { Assert-NotReparsePoint -Path $cursor -Label $Label }
    }
}

# PowerShell moduleの自動読込状態に依存せず、.NETだけでSHA-256を計算する。
function Get-Sha256Hex {
    param([string]$Path)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

# BundleのSHA256SUMSに記録されたアーカイブhashを照合する。
function Assert-BundleHash {
    param([string]$Archive)
    $sumPath = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $sumPath -PathType Leaf)) { throw "SHA256SUMSがありません: $sumPath" }
    $line = Get-Content -LiteralPath $sumPath -Encoding UTF8 | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape((Split-Path $Archive -Leaf)))$" } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($line)) { throw "アーカイブのhash記録がありません: $Archive" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = Get-Sha256Hex -Path $Archive
    if ($actual -ne $expected) { throw "BundleのSHA-256が一致しません: $Archive" }
}

# ロックの必須値を取り出し、存在しなければ例外にする。
function Get-LockValue {
    param([object]$Node, [string[]]$Names)
    $cursor = $Node # 辿っている途中の値。
    foreach ($name in $Names) {
        if ($null -eq $cursor -or -not ($cursor.PSObject.Properties.Name -contains $name)) { throw "dependencies.lock.json に $($Names -join '.') がありません。" }
        $cursor = $cursor.$name
    }
    return [string]$cursor
}

# 検証済みアーカイブ（無ければ導入済みSkill）の dependencies.lock.json を読み、Windowsで使う値を検証して返す。
function Read-DependencyLock {
    param([string]$Archive)
    $text = $null # ロックファイルの本文。
    if (-not [string]::IsNullOrWhiteSpace($Archive)) {
        Add-Type -AssemblyName System.IO.Compression
        $stream = [System.IO.File]::OpenRead($Archive)
        try {
            $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false, [System.Text.Encoding]::UTF8)
            try {
                $entry = $zip.GetEntry('dependencies.lock.json')
                if ($null -eq $entry) { throw 'アーカイブに dependencies.lock.json がありません。' }
                $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            } finally { $zip.Dispose() }
        } finally { $stream.Dispose() }
    } else {
        $installedLock = Join-Path $script:SkillTarget 'dependencies.lock.json'
        if (-not (Test-Path -LiteralPath $installedLock -PathType Leaf)) { throw "導入済みSkillに dependencies.lock.json がありません: $installedLock" }
        $text = Get-Content -LiteralPath $installedLock -Raw -Encoding UTF8
    }
    $lock = $text | ConvertFrom-Json
    if ((Get-LockValue -Node $lock -Names @('schemaVersion')) -ne '1') { throw 'dependencies.lock.json の版が不正です。' }
    $tunnel = [pscustomobject]@{
        Version = Get-LockValue -Node $lock -Names @('tunnelClient', 'version')
        Name = Get-LockValue -Node $lock -Names @('tunnelClient', 'assets', 'windows-amd64', 'name')
        Url = Get-LockValue -Node $lock -Names @('tunnelClient', 'assets', 'windows-amd64', 'url')
        Sha256 = Get-LockValue -Node $lock -Names @('tunnelClient', 'assets', 'windows-amd64', 'sha256')
    } # 固定されたTunnel Client。
    if ($tunnel.Name -notmatch '^tunnel-client-v[^/]+-windows-amd64\.zip$') { throw "Tunnel Clientのアセット名が不正です: $($tunnel.Name)" }
    if ($tunnel.Url -cne ($script:TunnelDownloadPrefix + $tunnel.Version + '/' + $tunnel.Name)) { throw "Tunnel Clientの取得元が許可されていません: $($tunnel.Url)" }
    if ($tunnel.Sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Tunnel ClientのSHA-256が不正です。' }
    $nodeWingetVersion = Get-LockValue -Node $lock -Names @('node', 'wingetVersion') # wingetで固定するNode.jsの版。
    if ($nodeWingetVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Node.jsのwinget版が不正です: $nodeWingetVersion" }
    return [pscustomobject]@{ TunnelClient = $tunnel; NodeWingetVersion = $nodeWingetVersion }
}

# 外部コマンドのヘルプを、標準出力と標準エラー出力をまとめた文字列と終了コードで返す。
# Windows PowerShell 5.1 は $ErrorActionPreference = 'Stop' のとき、2>&1 で受けた標準エラー出力の行を例外にするため、この関数の中だけ Continue にする。
# ヘルプの終了コードは実装によって0とは限らないので、成否は呼び出し側が出力の中身で判定する。
function Get-NativeHelpText {
    param([string]$FilePath, [string[]]$ArgumentList)
    $ErrorActionPreference = 'Continue'
    $lines = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { [string]$_ }) # 標準エラー出力の行はErrorRecordなので文字列にする。
    $exitCode = $LASTEXITCODE # ヘルプ表示の終了コード。
    return [pscustomobject]@{ Text = ($lines -join "`n"); ExitCode = $exitCode }
}

# ロックで固定したWindows x64版を、固定SHA-256とCLI仕様まで確認して導入する。
function Install-TunnelClient {
    param([object]$Pinned)
    [System.IO.Directory]::CreateDirectory($script:LocalBin) | Out-Null
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('chatgpt-project-bridge-tunnel-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($temporary) | Out-Null
    try {
        $archive = Join-Path $temporary $Pinned.Name
        Invoke-WebRequest -UseBasicParsing -Uri $Pinned.Url -OutFile $archive
        if ((Get-Sha256Hex -Path $archive) -ne $Pinned.Sha256) { throw 'Tunnel ClientのSHA-256がロックの値と一致しません。' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $extract = Join-Path $temporary 'extract'
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extract)
        $binary = @(Get-ChildItem -LiteralPath $extract -Recurse -File -Filter 'tunnel-client.exe')
        if ($binary.Count -ne 1) { throw 'archive内のtunnel-client.exeを一意に特定できません。' }
        $initHelp = Get-NativeHelpText -FilePath $binary[0].FullName -ArgumentList @('init', '--help')
        foreach ($flag in @('--profile-dir', '--control-plane-api-key-ref')) { if (-not $initHelp.Text.Contains($flag)) { throw "Tunnel Client initに必要な引数がありません: $flag (終了コード $($initHelp.ExitCode))" } }
        $runHelp = Get-NativeHelpText -FilePath $binary[0].FullName -ArgumentList @('run', '--help')
        foreach ($flag in @('--profile', '--pid.file', '--log.file', '--health.url-file')) { if (-not $runHelp.Text.Contains($flag)) { throw "Tunnel Client runに必要な引数がありません: $flag (終了コード $($runHelp.ExitCode))" } }
        Copy-Item -LiteralPath $binary[0].FullName -Destination (Join-Path $script:LocalBin 'tunnel-client.exe') -Force
        Write-Host "Tunnel Client: $($Pinned.Version) (SHA-256 $($Pinned.Sha256))"
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

# 実行前に、署名または指紋を別経路の値と照合したことを利用者に確認する。
function Confirm-BundleVerified {
    param([switch]$Skip)
    $sumsPath = Join-Path $PSScriptRoot 'SHA256SUMS.txt' # 照合対象の一覧。
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS.txt.sig') -PathType Leaf) {
        Write-Host '署名ファイル SHA256SUMS.txt.sig があります。ssh-keygen -Y verify で検証済みであることを確認してください。'
    } else {
        Write-Host '署名ファイルがありません。SHA256SUMS.txt の指紋を、Bundleとは別の経路で受け取った値と照合済みであることを確認してください。'
    }
    if (Test-Path -LiteralPath $sumsPath -PathType Leaf) { Write-Host "SHA256SUMS.txt の指紋: $(Get-Sha256Hex -Path $sumsPath)" }
    Write-Host '（この表示はインストーラー自身が出しているため、改ざんされたBundleでは信用できません。照合は実行前に行ってください。）'
    if ($Skip) { return }
    $answer = (Read-Host '署名または指紋の照合は済みましたか? [yes/NO]').Trim().ToLowerInvariant()
    if ($answer -notin @('yes', 'y')) { throw '照合が済んでいないため中止しました。手順書の「実行前の照合」を行ってから再実行してください。' }
}

# Skillアーカイブも導入済みSkillも無いときに、実行する場所を案内する。Skillのソースの scripts から直接実行された場合は、Bundleの作り方を添える。
# 例外のメッセージに入れると PowerShell 7 が改行を詰めて表示し、コマンドが読みにくくなるため、例外とは別に1行ずつ表示する。
function Write-MissingBundleGuidance {
    Write-Host 'このインストーラーは、ExportBundle で作った Bundle の Windows フォルダーの中で実行します（Bundle の中での名前は install.ps1）。'
    Write-Host "$($script:ArchiveName)、SHA256SUMS.txt、VERSION.txt と同じフォルダーに置き、フォルダーごとコピーしてください。"
    $bridgeScript = Join-Path $PSScriptRoot 'project-bridge.ps1' # 同じ場所にあれば、Skillのソースの scripts から実行されている。
    if (Test-Path -LiteralPath $bridgeScript -PathType Leaf) {
        Write-Host 'Skill のソースから導入する場合は、先に PowerShell 7 で Bundle を作ります（出力先は Skill の外のフォルダー）:'
        Write-Host "  pwsh -NoProfile -File `"$bridgeScript`" -Action ExportBundle -OutputPath <出力先フォルダー>"
        Write-Host 'その後、<出力先フォルダー>\Windows\install.ps1 を実行します。'
    }
}

# Manifestと一致する通常ファイルだけをstageへ展開する。
function Expand-ValidatedSkillArchive {
    param([string]$Archive, [string]$Stage)
    Add-Type -AssemblyName System.IO.Compression
    $stream = [System.IO.File]::OpenRead($Archive)
    try {
        $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false, [System.Text.Encoding]::UTF8)
        try {
            foreach ($entry in $zip.Entries) {
                if ([string]::IsNullOrWhiteSpace($entry.Name)) { throw "directory entryは許可されません: $($entry.FullName)" }
                $relative = $entry.FullName.Replace('/', '\')
                if ([System.IO.Path]::IsPathRooted($relative) -or $relative.Split('\') -contains '..') { throw "archive外を指すentryを拒否しました: $($entry.FullName)" }
                $destination = [System.IO.Path]::GetFullPath((Join-Path $Stage $relative))
                $prefix = [System.IO.Path]::GetFullPath($Stage).TrimEnd('\') + '\'
                if (-not $destination.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "archive外を指すentryを拒否しました: $($entry.FullName)" }
                [System.IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
                $input = $entry.Open()
                $output = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $manifestPath = Join-Path $Stage 'distribution.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'distribution.jsonがありません。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$manifest.version)) { throw 'distribution.jsonの版が不正です。' }
    $expected = @($manifest.files | ForEach-Object { [string]$_.path }) | Sort-Object
    $actual = @(Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object { $_.FullName.Substring($Stage.Length + 1).Replace('\', '/') }) | Sort-Object
    if (($expected -join "`n") -ne ($actual -join "`n")) { throw 'archiveのファイル一覧がdistribution.jsonと一致しません。' }
}

# Skillをlock・stage・backup・rollback付きで交換する。
function Install-SkillTransactionally {
    param([string]$Archive)
    [System.IO.Directory]::CreateDirectory($script:LocalRoot) | Out-Null
    $lockPath = Join-Path $script:LocalRoot 'install.lock'
    $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $targetParent = Split-Path $script:SkillTarget -Parent
    [System.IO.Directory]::CreateDirectory($targetParent) | Out-Null
    Assert-NoReparseAncestors -Path $targetParent -Label 'Skill導入経路'
    Assert-NoReparseAncestors -Path $script:SkillTarget -Label '既存Skill導入経路'
    $stage = Join-Path $targetParent ('.chatgpt-project-bridge.stage.' + [guid]::NewGuid().ToString('N'))
    $backup = $null
    try {
        [System.IO.Directory]::CreateDirectory($stage) | Out-Null
        Expand-ValidatedSkillArchive -Archive $Archive -Stage $stage
        if (Test-Path -LiteralPath $script:SkillTarget) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backup = "$($script:SkillTarget).backup.$stamp"
            if (Test-Path -LiteralPath $backup) { throw "backup先が既にあります: $backup" }
            Move-Item -LiteralPath $script:SkillTarget -Destination $backup
        }
        Move-Item -LiteralPath $stage -Destination $script:SkillTarget
    } catch {
        if ((-not (Test-Path -LiteralPath $script:SkillTarget)) -and $backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $script:SkillTarget }
        throw
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        $lock.Dispose()
    }
}

# .cmdへ書くパスを、利用者フォルダーなどの環境変数の参照へ置き換える。
# cmd.exeはバッチファイルをコンソールのコードページで読むため、日本語を含むユーザー名のパスをそのまま書くと壊れる。
# 環境変数の参照は実行時にUnicodeのまま展開されるので、ユーザー名に依存しない。置き換えても英数字以外が残るパスは拒否する。
function ConvertTo-BatchPath {
    param([string]$Path)
    $converted = $null # .cmdへ書く表記。
    foreach ($name in @('LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles')) {
        $value = [Environment]::GetEnvironmentVariable($name) # 置き換えの候補にする環境変数の値。長いものから順に試す。
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $prefix = $value.TrimEnd('\') + '\'
        if ($Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $converted = "%$name%\" + $Path.Substring($prefix.Length).Replace('%', '%%')
            break
        }
    }
    if ($null -eq $converted) { $converted = $Path.Replace('%', '%%') }
    if ($converted -match '[^\x20-\x7E]') { throw "ランチャー(.cmd)に書けない文字を含むパスです。英数字だけのフォルダーへ移してから再実行してください: $Path" }
    return $converted
}

# pwsh経由の4つの安定したランチャー（CLI 3本と管理画面(GUI) 1本）を作る。
function Install-Launchers {
    param([string]$PwshPath)
    [System.IO.Directory]::CreateDirectory($script:LocalBin) | Out-Null
    $pwshCommand = ConvertTo-BatchPath -Path $PwshPath # .cmdに書くPowerShell 7の表記。
    $bridge = ConvertTo-BatchPath -Path (Join-Path $script:SkillTarget 'scripts\project-bridge.ps1')
    $add = ConvertTo-BatchPath -Path (Join-Path $script:SkillTarget 'scripts\add-project.ps1')
    $hubAdd = ConvertTo-BatchPath -Path (Join-Path $script:SkillTarget 'scripts\hub-add.ps1') # ハブ方式でプロジェクトを追加するスクリプト。
    $gui = ConvertTo-BatchPath -Path (Join-Path $script:SkillTarget 'scripts\project-bridge-gui.ps1') # 管理画面(GUI)のスクリプト。
    [System.IO.File]::WriteAllText((Join-Path $script:LocalBin 'chatgpt-project-bridge.cmd'), "@echo off`r`n`"$pwshCommand`" -NoLogo -NoProfile -File `"$bridge`" %*`r`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText((Join-Path $script:LocalBin 'chatgpt-project-add.cmd'), "@echo off`r`n`"$pwshCommand`" -NoLogo -NoProfile -File `"$add`" %*`r`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText((Join-Path $script:LocalBin 'chatgpt-hub-add.cmd'), "@echo off`r`n`"$pwshCommand`" -NoLogo -NoProfile -File `"$hubAdd`" %*`r`n", [System.Text.Encoding]::ASCII)
    # 管理画面はコンソールを隠してGUIだけを出す。-STAはWinFormsに必要。
    [System.IO.File]::WriteAllText((Join-Path $script:LocalBin 'chatgpt-project-bridge-gui.cmd'), "@echo off`r`n`"$pwshCommand`" -NoLogo -NoProfile -STA -WindowStyle Hidden -File `"$gui`" %*`r`n", [System.Text.Encoding]::ASCII)
    Add-UserPath -Path $script:LocalBin
}

# スタートメニューへ管理画面(GUI)のショートカットを作る。再実行では同じ場所を上書きする（管理者権限は不要）。
function Install-StartMenuShortcut {
    param([string]$PwshPath)
    $programsDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' # ユーザー専用のスタートメニュー。
    [System.IO.Directory]::CreateDirectory($programsDirectory) | Out-Null
    $shortcutPath = Join-Path $programsDirectory 'ChatGPT Project Bridge.lnk' # 管理画面のショートカット。
    $guiPath = Join-Path $script:SkillTarget 'scripts\project-bridge-gui.ps1' # 管理画面(GUI)のスクリプト。
    $arguments = "-NoLogo -NoProfile -STA -WindowStyle Hidden -File `"$guiPath`"" # コンソールを隠してGUIだけを出す。
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $PwshPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.Description = 'ChatGPT へのプロジェクト公開の設定と起動（マウスオーバーで説明が出ます）'
    $shortcut.IconLocation = "$PwshPath,0"
    $shortcut.Save()
}

# ハブの自動起動（project-bridge.ps1 の Install-HubAutoStart が作るショートカット）の登録状態を調べる。
# project-bridge.ps1 側の同名関数と同じ判定基準（ショートカットの存在、ターゲットのpwshの実在、引数が導入先のproject-bridge.ps1を指しているか）。
# 戻り値は 'registered' / 'not_registered' / 'mismatch' のいずれか。StartupFolderは試験用（既定は実際のスタートアップフォルダー）。
function Get-HubAutoStartState {
    param(
        [Parameter(Mandatory)][string]$BridgePath,
        [string]$StartupFolder = ([Environment]::GetFolderPath('Startup'))
    )
    $shortcutPath = Join-Path $StartupFolder 'ChatGPT Project Bridge Hub.lnk'
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return 'not_registered' }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $targetPath = [string]$shortcut.TargetPath # ショートカットが指すpwsh。
        $arguments = [string]$shortcut.Arguments # 自動起動で渡す引数（-File "<project-bridge.ps1>" ...）。
    } catch {
        return 'mismatch' # ショートカット自体が壊れていて読めない。
    }
    # Windowsのパスは大文字小文字を区別しないため、OrdinalIgnoreCaseで比べる。
    if ([string]::IsNullOrWhiteSpace($targetPath) -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf) -or $arguments.IndexOf($BridgePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return 'mismatch' }
    return 'registered'
}

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10/11 x64だけをサポートします。' }
if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'wingetが必要です。App Installerを更新してから再実行してください。' }
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) { throw "Tunnel Client実行中はインストールできません。停止してください。PID: $($running.ProcessId -join ', ')" }

# 照合を尋ねる前に、導入元（同梱のSkillアーカイブ、無ければ導入済みSkill）があることを確かめる。無ければ照合する対象も無いので、尋ねずに案内して止める。
$bundleArchive = Join-Path $PSScriptRoot $script:ArchiveName # 同梱Skillアーカイブ。
if (-not (Test-Path -LiteralPath $bundleArchive -PathType Leaf) -and -not (Test-Path -LiteralPath $script:SkillTarget -PathType Container)) {
    Write-MissingBundleGuidance
    throw "Bundle archiveがありません: $bundleArchive"
}
Confirm-BundleVerified -Skip:$Verified

# 依存物を取得する前にBundleを照合し、固定された版とハッシュを読む。
$hasBundleArchive = Test-Path -LiteralPath $bundleArchive -PathType Leaf # アーカイブから導入するか。
if ($hasBundleArchive) {
    Assert-BundleHash -Archive $bundleArchive
    $pinned = Read-DependencyLock -Archive $bundleArchive # 固定された依存物。
} elseif (Test-Path -LiteralPath $script:SkillTarget -PathType Container) {
    $pinned = Read-DependencyLock -Archive ''
} else {
    Write-MissingBundleGuidance
    throw "Bundle archiveがありません: $bundleArchive"
}

$pwsh = Find-PwshExecutable
if ([string]::IsNullOrWhiteSpace($pwsh)) { Install-WingetPackage -Id 'Microsoft.PowerShell'; $pwsh = Find-PwshExecutable }
if ([string]::IsNullOrWhiteSpace($pwsh)) { throw 'PowerShell 7を導入後も既知パスから検出できません。サインアウト後に再実行してください。' }
Ensure-Node -WingetVersion $pinned.NodeWingetVersion
Ensure-Command -Name 'git' -WingetId 'Git.Git'
Update-ProcessPath
Install-TunnelClient -Pinned $pinned.TunnelClient
Add-UserPath -Path $script:LocalBin

if ($hasBundleArchive) { Install-SkillTransactionally -Archive $bundleArchive }
Install-Launchers -PwshPath $pwsh
Install-StartMenuShortcut -PwshPath $pwsh

Write-Host 'ChatGPT Project Bridgeのインストールが完了しました。'
Write-Host '新しい端末で実行: chatgpt-project-add'

$bridgePath = Join-Path $script:SkillTarget 'scripts\project-bridge.ps1' # 自動起動が指すべき、導入先のproject-bridge.ps1。
if ((Get-HubAutoStartState -BridgePath $bridgePath) -eq 'registered') {
    Write-Host 'ハブの自動起動: 登録済みです（サインイン時に起動します。自動サインインの前は起動しません）。'
} else {
    Write-Host 'ハブの自動起動: 未登録です。PCを再起動するとハブは止まったままになります。登録: chatgpt-project-bridge -Action HubServiceInstall'
    Write-Host '（登録すると次回のサインインから起動します。自動サインインの前は起動しません。）'
}
