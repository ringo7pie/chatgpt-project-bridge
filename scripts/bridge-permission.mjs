#!/usr/bin/env node
/*
  2.8.0: 公開設定（.chatgpt-project-bridge.json）に、権限の切り替え（ソースの読み取り・Claude Code の起動・許可コマンド）を反映した「候補」を作る。
  管理 CLI（project-bridge.py・project-bridge.ps1）の set-permission が、変更後の公開範囲を求める前に呼ぶ。Windows と Ubuntu で同じ変換になるよう、変換はここだけに置く。
  - 設定ファイルは読むだけ。候補は --output のファイルに新しく書く（設定ファイル自身には書かない。既に在るファイルは上書きしない）。
  - 厳密な UTF-8 で読み（不正なバイトは失敗にする。黙って置き換えない）、JSON 全体を往復して、未知のキーとキーの順を保つ。
  - 値の検証（許可コマンドの書けない形など）は server.mjs が、候補の公開範囲を求めるときに行う。ここは形（項目がオブジェクトであること）だけを確かめる。
  使い方:
    node bridge-permission.mjs --config <設定> --output <候補の保存先> [--source-read on|off] [--claude-code on|off] [--allowed-command <パターン>]...
  標準出力: {"schemaVersion":1,"changed":true|false}（ASCII だけ）。失敗は標準エラーに理由を出して終了コード 2。
  変更の内容:
    --source-read on  : detailExposure.sourceText と gitExposure.paths を true にする（項目が無ければ作る）
    --source-read off : detailExposure.sourceText だけ false にする（paths は残す。detailExposure が無ければ何もしない）
    --claude-code on  : claudeCode.enabled を true にする（claudeCode が無ければ {"enabled": true} ＝許可コマンドなしで作る）
    --claude-code off : claudeCode.enabled を false にする（許可コマンドなどは残す。claudeCode が無ければ何もしない）
    --allowed-command : 1 つでも渡すと claudeCode.allowedCommands をその一覧に置き換える（claudeCode が無ければ enabled: false で作る）
  指定しなかった項目は変えない。
*/
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

// 設定の項目がオブジェクトであることを確かめて返す。無い（undefined・null）なら null。
function objectSection(candidate, name) {
  const section = candidate[name]; // 設定の項目。
  if (section === undefined || section === null) return null;
  if (typeof section !== 'object' || Array.isArray(section)) throw new Error(`${name} はオブジェクトで指定してください。手で直してからやり直してください。`);
  return section;
}

/*
  設定（JSON を読んだオブジェクト）に権限の切り替えを反映した候補を返す。引数の設定は変えない。
  引数: config、changes（{ sourceRead: 'on'|'off'|null, claudeCode: 'on'|'off'|null, allowedCommands: 文字列の配列|null }）
  戻り値: { candidate（新しいオブジェクト）, changed（値かキーの順が変わったか） }
*/
export function applyPermissionChanges(config, changes = {}) {
  const { sourceRead = null, claudeCode = null, allowedCommands = null } = changes; // 指定されなかった項目は null。
  if (sourceRead !== null && sourceRead !== 'on' && sourceRead !== 'off') throw new Error('sourceRead は on か off で指定してください。');
  if (claudeCode !== null && claudeCode !== 'on' && claudeCode !== 'off') throw new Error('claudeCode は on か off で指定してください。');
  if (allowedCommands !== null && (!Array.isArray(allowedCommands) || allowedCommands.some(item => typeof item !== 'string'))) throw new Error('allowedCommands は文字列の配列で指定してください。');
  const candidate = structuredClone(config); // 反映先の写し。
  if (sourceRead === 'on') {
    const detail = objectSection(candidate, 'detailExposure') ?? {}; // 詳細取得の公開設定。
    detail.sourceText = true;
    candidate.detailExposure = detail;
    const gitExposure = objectSection(candidate, 'gitExposure') ?? {}; // Git情報の公開設定。
    gitExposure.paths = true;
    candidate.gitExposure = gitExposure;
  } else if (sourceRead === 'off') {
    const detail = objectSection(candidate, 'detailExposure');
    if (detail !== null) detail.sourceText = false;
  }
  if (claudeCode !== null || allowedCommands !== null) {
    let section = objectSection(candidate, 'claudeCode'); // Claude Code のジョブの設定。
    if (section === null && !(claudeCode === 'off' && allowedCommands === null)) section = { enabled: claudeCode === 'on' };
    if (section !== null) {
      if (claudeCode !== null) section.enabled = claudeCode === 'on';
      if (allowedCommands !== null) section.allowedCommands = [...allowedCommands];
      candidate.claudeCode = section;
    }
  }
  return { candidate, changed: !isDeepStrictEqual(candidate, config) };
}

// 設定ファイルを厳密な UTF-8 で読んで JSON にする（先頭の BOM は許す。server.mjs の読み方と同じ）。壊れた JSON・不正なバイト・オブジェクト以外は例外。
export function readConfigFile(configPath) {
  const bytes = fs.readFileSync(configPath); // 設定のバイト列。
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // 不正な UTF-8 は例外にする。
  const value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); // 読み込んだ設定。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定のルートは JSON のオブジェクトである必要があります。');
  return value;
}

// 候補を書き出す形（インデント 2・末尾に改行）にする。
export function formatConfig(candidate) {
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

// 引数を読む。--allowed-command だけ複数回指定できる。
function parseArguments(argv) {
  const parsed = { allowedCommands: [] }; // 読んだ引数。
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]; // 引数の名前。
    const value = argv[index + 1]; // その値。
    if (!name.startsWith('--') || value === undefined) throw new Error(`引数が正しくありません: ${name}`);
    index += 1;
    if (name === '--config') parsed.config = value;
    else if (name === '--output') parsed.output = value;
    else if (name === '--source-read') parsed.sourceRead = value;
    else if (name === '--claude-code') parsed.claudeCode = value;
    else if (name === '--allowed-command') parsed.allowedCommands.push(value);
    else throw new Error(`未対応の引数です: ${name}`);
  }
  return parsed;
}

function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2)); // 読んだ引数。
    if (!parsed.config || !parsed.output) throw new Error('--config と --output が必要です。');
    const config = readConfigFile(path.resolve(parsed.config)); // いまの設定。
    const { candidate, changed } = applyPermissionChanges(config, {
      sourceRead: parsed.sourceRead ?? null,
      claudeCode: parsed.claudeCode ?? null,
      allowedCommands: parsed.allowedCommands.length > 0 ? parsed.allowedCommands : null,
    }); // 変更後の候補。
    fs.writeFileSync(path.resolve(parsed.output), formatConfig(candidate), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); // 新しいファイルだけに書く。
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, changed })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
