#!/usr/bin/env node
/*
  プロジェクト分析ツール（bridge-analysis.mjs）を検証する自己試験（Windows / Linux 共通、外部ネットワークなし）。
  一時プロジェクトに公開設定を書き、server.mjs の createProjectContext で作ったコンテキストの runDetailTool を呼ぶので、
  本物の公開境界（walk・readTextFile・statFile・公開文書）を通して end-to-end で確かめる。
  - 権限（gitExposure.paths・detailExposure.sourceText）ごとの、名前・本文の出し分けと hidden・status
  - known / inferred / unknown の区別、空欄テンプレートを「未記入」として扱うこと
  - 課題（文書の項目・ソースの TODO）の確度・注記・秘密値のマスク
  - 境界（既定の除外・拒否ディレクトリ・機微な名前・リンク・hardlink・バイナリ・巨大ファイル・path 引数の検査）
  - 検証（設定・過去の記録・今回の実行を分けること、テストを実行しないこと）
  - 応答の大きさの上限とページング、横断サマリーの 1 件分の形
  実プロジェクトでの確認は、環境変数 BRIDGE_REAL_PROJECT（複数はパス区切り文字で区切る）があるときだけ、一時の設定で読み取りだけ行う。
  データはこの試験専用の一時ディレクトリだけに作り、終了時に消す。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectContext } from './server.mjs';
import { createAnalyzer } from './bridge-analysis.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url)); // 同梱スクリプトのフォルダー。
// Windows の Node は、パスを含まないコマンド名（git など）を PATH より先に作業フォルダーから探す。横断サマリーが Git 層を呼ぶので、同梱スクリプトのフォルダーへ移る。
if (process.platform === 'win32') process.chdir(scriptDirectory);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-analysis-selftest-')); // この試験だけの削除対象。
const outsideRoot = path.join(temporaryRoot, 'outside'); // プロジェクト外（リンクの先）。
const assetsDirectory = path.join(scriptDirectory, '..', 'assets'); // 同梱の空欄テンプレート。
const MAX_RESPONSE_BYTES = 262144; // 応答の上限（bridge-tools-common.mjs の DEFAULT_MAX_RESPONSE_BYTES と同じ）。
const DAY_MS = 86400000; // 1 日のミリ秒。
const MARKERS = {
  fileName: 'MKFILENAME7Q',
  dirName: 'MKDIRNAME7Q',
  scriptBody: 'MKSCRIPTBODY7Q',
  dependency: 'mkdepname7q',
  mainPath: 'MKMAINPATH7Q',
  todoText: 'MKTODOTEXT7Q',
  ueModule: 'MKUEMODULE7Q',
  configBody: 'MKCONFIGBODY7Q',
  deniedFile: 'MKDENIEDFILE7Q',
  deniedTodo: 'MKDENIEDTODO7Q',
  envValue: 'MKENVVALUE7Q',
  idRsa: 'MKIDRSA7Q',
  secretsFile: 'MKSECRETSFILE7Q',
  secretTodo: 'MKSECRETTODO7Q',
  outsideTodo: 'MKOUTSIDETODO7Q',
  hardlinkTodo: 'MKHARDLINKTODO7Q',
  binaryTodo: 'MKBINARYTODO7Q',
  bigTail: 'MKBIGTAIL7Q',
  nodeModulesTodo: 'MKNODEMODULESTODO7Q',
  distTodo: 'MKDISTTODO7Q',
  pythonScriptTarget: 'mkpkg7q.cli:main',
  cmakeTarget: 'mkdemoapp7q',
  notAllowedDocument: 'MKNOTALLOWED7Q',
}; // 応答への出現の有無で判定する、名前・本文由来の印。
const BASE_CONFIG = {
  schemaVersion: 1,
  projectName: 'Analysis Selftest',
  contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
  statusFile: 'CHATGPT_PROJECT_STATUS.md',
  profileName: MARKERS.configBody,
  allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'],
  allowDirectories: [],
  denyDirectories: ['.git', 'private'],
  maxDocumentBytes: 524288,
}; // 模擬の公開設定。profileName はサーバーが使わない項目で、設定ファイルの本文が漏れないかの印に使う。

let passCount = 0; // 合格した検査数。
let failCount = 0; // 合格しなかった検査数。
let skipCount = 0; // 実行できなかった検査数。

// 判定を表示して件数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (condition) passCount += 1;
  else failCount += 1;
}

// 実行できなかった検査を表示して数える。
function skip(label) {
  process.stdout.write(`SKIP ${label}\n`);
  skipCount += 1;
}

// プロジェクト内にファイルを書く（親ディレクトリも作る）。
function writeProjectFile(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ファイルの更新日時を、今から days 日前にする。
function makeOld(full, days) {
  const past = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(full, past, past);
  return past;
}

/*
  公開設定を書いて、その設定のコンテキストを作る（承認ファイルなし）。
  引数: root、permissions（paths・sourceText・branchNames）、overrides（設定の上書き）
*/
function openContext(root, permissions = {}, overrides = {}) {
  const configPath = path.join(root, '.chatgpt-project-bridge.json');
  const detailExposure = {};
  if (permissions.sourceText) detailExposure.sourceText = true;
  if (permissions.branchNames) detailExposure.branchNames = true;
  const config = {
    ...BASE_CONFIG,
    ...(permissions.paths ? { gitExposure: { paths: true, commitSubjects: false } } : {}),
    ...(Object.keys(detailExposure).length > 0 ? { detailExposure } : {}),
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return createProjectContext(root, configPath, null);
}

// 新ツールを呼ぶ。例外はそのまま投げる。
async function callTool(context, toolName, input = {}) {
  return context.runDetailTool(toolName, input);
}

// 新ツールを呼び、投げた例外を返す（投げなければ null）。
async function callToolError(context, toolName, input = {}) {
  try {
    await context.runDetailTool(toolName, input);
    return null;
  } catch (error) {
    return error;
  }
}

// 応答を検査用の文字列にする。
function textOf(value) {
  return JSON.stringify(value);
}

// 整形した応答の大きさ（バイト）を返す。サーバーと同じく 2 スペースで整形して測る。
function responseBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

// 課題の一覧から、本文に印を含むものを探す。
function findTask(envelope, marker) {
  return (envelope.facts.tasks || []).find(task => String(task.text).includes(marker)) || null;
}

// プロジェクト外のリンク先と、hardlink の元を作る。
function createOutsideFiles() {
  writeProjectFile(outsideRoot, 'linkdir/todo.js', `// TODO: ${MARKERS.outsideTodo}\n`);
  writeProjectFile(outsideRoot, 'hard.js', `// TODO: ${MARKERS.hardlinkTodo}\n`);
}

/*
  権限・境界・各ツールの試験に使う、いろいろな目印を持つ模擬プロジェクトを作る。
  戻り値: { root, sideEffectPaths, symlinkCreated, hardlinkCreated, oldDate }
*/
function createRichProject(root) {
  const sideEffectPaths = [path.join(temporaryRoot, 'side-effect-npm.txt'), path.join(temporaryRoot, 'side-effect-make.txt')]; // テストが実行されたら作られるファイル。
  // 実行されたら target を作るコマンド（テストが実行されないことの確認に使う）。
  const sideEffectCommand = target =>`node -e "require('fs').writeFileSync('${target.replace(/\\/g, '/')}','x')"`;
  writeProjectFile(root, 'CHATGPT_PROJECT_CONTEXT.md', [
    '# Rich Fixture プロジェクト概要',
    '',
    '最終確認日：2026-10-01',
    '',
    '## 目的',
    '',
    'PURPOSE_TEXT_7Q を自動化するためのツール。',
    '',
    '## 技術構成',
    '',
    'Node.js と Unreal Engine を使う。TECH_TEXT_7Q',
    '',
    '## 主要構成',
    '',
    '- `src/index.js`: 中のファイルの説明 FILE_ROLE_7Q',
    '- `src/`: SRC_ROLE_7Q の本体',
    '',
    '```',
    'Rich/',
    '├─ App/          TREE_ROLE_7Q の .NET アプリ',
    '│   └─ App.csproj  入れ子の行 NESTED_TREE_7Q',
    '└─ README.md     説明',
    '```',
    '',
    '## 設計方針・制約',
    '',
    '変わりにくい設計判断、品質条件、禁止事項を記載してください。',
    '',
    '## ChatGPTへ相談するときの注意',
    '',
    '- この文書と `CHATGPT_PROJECT_STATUS.md` の更新日時を確認する。',
    '- 現在のGit情報は `get_project_status` または `get_recent_changes` のライブ値を優先する。',
    '- 不明な事項を過去の会話から推測しない。',
    '',
  ].join('\n'));
  writeProjectFile(root, 'CHATGPT_PROJECT_STATUS.md', [
    '# Rich Fixture 現在状態',
    '',
    '更新日時（機械収集）: <!-- AUTO:BEGIN updated_at -->2026-10-19 13:39:25 (+09:00)<!-- AUTO:END updated_at -->',
    '',
    '## 現在状態（CURATED）',
    '',
    'ベータ版。PHASE_TEXT_7Q まで実装した。',
    '',
    '## 課題・リスク・相談事項（CURATED）',
    '',
    '- 起動が遅い ISSUE_ITEM_7Q',
    '- [x] 済んだ課題 DONE_ITEM_7Q',
    '- なし',
    '',
    '## 次の作業（CURATED）',
    '',
    '- [ ] 未完了のチェック OPEN_ITEM_7Q',
    '- 計測を追加する NEXT_ITEM_7Q',
    '  - 入れ子の補足 NESTED_ITEM_7Q',
    '',
    '<!-- AUTO:BEGIN git -->',
    '## Git自動収集',
    '',
    '- 次の作業 AUTO_ITEM_7Q',
    '<!-- AUTO:END git -->',
    '',
  ].join('\n'));
  const readmePath = writeProjectFile(root, 'README.md', [
    '# Rich Fixture',
    '',
    'README_PARAGRAPH_7Q のための試験用プロジェクト。',
    '',
    '## 今後の予定',
    '',
    '- README の予定 README_NEXT_7Q',
    '',
  ].join('\n'));
  makeOld(readmePath, 365);
  writeProjectFile(root, 'package.json', JSON.stringify({
    name: 'rich-fixture',
    main: `${MARKERS.mainPath}.js`,
    scripts: { build: `node ${MARKERS.scriptBody}.js`, test: sideEffectCommand(sideEffectPaths[0]) },
    dependencies: { react: '^18.0.0', express: '^4.0.0', [MARKERS.dependency]: '1.0.0' },
    devDependencies: { jest: '^29.0.0' },
  }, null, 2));
  writeProjectFile(root, 'Game.uproject', JSON.stringify({ FileVersion: 3, EngineAssociation: '5.3', Modules: [{ Name: MARKERS.ueModule, Type: 'Runtime', LoadingPhase: 'Default' }], Plugins: [{ Name: 'ModelingToolsEditorMode', Enabled: true }] }, null, 2));
  writeProjectFile(root, 'pyproject.toml', [
    '[project]',
    'name = "rich-py"',
    'dependencies = [',
    '  "fastapi>=0.100",  # コメント',
    '  "requests",',
    ']',
    '',
    '[project.scripts]',
    `mkcli = "${MARKERS.pythonScriptTarget}"`,
    '',
    '[tool.pytest.ini_options]',
    'addopts = "-q"',
    '',
  ].join('\n'));
  writeProjectFile(root, 'CMakeLists.txt', `cmake_minimum_required(VERSION 3.20)\nproject(RichDemo CXX)\n# add_executable(commented_out x.cpp)\nadd_executable(${MARKERS.cmakeTarget} main.cpp)\nadd_library(\${PROJECT_NAME}-core STATIC main.cpp)\nenable_testing()\nadd_test(NAME demo COMMAND ${MARKERS.cmakeTarget})\n`);
  writeProjectFile(root, 'icons/license.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeProjectFile(root, 'main.cpp', 'int main() { return 0; }\n');
  writeProjectFile(root, 'App/App.csproj', [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    '    <PackageReference Include="xunit" Version="2.5.0" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n'));
  writeProjectFile(root, 'Makefile', `all:\n\techo build\n\ntest:\n\t${sideEffectCommand(sideEffectPaths[1])}\n`);
  writeProjectFile(root, `${MARKERS.dirName}/${MARKERS.fileName}.js`, `// TODO: ${MARKERS.todoText}\nexport const value = 1;\n`);
  writeProjectFile(root, 'src/index.js', '// FIXME: 入力の検証を足す FIXME_ITEM_7Q\nexport default 1;\n');
  const oldDate = makeOld(writeProjectFile(root, 'src/old.js', '// TODO: 古い課題 OLD_TODO_7Q\n'), 365);
  writeProjectFile(root, 'src/auth-todo.js', `// TODO: password=${MARKERS.secretTodo}\n`);
  writeProjectFile(root, 'src/big.js', `// TODO: big head BIGHEAD7Q\n${'// filler line for the size test\n'.repeat(10000)}// TODO: ${MARKERS.bigTail}\n`);
  writeProjectFile(root, 'src/binary.js', Buffer.concat([Buffer.from(`// TODO: ${MARKERS.binaryTodo}\n`), Buffer.from([0, 1, 2, 0, 3])]));
  writeProjectFile(root, '日本語 フォルダ/ファイル 名.js', '// TODO: 日本語のパスの課題 JPPATH7Q\n');
  writeProjectFile(root, 'tests/app.test.js', "test('works', () => {});\n");
  writeProjectFile(root, 'src/deps/lib/vendored.c', '/* TODO: VENDORED_TODO_7Q */\nint vendored(void) { return 0; }\n');
  writeProjectFile(root, 'docs/guide.md', `# Guide\n\n- [ ] 公開許可の無い文書の項目 ${MARKERS.notAllowedDocument}\n`);
  writeProjectFile(root, 'node_modules/pkg/index.js', `// TODO: ${MARKERS.nodeModulesTodo}\n`);
  writeProjectFile(root, 'dist/bundle.js', `// TODO: ${MARKERS.distTodo}\n`);
  writeProjectFile(root, `private/${MARKERS.deniedFile}.js`, `// TODO: ${MARKERS.deniedTodo}\n`);
  writeProjectFile(root, '.env', `API_TOKEN=${MARKERS.envValue}\n`);
  writeProjectFile(root, 'id_rsa', `${MARKERS.idRsa}\n`);
  writeProjectFile(root, 'secrets.txt', `${MARKERS.secretsFile}\n`);
  writeProjectFile(root, 'test-results/junit.xml', '<?xml version="1.0"?>\n<testsuites tests="5" failures="1" errors="0" skipped="1" time="1.5">\n  <testsuite name="suite" tests="5" failures="1" errors="0" skipped="1" timestamp="2026-09-01T10:00:00" time="1.5"></testsuite>\n</testsuites>\n');
  writeProjectFile(root, 'TestResults/run.trx', '<?xml version="1.0"?>\n<TestRun><Times creation="2026-09-02T09:00:00.000+09:00" start="2026-09-02T09:00:01.000+09:00" finish="2026-09-02T09:00:05.000+09:00" /><ResultSummary outcome="Completed"><Counters total="10" executed="10" passed="9" failed="1" error="0" timeout="0" aborted="0" notExecuted="0" /></ResultSummary></TestRun>\n');
  writeProjectFile(root, 'coverage/coverage-summary.json', JSON.stringify({ total: { lines: { total: 100, covered: 87, pct: 87 }, statements: { pct: 86 }, branches: { pct: 70 }, functions: { pct: 90 } } }));
  writeProjectFile(root, '.github/workflows/ci.yml', 'name: ci\non: [push]\njobs: {}\n');
  let symlinkCreated = false; // プロジェクト外を指すリンクを作れたか。
  try {
    fs.symlinkSync(path.join(outsideRoot, 'linkdir'), path.join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch { symlinkCreated = false; }
  let hardlinkCreated = false; // プロジェクト外のファイルへの hardlink を作れたか。
  try {
    fs.linkSync(path.join(outsideRoot, 'hard.js'), path.join(root, 'src', 'hardlinked.js'));
    hardlinkCreated = true;
  } catch { hardlinkCreated = false; }
  return { root, sideEffectPaths, symlinkCreated, hardlinkCreated, oldDate };
}

// 名前・本文由来の印のうち、権限が無いときに応答へ出てはいけないもの。
function forbiddenWithoutPermissions() {
  return [
    MARKERS.fileName, MARKERS.dirName, MARKERS.scriptBody, MARKERS.dependency, MARKERS.mainPath, MARKERS.todoText, MARKERS.ueModule,
    MARKERS.pythonScriptTarget, MARKERS.cmakeTarget, 'package.json', 'Game.uproject', 'App.csproj', 'CMakeLists', 'pyproject', 'node_modules',
    'linked-outside', 'test-results', 'TestResults', 'junit.xml', 'coverage-summary', 'ファイル 名', '日本語 フォルダ', 'net8.0', 'fastapi', 'FastAPI', 'React', 'Express', 'Jest',
    'auth-todo', 'hardlinked', 'main.cpp', 'tests/', 'src/old',
  ];
}

// 権限にかかわらず、応答へ出てはいけないもの（拒否・機微・設定ファイル・境界外）。
function forbiddenAlways() {
  return [
    MARKERS.configBody, '.chatgpt-project-bridge', MARKERS.deniedFile, MARKERS.deniedTodo, MARKERS.envValue, MARKERS.idRsa, MARKERS.secretsFile,
    MARKERS.outsideTodo, MARKERS.hardlinkTodo, MARKERS.binaryTodo, MARKERS.bigTail, MARKERS.nodeModulesTodo, MARKERS.distTodo, MARKERS.secretTodo,
    MARKERS.notAllowedDocument, 'secrets.txt', 'id_rsa', '"private', 'private/',
  ];
}

// 4 つのツールと横断サマリーの 1 件分を、同じコンテキストで呼んでまとめて返す。
async function callAll(context) {
  return {
    structure: await callTool(context, 'get_project_structure', { depth: 8, limit: 1000 }),
    overview: await callTool(context, 'get_project_overview'),
    tasks: await callTool(context, 'get_project_tasks', { limit: 200 }),
    validation: await callTool(context, 'get_project_validation'),
    portfolio: await context.getPortfolioEntry(),
  };
}

// ソースの静的な検査: 分析層がファイルシステムと子プロセスの部品を読み込まないこと。
function testModuleImports() {
  const source = fs.readFileSync(path.join(scriptDirectory, 'bridge-analysis.mjs'), 'utf8');
  check(!/from\s+['"](?:node:)?fs['"]/.test(source) && !/from\s+['"](?:node:)?fs\/promises['"]/.test(source), '分析層: node:fs を読み込まない（ファイルには境界だけを通して触れる）');
  check(!/child_process/.test(source) && !/\brequire\s*\(/.test(source), '分析層: 子プロセスの部品を読み込まない（ビルド・テストを実行しない）');
}

// 権限なし（既定）: 名前・パス・本文由来の値が応答に出ず、hidden と partial が付き、件数は出る。
async function testDefaultPermissions(fixture) {
  const context = openContext(fixture.root);
  const results = await callAll(context);
  const joined = textOf(results);
  const leaked = [...forbiddenWithoutPermissions(), ...forbiddenAlways()].filter(marker => joined.includes(marker));
  check(leaked.length === 0, `権限なし: 名前・パス・本文由来の値が応答に出ない${leaked.length > 0 ? `（出たもの: ${leaked.join(', ')}）` : ''}`);
  const { structure, overview, tasks, validation, portfolio } = results;
  check(structure.meta.status === 'partial' && structure.meta.hidden.includes('paths'), '権限なし: 構造は status partial、hidden に paths');
  check(structure.facts.entries === undefined && structure.facts.keyFiles === undefined && structure.page === null, '権限なし: 構造の一覧（entries・keyFiles）を返さない');
  const javascript = structure.facts.languages.find(item => item.language === 'JavaScript');
  check(structure.facts.summary.totalFiles >= 15 && javascript && javascript.files >= 8, '権限なし: 合計件数と言語別の件数は出る');
  check(structure.facts.excludedDirectories.count >= 2 && structure.facts.excludedDirectories.names === undefined, '権限なし: 除外したディレクトリは件数だけ（名前を出さない）');
  check(overview.meta.status === 'partial' && overview.meta.hidden.includes('paths') && overview.meta.hidden.includes('sourceText'), '権限なし: 概要は status partial、hidden に paths と sourceText');
  const frameworkNames = overview.facts.frameworks.value.map(item => item.name);
  check(frameworkNames.includes('Unreal Engine') && frameworkNames.includes('Node.js（npm パッケージ）') && frameworkNames.includes('CMake'), '権限なし: ファイルの存在だけで分かるフレームワーク（Unreal・Node.js・CMake）は known で出る');
  check(overview.facts.frameworks.value.every(item => item.evidence.length === 0), '権限なし: フレームワークの根拠にパスを付けない');
  check(overview.facts.dependencies.status === 'unknown' && overview.facts.dependencies.collectionStatus === 'partial', '権限なし: 依存は unknown（本文を読む権限が無いことを partial で示す）');
  check(overview.facts.buildMethods.collectionStatus === 'partial' && overview.facts.buildMethods.value.every(item => item.contentRead === false), '権限なし: ビルド方式は種類だけで、本文は読んでいない');
  check(overview.facts.modules.value.topLevelDirectoriesHidden === true && overview.facts.modules.value.topLevelDirectoryCount >= 5, '権限なし: 最上位ディレクトリは件数だけ');
  check(tasks.facts.codeTodoScan.performed === false && tasks.meta.hidden.includes('sourceText') && tasks.meta.hidden.includes('paths'), '権限なし: ソースの TODO は走査せず、hidden に理由');
  check(findTask(tasks, 'ISSUE_ITEM_7Q') !== null, '権限なし: 公開許可された文書の課題は出る');
  check(validation.facts.pastRecords.found === true && validation.facts.pastRecords.records.every(record => record.path === undefined && record.contentRead === false && record.total === null), '権限なし: 記録ファイルは種類と日時だけ（パスも内容も出さない）');
  check(validation.meta.hidden.includes('sourceText') && validation.meta.status === 'partial', '権限なし: 検証は status partial、hidden に sourceText');
  check(typeof portfolio.git?.status === 'string' && portfolio.collection.status !== 'ok', '権限なし: 横断サマリーの 1 件分は作れて、collection.status は ok ではない');
}

// 権限あり（paths + sourceText）: 構造の一覧・マニフェストの内容・目印・known/inferred/unknown の区別。
async function testFullPermissions(fixture) {
  const context = openContext(fixture.root, { paths: true, sourceText: true });
  const results = await callAll(context);
  const leaked = forbiddenAlways().filter(marker => textOf(results).includes(marker));
  check(leaked.length === 0, `権限あり: 拒否・機微・設定ファイル・境界外の名前と本文は出ない${leaked.length > 0 ? `（出たもの: ${leaked.join(', ')}）` : ''}`);
  const { structure, overview } = results;
  const paths = structure.facts.entries.map(entry => entry.path);
  check(structure.meta.status === 'ok' && structure.meta.hidden.length === 0, '権限あり: 構造は status ok、hidden なし');
  check(paths.includes(`${MARKERS.dirName}/${MARKERS.fileName}.js`) && paths.includes('src/index.js'), '権限あり: 構造の一覧にファイル名が出る');
  const nodeModules = structure.facts.entries.find(entry => entry.path === 'node_modules');
  check(nodeModules?.excluded === true && !paths.some(item => item.startsWith('node_modules/')) && !paths.some(item => item.startsWith('dist/')), '権限あり: node_modules・dist は excluded の印だけで中に降りない');
  check(structure.facts.excludedDirectories.names.includes('node_modules') && structure.facts.excludedDirectories.names.includes('dist'), '権限あり: 除外したディレクトリ名を出す');
  check(!paths.some(item => item === 'private' || item.startsWith('private/')) && !paths.includes('.env') && !paths.includes('id_rsa') && !paths.includes('secrets.txt'), '権限あり: denyDirectories・.env・id_rsa・secrets.txt は一覧に出ない');
  check(!paths.some(item => item.endsWith('.chatgpt-project-bridge.json')), '権限あり: 公開設定ファイルは一覧に出ない');
  check(paths.includes('日本語 フォルダ/ファイル 名.js'), '権限あり: 日本語・空白を含むパスとファイル名を扱える');
  const bigEntry = structure.facts.entries.find(entry => entry.path === 'src/big.js');
  check(bigEntry && bigEntry.bytes > 300 * 1024, '権限あり: 巨大ファイルの大きさを測る（本文は読まない）');
  const keyRoles = new Map(structure.facts.keyFiles.map(item => [item.path, item.role]));
  check(keyRoles.get('package.json') === 'manifest' && keyRoles.get('README.md') === 'readme' && keyRoles.get('.github/workflows/ci.yml') === 'ci' && keyRoles.get('tests') === 'testDirectory', '権限あり: keyFiles に名前の規約による役割（manifest・readme・ci・testDirectory）');
  check(structure.facts.keyFiles.every(item => item.roleStatus === 'inferred') && structure.inferences.some(item => /規約/.test(item.basis)), '権限あり: keyFiles の役割は推測（inferred）で、根拠は名前の規約');
  if (fixture.symlinkCreated) {
    check(!paths.some(item => item.startsWith('linked-outside')) && structure.facts.summary.skipped.links >= 1, '境界: プロジェクト外を指すリンク（junction / symlink）を辿らず、件数だけ数える');
  } else {
    skip('境界: プロジェクト外を指すリンク（作れない環境）');
  }
  const facts = overview.facts;
  check(facts.purpose.status === 'known' && facts.purpose.value.includes('PURPOSE_TEXT_7Q') && facts.purpose.evidence[0]?.heading === '目的' && facts.purpose.evidence[0]?.path === 'CHATGPT_PROJECT_CONTEXT.md', '概要: 記入済みの目的は known（根拠に文書と見出し）');
  check(facts.phase.status === 'known' && facts.phase.value.includes('PHASE_TEXT_7Q') && facts.phase.evidence[0]?.path === 'CHATGPT_PROJECT_STATUS.md', '概要: 記入済みの現在状態は known（状態文書）');
  check(facts.audience.status === 'unknown' && facts.audience.value === null, '概要: 根拠の無い項目（利用者）は unknown で value は null');
  check(facts.externalServices.status === 'unknown' && facts.externalServices.value === null, '概要: 外部サービスは依存名から創作しない（unknown）');
  check(facts.documents.context.templateUnfilled === false && facts.documents.context.unfilledSections.includes('設計方針・制約'), '概要: 一部だけ記入済みの文書は未記入扱いにせず、未記入の節を示す');
  const frameworks = new Map(facts.frameworks.value.map(item => [item.name, item]));
  check(frameworks.get('Unreal Engine')?.details?.engineAssociation === '5.3', '概要: .uproject を検出し、EngineAssociation を読む');
  check(frameworks.has('React') && frameworks.has('Express') && frameworks.get('React').status === 'known' && frameworks.get('React').evidence[0]?.path === 'package.json', '概要: package.json の依存から React・Express を known で検出（根拠にファイル名）');
  check(frameworks.has('Python') && frameworks.has('FastAPI') && frameworks.has('CMake'), '概要: Python（pyproject.toml）・FastAPI・CMake のマーカー');
  check(JSON.stringify(frameworks.get('.NET')?.details?.targetFrameworks) === JSON.stringify(['net8.0']), '概要: .csproj の TargetFramework を読む');
  const builds = new Map(facts.buildMethods.value.map(item => [item.kind, item]));
  const npmScripts = builds.get('npm scripts');
  check(npmScripts?.details?.scripts?.includes('build') && npmScripts?.details?.scripts?.includes('test') && String(npmScripts?.details?.commands?.build).includes(MARKERS.scriptBody), '概要: package.json の scripts（名前とコマンド）');
  check(builds.get('CMake')?.details?.executables?.includes(MARKERS.cmakeTarget) && !builds.get('CMake').details.executables.includes('commented_out'), '概要: CMake の add_executable（コメントは除く）');
  check(builds.get('CMake')?.details?.libraries?.includes('RichDemo-core'), '概要: CMake の ${PROJECT_NAME} は project() の名前に置き換える');
  check(!structure.facts.keyFiles.some(item => item.path === 'icons/license.svg'), '権限あり: 画像（license.svg）をライセンスのファイルと取り違えない');
  check(facts.documents.status.filledSections.includes('現在状態（CURATED）'), '概要: 1 行に収まった AUTO の印（BEGIN と END）の後ろの節を、自動収集の区間と取り違えない');
  check(builds.get('MSBuild')?.details?.outputTypes?.includes('Exe') && builds.get('Makefile')?.details?.targets?.includes('all'), '概要: .csproj の OutputType と Makefile のターゲット');
  const entryValues = facts.entryPoints.value;
  check(entryValues.some(item => item.value === `${MARKERS.mainPath}.js` && item.status === 'known'), '概要: package.json の main をエントリーポイント（known）として返す');
  check(entryValues.some(item => item.name === 'mkcli' && item.value === MARKERS.pythonScriptTarget) && entryValues.some(item => item.name === MARKERS.cmakeTarget) && entryValues.some(item => item.name === MARKERS.ueModule), '概要: pyproject の scripts・CMake の実行ファイル・UE のモジュール');
  const npmDependencies = facts.dependencies.value.find(item => item.ecosystem === 'npm');
  const pythonDependencies = facts.dependencies.value.find(item => item.ecosystem === 'PyPI');
  check(npmDependencies?.runtime.includes(MARKERS.dependency) && npmDependencies?.development.includes('jest') && pythonDependencies?.runtime.includes('fastapi') && pythonDependencies?.runtime.includes('requests'), '概要: 依存の名前（npm・PyPI）');
  const directories = new Map(facts.modules.value.topLevelDirectories.map(item => [item.name, item]));
  check(directories.get('src')?.status === 'known' && directories.get('src').role.includes('SRC_ROLE_7Q') && !directories.get('src').role.includes('FILE_ROLE_7Q'), '概要: 文書が書いたモジュールの役割は known（中のファイルの説明と取り違えない）');
  check(directories.get('App')?.status === 'known' && directories.get('App').role.includes('TREE_ROLE_7Q') && !textOf(facts.modules).includes('NESTED_TREE_7Q'), '概要: 文書の木構造（├─ 名前  役割）の最上位の行を、モジュールの役割として読む');
  check(directories.get('tests')?.status === 'inferred' && directories.get('tests').confidence === 'low', '概要: 名前の規約からのモジュールの役割は inferred（low）');
  check(directories.get(MARKERS.dirName)?.status === 'unknown' && directories.get(MARKERS.dirName).role === null, '概要: 根拠の無いモジュールの役割は unknown');
  check(overview.meta.sources.some(source => source.kind === 'document' && source.sourceUpdatedAt) && overview.meta.sources.some(source => source.kind === 'config') && overview.meta.sources.some(source => source.kind === 'staticAnalysis' && source.live === true), '概要: 情報源に document（更新日時付き）・config・staticAnalysis を分けて入れる');
}

// 片方の権限だけ: paths だけ・sourceText だけのときの出し分け。
async function testPartialPermissions(fixture) {
  const pathsOnly = openContext(fixture.root, { paths: true });
  const pathsTasks = await callTool(pathsOnly, 'get_project_tasks');
  check(pathsTasks.facts.codeTodoScan.performed === false && /sourceText/.test(pathsTasks.facts.codeTodoScan.reason) && pathsTasks.meta.hidden.includes('sourceText'), 'paths だけ: ソースの TODO は走査しない（sourceText が無い）');
  const pathsOverview = await callTool(pathsOnly, 'get_project_overview');
  check(!textOf(pathsOverview).includes(MARKERS.dependency) && !textOf(pathsOverview).includes(MARKERS.scriptBody), 'paths だけ: マニフェストの本文由来の値は出さない');
  const sourceOnly = openContext(fixture.root, { sourceText: true });
  const sourceTasks = await callTool(sourceOnly, 'get_project_tasks');
  check(sourceTasks.facts.codeTodoScan.performed === false && /gitExposure\.paths/.test(sourceTasks.facts.codeTodoScan.reason) && !textOf(sourceTasks).includes(MARKERS.todoText), 'sourceText だけ: ソースの TODO は走査しない（paths が無い）');
  const sourceOverview = await callTool(sourceOnly, 'get_project_overview');
  const sourceText = textOf(sourceOverview);
  check(sourceText.includes(MARKERS.dependency) && sourceText.includes(MARKERS.ueModule), 'sourceText だけ: 依存の名前・UE のモジュール名は出る');
  check(![MARKERS.scriptBody, MARKERS.mainPath, MARKERS.fileName, MARKERS.dirName, MARKERS.pythonScriptTarget, 'package.json', 'Game.uproject'].some(marker => sourceText.includes(marker)), 'sourceText だけ: パスを含みうる値（コマンド・main・scripts の呼び出し先・ファイル名）は出さない');
  check(sourceOverview.facts.entryPoints.value.some(item => item.kind === 'Node.js パッケージの main' && item.value === null && item.valueHidden === true), 'sourceText だけ: main は存在だけ示し、値（パス）は伏せる');
  const sourceValidation = await callTool(sourceOnly, 'get_project_validation');
  const command = sourceValidation.facts.configured.tests.find(item => item.type === 'command' && item.script === 'test');
  check(command && command.command === null && command.commandHidden === true && !textOf(sourceValidation).includes('side-effect'), 'sourceText だけ: scripts.test のコマンド文字列は伏せる');
}

// 空欄テンプレート: 同梱のテンプレートとこのリポジトリの未記入の文書が、未記入（unknown・templateUnfilled）になり、完了と扱われない。
async function testTemplates() {
  const variants = [
    { name: 'assets のテンプレート', context: fs.readFileSync(path.join(assetsDirectory, 'CHATGPT_PROJECT_CONTEXT.template.md'), 'utf8'), status: fs.readFileSync(path.join(assetsDirectory, 'CHATGPT_PROJECT_STATUS.template.md'), 'utf8') },
  ];
  const repositoryContext = path.join(scriptDirectory, '..', 'CHATGPT_PROJECT_CONTEXT.md');
  const repositoryStatus = path.join(scriptDirectory, '..', 'CHATGPT_PROJECT_STATUS.md');
  if (fs.existsSync(repositoryContext) && fs.existsSync(repositoryStatus)) {
    variants.push({ name: 'リポジトリの未記入の文書', context: fs.readFileSync(repositoryContext, 'utf8'), status: fs.readFileSync(repositoryStatus, 'utf8'), optional: true });
  } else {
    skip('空欄テンプレート（リポジトリの未記入の文書）: リポジトリ直下に概要文書・状態文書が無い（配布物の写しなど）ため実行しない');
  }
  for (const [index, variant] of variants.entries()) {
    const root = path.join(temporaryRoot, `templates-${index}`);
    writeProjectFile(root, 'CHATGPT_PROJECT_CONTEXT.md', variant.context);
    writeProjectFile(root, 'CHATGPT_PROJECT_STATUS.md', variant.status);
    writeProjectFile(root, 'tool.py', 'print(1)\n');
    writeProjectFile(root, 'i18n/app_ja.ts', '<?xml version="1.0"?>\n<TS version="2.1" language="ja"></TS>\n');
    const context = openContext(root, { paths: true, sourceText: true });
    const overview = await callTool(context, 'get_project_overview');
    const facts = overview.facts;
    if (index === 0) {
      const languages = facts.languages.value.map(item => item.language);
      check(!languages.includes('TypeScript') && languages.some(item => item.startsWith('.ts（')), '言語: JS/TS の目印が無いプロジェクトの .ts は TypeScript と断定しない（Qt の翻訳ファイルの可能性）');
    }
    if (variant.optional && !facts.documents.context.templateUnfilled) {
      skip(`空欄テンプレート（${variant.name}）: 文書が記入済みになっている`);
      continue;
    }
    check(facts.documents.context.templateUnfilled === true && facts.documents.status.templateUnfilled === true && facts.documents.context.exists === true, `空欄テンプレート（${variant.name}）: 文書は存在するが templateUnfilled: true`);
    check(facts.purpose.status === 'unknown' && facts.purpose.value === null && facts.purpose.templateUnfilled === true, `空欄テンプレート（${variant.name}）: 目的は unknown（未記入）`);
    check(facts.phase.status === 'unknown' && facts.phase.value === null && facts.implementedFeatures.status === 'unknown', `空欄テンプレート（${variant.name}）: 現在状態・実装済み機能は known にならない`);
    check(!textOf(overview).includes('人が確認した現在のフェーズ') && !textOf(overview).includes('目的を記載してください'), `空欄テンプレート（${variant.name}）: 定型文を値として出さない`);
    const tasks = await callTool(context, 'get_project_tasks');
    const documentTasks = tasks.facts.tasks.filter(task => task.source === 'document');
    check(documentTasks.length === 0, `空欄テンプレート（${variant.name}）: 定型文・自動収集の区間を課題として拾わない（${documentTasks.length} 件）`);
    check(tasks.facts.blockers.status === 'unknown' && /無いことを意味しない/.test(tasks.facts.blockers.note), `空欄テンプレート（${variant.name}）: ブロッカーの節が無ければ unknown（無いと断定しない）`);
    const portfolio = await context.getPortfolioEntry();
    check(portfolio.implementationStatus.status === 'unknown' && portfolio.implementationStatus.value === null && portfolio.implementationStatus.templateUnfilled === true, `空欄テンプレート（${variant.name}）: 横断サマリーの実装状況は未記入（完了と扱わない）`);
    check(portfolio.nextChecks.some(item => /未記入|空欄テンプレート/.test(item)) && portfolio.nextChecks.every(item => item.startsWith('提案: ')), `空欄テンプレート（${variant.name}）: 次に確認すべき事項は「提案:」で始まり、未記入を案内する`);
    const validation = await callTool(context, 'get_project_validation');
    check(validation.facts.pastRecords.found === false && validation.facts.executedNow.performed === false, `空欄テンプレート（${variant.name}）: 記録が無ければ pastRecords.found は false（テストが無いとは断定しない）`);
  }
}

// 課題: 文書の項目の種類・確度、ソースの TODO の確度・注記・秘密値のマスク・境界。
async function testTasks(fixture) {
  const context = openContext(fixture.root, { paths: true, sourceText: true });
  const tasks = await callTool(context, 'get_project_tasks', { limit: 200 });
  const joined = textOf(tasks);
  const open = findTask(tasks, 'OPEN_ITEM_7Q');
  const issue = findTask(tasks, 'ISSUE_ITEM_7Q');
  const next = findTask(tasks, 'NEXT_ITEM_7Q');
  check(open?.kind === 'doc-open-item' && issue?.kind === 'doc-issue' && next?.kind === 'doc-next-work', '課題: 未完了のチェックボックス・課題の節・次の作業の節を種類別に拾う');
  check(issue?.confidence === 'medium' && issue?.location.heading === '課題・リスク・相談事項（CURATED）' && issue?.location.path === 'CHATGPT_PROJECT_STATUS.md' && issue?.source === 'document', '課題: 新しい文書の項目は確度 medium で、根拠に文書・見出し・行');
  check(!joined.includes('DONE_ITEM_7Q') && !joined.includes('NESTED_ITEM_7Q') && !joined.includes('AUTO_ITEM_7Q') && !tasks.facts.tasks.some(task => task.text === 'なし'), '課題: 完了済み・入れ子・自動収集の区間・「なし」は拾わない');
  check(!joined.includes('この文書と') && !joined.includes('ライブ値を優先する') && !joined.includes('記載してください'), '課題: テンプレートの定型文（相談するときの注意など）は拾わない');
  const readmeNext = findTask(tasks, 'README_NEXT_7Q');
  check(readmeNext?.kind === 'doc-next-work' && readmeNext?.confidence === 'low' && /古い/.test(readmeNext?.note), '課題: 古い文書（1 年前）の項目は確度 low で、注記に「古い」');
  check(tasks.facts.blockers.status === 'unknown' && /無いことを意味しない/.test(tasks.facts.blockers.note), '課題: ブロッカーの節が無ければ unknown（無いと断定しない）');
  const todo = findTask(tasks, MARKERS.todoText);
  check(todo?.kind === 'code-todo' && todo?.confidence === 'low' && todo?.source === 'staticAnalysis' && /ファイルの最終更新日時/.test(todo?.note) && /今も未解決とは限らない/.test(todo?.note), 'TODO: 確度は low、注記に最終更新日時と「今も未解決とは限らない」');
  const old = findTask(tasks, 'OLD_TODO_7Q');
  check(old && old.note.includes(fixture.oldDate.toISOString().slice(0, 10)) && /約 36[45] 日前/.test(old.note), 'TODO: 古いファイル（1 年前）の TODO は、更新日時と経過日数を注記する');
  const secret = tasks.facts.tasks.find(task => task.location.path === 'src/auth-todo.js');
  check(secret && secret.text.includes('[REDACTED]') && !joined.includes(MARKERS.secretTodo), 'TODO: 秘密値入りの TODO 行は伏せる');
  check(findTask(tasks, 'FIXME_ITEM_7Q')?.marker === 'FIXME', 'TODO: FIXME も拾う');
  const vendored = findTask(tasks, 'VENDORED_TODO_7Q');
  const vendoredIndex = tasks.facts.tasks.indexOf(vendored);
  check(vendored?.possiblyVendored === true && vendored.text === 'TODO: VENDORED_TODO_7Q' && tasks.facts.tasks.every((task, index) => task.kind !== 'code-todo' || task.possiblyVendored || index < vendoredIndex), 'TODO: 第三者のコードらしい置き場所（3rdparty）の TODO は印を付けて後ろに並べる（/* */ の閉じは除く）');
  check(findTask(tasks, 'BIGHEAD7Q') !== null && !joined.includes(MARKERS.bigTail) && tasks.facts.codeTodoScan.clippedFiles >= 1, '境界: 巨大ファイル（300 KiB 超）は 256 KiB で切り詰めて読み、その先は読まない');
  check(!joined.includes(MARKERS.binaryTodo), '境界: バイナリ（NUL を含む）は読まない');
  if (fixture.hardlinkCreated) check(!joined.includes(MARKERS.hardlinkTodo) && tasks.facts.codeTodoScan.unreadable >= 2, '境界: hardlink は読まない（読めないファイルとして数える）');
  else skip('境界: hardlink（作れない環境）');
  if (fixture.symlinkCreated) check(!joined.includes(MARKERS.outsideTodo), '境界: プロジェクト外を指すリンクの先は読まない');
  else skip('境界: プロジェクト外を指すリンクの先（作れない環境）');
  check(!joined.includes(MARKERS.nodeModulesTodo) && !joined.includes(MARKERS.distTodo) && !joined.includes(MARKERS.deniedTodo), '境界: 既定の除外（node_modules・dist）と denyDirectories の中は読まない');
  check(!joined.includes(MARKERS.notAllowedDocument), '課題: 公開許可されていない Markdown の項目は拾わない');
  const japanese = findTask(tasks, 'JPPATH7Q');
  check(japanese?.location.path === '日本語 フォルダ/ファイル 名.js', '境界: 日本語・空白を含むパスの TODO を拾う');
  check(tasks.facts.counts.total === tasks.facts.tasks.length && tasks.facts.counts['code-todo'] >= 5, '課題: 種類ごとの件数と合計');
  const firstPage = await callTool(context, 'get_project_tasks', { limit: 2 });
  const secondPage = await callTool(context, 'get_project_tasks', { limit: 2, offset: firstPage.page.nextOffset });
  check(firstPage.facts.tasks.length === 2 && firstPage.page.nextOffset === 2 && secondPage.page.offset === 2 && secondPage.facts.tasks[0]?.id !== firstPage.facts.tasks[0]?.id, '課題: limit と offset のページング（page.nextOffset）');
  const blockedRoot = path.join(temporaryRoot, 'blocked');
  writeProjectFile(blockedRoot, 'CHATGPT_PROJECT_STATUS.md', '# Blocked\n\n## ブロッカー\n\n- 承認待ち BLOCKER_ITEM_7Q\n\n## 課題\n\n外部ライブラリの更新が必要 PARAGRAPH_ISSUE_7Q\n');
  const blocked = await callTool(openContext(blockedRoot), 'get_project_tasks');
  check(blocked.facts.blockers.status === 'known' && blocked.facts.blockers.count === 1 && blocked.facts.tasks[0]?.kind === 'doc-blocker', '課題: ブロッカーの節があれば known で、一覧の先頭に並べる');
  check(findTask(blocked, 'PARAGRAPH_ISSUE_7Q')?.kind === 'doc-issue', '課題: 一覧の無い節は段落を 1 件として拾う');
}

// 境界と引数: path 引数の検査、深さ・件数の上限、ページング。
async function testStructureArguments(fixture) {
  const context = openContext(fixture.root, { paths: true, sourceText: true });
  const invalidInputs = [
    ['../outside', '親参照'],
    [path.join(temporaryRoot, 'outside'), '絶対パス'],
    ['C:\\Windows', 'ドライブ指定'],
    ['src/../../x', '途中の親参照'],
    ['private', 'denyDirectories'],
  ];
  for (const [value, label] of invalidInputs) {
    const error = await callToolError(context, 'get_project_structure', { path: value });
    check(error?.errorClass === 'invalid_argument', `引数: path に${label}を渡すと invalid_argument`);
  }
  const typeError = await callToolError(context, 'get_project_structure', { depth: 'deep' });
  check(typeError?.errorClass === 'invalid_argument', '引数: depth が数でなければ invalid_argument');
  const missing = await callTool(context, 'get_project_structure', { path: 'no-such-directory' });
  check(missing.meta.status === 'unavailable' && missing.meta.errorClass === 'not_found', '引数: 存在しない path は unavailable（not_found）');
  const scoped = await callTool(context, 'get_project_structure', { path: 'src', depth: 1 });
  check(scoped.facts.entries.length > 0 && scoped.facts.entries.every(entry => entry.path.startsWith('src/') && entry.depth === 1) && scoped.facts.scope.path === 'src', '引数: path を起点に、その配下だけを返す');
  const backslash = await callTool(context, 'get_project_structure', { path: '.\\src\\' });
  check(backslash.facts.scope.path === 'src', '引数: path の \\ 区切り・./・末尾の区切りを正規化する');
  const shallow = await callTool(context, 'get_project_structure', { depth: 1 });
  check(shallow.facts.entries.every(entry => entry.depth === 1) && shallow.facts.summary.totalFiles > shallow.facts.entries.filter(entry => entry.kind === 'file').length, '引数: depth で表示だけを絞り、件数は走査したぶん全部を数える');
  const clamped = await callTool(context, 'get_project_structure', { depth: 99, limit: 0 });
  check(clamped.meta.limits.depth === 8 && clamped.meta.limits.limit === 1 && clamped.facts.entries.length === 1 && clamped.page.nextOffset === 1, '引数: depth と limit は範囲内へ収め、page.nextOffset を返す');
  const next = await callTool(context, 'get_project_structure', { depth: 8, limit: 1, offset: 1 });
  check(next.facts.entries[0]?.path !== clamped.facts.entries[0]?.path && next.page.offset === 1, '引数: offset で次のページを返す');
  const ignored = await callTool(openContext(fixture.root), 'get_project_structure', { path: 'src' });
  check(ignored.meta.warnings.some(warning => /path 引数は使わず/.test(warning)) && !textOf(ignored).includes('"src"'), '権限なし: path 引数は使わず、全体の件数だけを返す（場所の有無を明かさない）');
}

// 検証: 設定・過去の記録・今回の実行を分け、テストを実行しない。
async function testValidation(fixture) {
  const context = openContext(fixture.root, { paths: true, sourceText: true });
  const validation = await callTool(context, 'get_project_validation');
  const facts = validation.facts;
  check(facts.executedNow.performed === false && facts.executedNow.note === 'このサーバーはビルドもテストも実行しません', '検証: executedNow.performed は常に false');
  check(facts.ciRunRecords.status === 'unknown', '検証: CI の実行結果は unknown（リモートにある）');
  const records = new Map(facts.pastRecords.records.map(record => [record.kind, record]));
  const junit = records.get('junit');
  check(facts.pastRecords.found === true && junit?.total === 5 && junit?.failed === 1 && junit?.skipped === 1 && junit?.passed === 3 && junit?.semantics === 'pastRecord', '検証: JUnit XML の件数を読む（semantics: pastRecord）');
  check(junit?.recordedAt === '2026-09-01T10:00:00' && junit?.recordedAtSource === 'recordContent' && junit?.path === 'test-results/junit.xml', '検証: 記録の日時は記録内の timestamp（由来を recordedAtSource に）');
  const trx = records.get('trx');
  check(trx?.total === 10 && trx?.passed === 9 && trx?.failed === 1 && trx?.recordedAt === '2026-09-02T09:00:05.000+09:00', '検証: TRX の Counters と Times を読む');
  check(records.get('coverage')?.coverage?.linesPct === 87 && records.get('coverage')?.recordedAtSource === 'fileModified', '検証: coverage-summary.json の total.lines.pct を読む（日時はファイルの更新日時）');
  check(validation.inferences.some(item => item.claim === '記録は過去の実行結果であり、現在の状態を保証しない' && item.confidence === 'high'), '検証: 記録は過去の結果で現在を保証しない、と confidence high で書く');
  check(validation.meta.sources.some(source => source.kind === 'testLog' && source.sourceUpdatedAt) && validation.meta.sources.some(source => source.kind === 'config'), '検証: 情報源に testLog（記録の更新日時付き）と config を分けて入れる');
  const tests = facts.configured.tests;
  const frameworks = tests.filter(item => item.type === 'framework').map(item => item.name);
  check(['Jest', 'pytest', 'xUnit.net', 'CTest'].every(name => frameworks.includes(name)), '検証: テストの枠組み（Jest・pytest・xUnit.net・CTest）');
  const command = tests.find(item => item.type === 'command' && item.script === 'test');
  check(command && command.command.includes('side-effect-npm') && command.executed === false, '検証: scripts.test のコマンド文字列（実行はしない）');
  check(tests.find(item => item.type === 'testFiles')?.count >= 1 && facts.configured.ci.some(item => item.kind === 'GitHub Actions'), '検証: テストファイルの件数と CI の設定');
  check(facts.configured.build.length >= 4 && facts.configured.build.every(item => item.executed === false), '検証: ビルド方式は「設定」として返し、実行しない');
  check(typeof facts.lastVerifiedAt.value === 'string' && /成功した日時ではない/.test(facts.lastVerifiedAt.note), '検証: lastVerifiedAt は更新日時の最新で、意味を注記する');
  for (const toolName of ['get_project_overview', 'get_project_tasks', 'get_project_validation', 'get_project_structure']) await callTool(context, toolName);
  await context.getPortfolioEntry();
  check(fixture.sideEffectPaths.every(target => !fs.existsSync(target)), '検証: package.json の scripts.test・Makefile の test は、どの呼び出しでも実行されない（副作用のファイルが無い）');
}

// 応答の大きさ: ファイルが数千個あっても上限に収め、truncated と page が整合する。
async function testResponseBudget() {
  const root = path.join(temporaryRoot, 'big');
  const longName = '長い日本語のファイル名'.repeat(4); // 1 件の応答を大きくするための長い名前。
  for (let directoryIndex = 0; directoryIndex < 3; directoryIndex += 1) {
    for (let fileIndex = 0; fileIndex < 1000; fileIndex += 1) writeProjectFile(root, `フォルダ${directoryIndex}/${longName}${String(fileIndex).padStart(4, '0')}.txt`, '');
  }
  const context = openContext(root, { paths: true });
  const first = await callTool(context, 'get_project_structure', { depth: 2, limit: 1000 });
  check(responseBytes(first) <= MAX_RESPONSE_BYTES, `応答の大きさ: 上限（${MAX_RESPONSE_BYTES} バイト）以内（${responseBytes(first)} バイト）`);
  check(first.meta.truncated === true && first.meta.status === 'partial' && first.facts.entries.length < 1000 && first.page.returned === first.facts.entries.length, '応答の大きさ: 上限を超えたら削り、truncated と page.returned を合わせる');
  check(first.page.nextOffset === first.page.offset + first.page.returned && first.facts.summary.totalFiles === 3000, '応答の大きさ: page.nextOffset は返した件数の続き、件数は全部を数える');
  const second = await callTool(context, 'get_project_structure', { depth: 2, limit: 1000, offset: first.page.nextOffset });
  const lastOfFirst = first.facts.entries[first.facts.entries.length - 1].path;
  check(second.facts.entries.length > 0 && second.facts.entries[0].path > lastOfFirst && responseBytes(second) <= MAX_RESPONSE_BYTES, '応答の大きさ: page.nextOffset から続きを取得できる');
}

/*
  走査の偏り: 境界の走査は深さ優先なので、前のディレクトリが件数の上限を使い切ると後ろのディレクトリを見落とす。
  横断サマリー（上限 5000 件）で、画像だけのディレクトリの後ろにある src・tests が見えることを確かめる。
*/
async function testSplitWalk() {
  const root = path.join(temporaryRoot, 'split');
  for (let index = 0; index < 5100; index += 1) writeProjectFile(root, `aaa-images/${String(index).padStart(5, '0')}.png`, '');
  writeProjectFile(root, 'src/main.py', 'print(1)\n');
  writeProjectFile(root, 'tests/test_main.py', 'def test_main():\n    assert True\n');
  const entry = await openContext(root, { paths: true }).getPortfolioEntry();
  check(entry.technologies.some(item => item.name === 'Python') && entry.testStatus.level === 'configured', '走査の偏り: 前のディレクトリで上限を使い切っても、後ろの src・tests を見落とさない');
  check(entry.collection.status === 'partial' && entry.collection.warnings.some(warning => /最上位のディレクトリごとに/.test(warning)), '走査の偏り: 分けて走査したことと、途中までであることを示す');
}

// 横断サマリーの 1 件分: 実際のコンテキストと、Git の軽量情報を渡した場合・渡さない場合の形。
async function testPortfolio(fixture) {
  const expectedKeys = ['projectName', 'os', 'purpose', 'technologies', 'lastActivityAt', 'git', 'implementationStatus', 'openIssues', 'testStatus', 'nextChecks', 'detailTools', 'collection'];
  const live = await openContext(fixture.root, { paths: true, sourceText: true }).getPortfolioEntry();
  check(expectedKeys.every(key => key in live) && live.projectName === 'Analysis Selftest' && ['windows', 'linux', 'darwin'].includes(live.os), '横断サマリー: 1 件分の形（実際のコンテキスト）');
  check(live.purpose.status === 'known' && live.implementationStatus.status === 'known' && live.implementationStatus.value.includes('PHASE_TEXT_7Q'), '横断サマリー: 目的と実装状況は文書から known');
  check(live.testStatus.level === 'pastRecord' && live.testStatus.lastRecordedAt && live.openIssues.codeTodoCount === null && live.openIssues.documentItemCount >= 3, '横断サマリー: テストは過去の記録、課題は文書の件数だけ（コードの TODO は数えない）');
  check(live.technologies.some(item => item.name === 'JavaScript') && live.technologies.some(item => item.name === 'Unreal Engine'), '横断サマリー: 主要技術（言語の上位とマーカー）');
  check(live.detailTools.includes('get_git_branches') && live.detailTools.includes('get_project_tasks'), '横断サマリー: 詳しく見るためのツール名');
  let readCalls = 0; // readTextFile が呼ばれた回数。
  const fakeEntries = [
    { path: 'src', kind: 'directory', size: 0, modifiedMs: Date.now(), depth: 1, excluded: false },
    { path: 'src/main.py', kind: 'file', size: 10, modifiedMs: Date.now(), depth: 2, excluded: false },
  ];
  const fakeDocuments = {
    'CHATGPT_PROJECT_CONTEXT.md': '# Fake\n\n## 目的\n\nFAKE_PURPOSE_7Q\n',
    'CHATGPT_PROJECT_STATUS.md': '# Fake\n\n## 現在状態\n\nFAKE_PHASE_7Q\n',
  };
  // 分析層を、メモリー上の模擬の境界で作る（Git の軽量情報の受け渡しだけを確かめる）。
  const fakeAnalyzer = exposure => createAnalyzer({
    projectName: 'fake-project',
    osName: 'linux',
    boundary: {
      exposure: { paths: false, commitSubjects: false, branchNames: false, diffExcerpts: false, sourceText: false, ...exposure },
      defaultExcludedDirectoryNames: [],
      isAnalyzable: () => true,
      walk: () => ({ startPath: '', entries: fakeEntries, truncated: false, truncatedBy: null, counts: { hidden: 0, excludedDirectories: 0, links: 0, unreadable: 0 }, excludedDirectoryNames: [] }),
      readTextFile: () => { readCalls += 1; throw new Error('読まないはず'); },
      statFile: () => null,
    },
    documents: {
      list: () => Object.keys(fakeDocuments).map(relativePath => ({ id: relativePath, path: relativePath, title: 'Fake', bytes: 1, modified: new Date().toISOString() })),
      read: relativePath => {
        if (!fakeDocuments[relativePath]) throw new Error('公開対象外');
        return { id: relativePath, path: relativePath, title: 'Fake', modified: new Date().toISOString(), text: fakeDocuments[relativePath] };
      },
      contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
      statusFile: 'CHATGPT_PROJECT_STATUS.md',
    },
  });
  const gitSummary = { status: 'ok', headState: 'branch', currentBranch: 'feature/x', uncommittedCount: 3, lastCommitAt: '2026-10-01T00:00:00+09:00', errorClass: null };
  const withGit = await fakeAnalyzer({}).getPortfolioEntry({ gitSummary });
  check(expectedKeys.every(key => key in withGit) && withGit.lastActivityAt === '2026-10-01T00:00:00+09:00' && withGit.git.status === 'ok' && withGit.git.uncommittedCount === 3 && withGit.git.headState === 'branch', '横断サマリー: gitSummary を写す（最終活動日時・未コミット件数）');
  check(withGit.git.currentBranch === null && withGit.collection.hidden.includes('branchNames'), '横断サマリー: branchNames の権限が無ければ現在のブランチ名を伏せる');
  check(withGit.nextChecks.some(item => item.includes('未コミットの変更が 3 件')) && withGit.nextChecks.every(item => item.startsWith('提案: ')), '横断サマリー: nextChecks は事実から作った提案（「提案:」で始まる）');
  check(withGit.purpose.status === 'known' && withGit.purpose.value === 'FAKE_PURPOSE_7Q' && readCalls === 0, '横断サマリー: sourceText が無ければファイルの本文を読まない');
  const named = await fakeAnalyzer({ branchNames: true }).getPortfolioEntry({ gitSummary: Promise.resolve(gitSummary) });
  check(named.git.currentBranch === 'feature/x', '横断サマリー: branchNames の権限があればブランチ名を出す（gitSummary が Promise でもよい）');
  const withoutGit = await fakeAnalyzer({}).getPortfolioEntry({});
  check(withoutGit.git.status === 'unavailable' && withoutGit.lastActivityAt === null && withoutGit.git.uncommittedCount === null, '横断サマリー: gitSummary が無ければ git.status は unavailable');
  const unborn = await fakeAnalyzer({}).getPortfolioEntry({ gitSummary: { ...gitSummary, headState: 'unborn', uncommittedCount: 0, lastCommitAt: null } });
  check(unborn.nextChecks.some(item => item.includes('HEAD がありません')), '横断サマリー: HEAD が無ければ次に確認すべき事項に出す');
  const failedGit = await fakeAnalyzer({}).getPortfolioEntry({ gitSummary: Promise.reject(new Error('失敗')) });
  check(failedGit.git.status === 'unavailable', '横断サマリー: gitSummary の取得に失敗しても例外にしない');
}

// 実プロジェクトでの確認（任意）: 一時の設定で、全メソッドが例外なく 20 秒以内に終わる。実プロジェクトの設定・承認は書き換えない。
async function testRealProjects() {
  const roots = String(process.env.BRIDGE_REAL_PROJECT || '').split(path.delimiter).map(item => item.trim()).filter(Boolean);
  if (roots.length === 0) {
    skip('実データ: BRIDGE_REAL_PROJECT が無い');
    return;
  }
  for (const [index, realRoot] of roots.entries()) {
    if (!fs.existsSync(realRoot) || !fs.statSync(realRoot).isDirectory()) {
      skip(`実データ: 見つからない（${realRoot}）`);
      continue;
    }
    const realConfigPath = path.join(realRoot, '.chatgpt-project-bridge.json');
    let base = { allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'], denyDirectories: ['.git'] }; // 実プロジェクトに設定が無いときの既定。
    if (fs.existsSync(realConfigPath)) {
      try { base = JSON.parse(fs.readFileSync(realConfigPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 読めなければ既定を使う。 */ }
    }
    const temporaryConfig = path.join(temporaryRoot, `real-config-${index}.json`);
    fs.writeFileSync(temporaryConfig, JSON.stringify({
      ...base,
      denyDirectories: [...new Set([...(Array.isArray(base.denyDirectories) ? base.denyDirectories : []), 'zzz-Temp'])],
      gitExposure: { paths: true, commitSubjects: false },
      detailExposure: { sourceText: true },
    }), 'utf8');
    const label = path.basename(realRoot);
    try {
      const context = createProjectContext(realRoot, temporaryConfig, null);
      const timings = []; // ツール名と時間。
      let largest = 0; // 最も大きい応答のバイト数。
      for (const [toolName, input] of [['get_project_structure', {}], ['get_project_overview', {}], ['get_project_tasks', {}], ['get_project_validation', {}]]) {
        const started = Date.now();
        const envelope = await callTool(context, toolName, input);
        timings.push([toolName, Date.now() - started, envelope.meta.status]);
        largest = Math.max(largest, responseBytes(envelope));
      }
      const started = Date.now();
      const entry = await context.getPortfolioEntry();
      timings.push(['getPortfolioEntry', Date.now() - started, entry.collection.status]);
      process.stdout.write(`INFO 実データ（${label}）: ${timings.map(([name, milliseconds, status]) => `${name}=${milliseconds}ms/${status}`).join(' ')} 最大の応答=${largest} バイト\n`);
      check(timings.every(([, milliseconds]) => milliseconds < 20000) && largest <= MAX_RESPONSE_BYTES, `実データ（${label}）: 全メソッドが例外なく 20 秒以内に終わり、応答は上限以内`);
    } catch (error) {
      check(false, `実データ（${label}）: 例外 ${error?.errorClass || ''} ${error?.message || error}`);
    }
  }
}

try {
  createOutsideFiles();
  const fixture = createRichProject(path.join(temporaryRoot, 'rich'));
  testModuleImports();
  await testDefaultPermissions(fixture);
  await testFullPermissions(fixture);
  await testPartialPermissions(fixture);
  await testTemplates();
  await testTasks(fixture);
  await testStructureArguments(fixture);
  await testValidation(fixture);
  await testResponseBudget();
  await testSplitWalk();
  await testPortfolio(fixture);
  await testRealProjects();
} catch (error) {
  process.stdout.write(`FAIL 例外: ${error?.stack || error}\n`);
  failCount += 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
process.stdout.write(failCount === 0
  ? `ANALYSIS_SELFTEST PASS (${passCount}) SKIP (${skipCount})\n`
  : `ANALYSIS_SELFTEST FAIL (${failCount}) PASS (${passCount}) SKIP (${skipCount})\n`);
process.exit(failCount === 0 ? 0 : 1);
