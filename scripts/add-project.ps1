#Requires -Version 7
<#
.SYNOPSIS
  1つのローカルプロジェクトを確認付きでChatGPTへ接続する。
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$ProjectName,
    [string]$TunnelId,
    [string]$Profile,
    [string]$TunnelClientPath,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [switch]$ForceReconfigure,
    [switch]$ReplaceKey,
    [string]$ExposureSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bridge = Join-Path $PSScriptRoot 'project-bridge.ps1' # 中核の安全検査を必ず通す管理スクリプト。
# 配列のsplattingでは '-Action' などが名前付き引数にならず位置引数として渡るため、ハッシュテーブルで渡す。
$arguments = @{ Action = 'AddProject' } # 管理スクリプトへ渡す名前付き引数。
foreach ($pair in @(
    @{ Name = 'ProjectRoot'; Value = $ProjectRoot },
    @{ Name = 'ProjectName'; Value = $ProjectName },
    @{ Name = 'TunnelId'; Value = $TunnelId },
    @{ Name = 'Profile'; Value = $Profile },
    @{ Name = 'TunnelClientPath'; Value = $TunnelClientPath },
    @{ Name = 'ExposureSha256'; Value = $ExposureSha256 }
)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$pair.Value)) { $arguments[$pair.Name] = [string]$pair.Value }
}
foreach ($switchPair in @(
    @{ Name = 'NoBrowser'; Value = $NoBrowser },
    @{ Name = 'NoStart'; Value = $NoStart },
    @{ Name = 'ForceReconfigure'; Value = $ForceReconfigure },
    @{ Name = 'ReplaceKey'; Value = $ReplaceKey }
)) {
    if ($switchPair.Value) { $arguments[$switchPair.Name] = $true }
}

# 子PowerShellを挟まず、Ctrl+Cを呼び出し元へそのまま返す。失敗は管理スクリプトが例外で止める。
# 管理スクリプトが exit で終えたとき（エラー文の制御文字を退避して表示したとき）の終了コードも返す。正常に終われば管理スクリプトが0に戻す。
$global:LASTEXITCODE = 0
& $bridge @arguments
exit $global:LASTEXITCODE
