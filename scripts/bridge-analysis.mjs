/*
  2.5.0 で追加したプロジェクト分析ツールの分析層。
  - get_project_structure・get_project_overview・get_project_tasks・get_project_validation の応答（envelope）と、
    全プロジェクト横断サマリーの 1 件分（getPortfolioEntry）を作る。
  - ファイルシステムには直接触れない。ファイルとディレクトリは server.mjs が渡す boundary（公開境界を検査済みの関数群）だけを通し、
    公開許可された文書は documents だけを通して読む。boundary と documents が返す文字列は秘密値のマスク済み。
  - ビルド・テスト・外部コマンドは実行しない（子プロセスを起動する部品を読み込まない）。
  - 権限（boundary.exposure）の paths が false ならファイル名・ディレクトリ名・パスを応答に出さず、
    sourceText が false ならファイルの本文を読まない（boundary.readTextFile を呼ばない）。
  - 各項目は known（文書・設定・測定値に書かれている）/ inferred（規約や名前からの推測）/ unknown（根拠なし）を区別し、推測で補わない。
    空欄テンプレートのままの文書の節は「未記入」として扱い、known にしない。
*/
import {
  BridgeToolError, ERROR_CLASS, STATUS, SOURCE_KIND, makeEnvelope, describeSource, paginate, clampInteger, requireString,
  fitToBudget, DEFAULT_MAX_RESPONSE_BYTES,
} from './bridge-tools-common.mjs';

const MAX_FILE_BYTES = 262144; // 1 ファイルから読む本文の上限（256 KiB）。境界側の上限と同じ。
const STRUCTURE_WALK_DEPTH = 12; // 構造・概要・課題・検証の走査で降りる深さ。
const STRUCTURE_WALK_ENTRIES = 20000; // 同じく、調べるエントリー数の上限。
const PORTFOLIO_WALK_DEPTH = 4; // 横断サマリーの軽量な走査で降りる深さ。
const PORTFOLIO_WALK_ENTRIES = 5000; // 同じく、エントリー数の上限。
const RECORD_WALK_DEPTH = 2; // テスト結果の記録の候補ディレクトリを浅く見る深さ。
const RECORD_WALK_ENTRIES = 500; // 同じく、エントリー数の上限。
const MAX_RECORDS = 30; // 返す記録ファイルの最大件数。
const PORTFOLIO_MAX_RECORDS_PARSED = 3; // 横断サマリーで内容を読む記録ファイルの最大件数。
const MARKER_MAX_DEPTH = 4; // フレームワーク・ビルド方式の目印のファイルを探す深さ。
const MANIFEST_MAX_DEPTH = 3; // マニフェストの本文を読む深さ。
const MAX_MANIFEST_READS = 24; // 本文を読むマニフェストの最大件数。
const TODO_MAX_FILES = 1500; // ソースの TODO を探すために本文を読むファイルの最大件数。
const TODO_TIME_BUDGET_MS = 5000; // ソースの TODO の走査に使う時間の上限。超えそうなら打ち切る。
const TODO_MAX_ITEMS = 2000; // 集める TODO の最大件数。
const TODO_MAX_PER_FILE = 50; // 1 ファイルから集める TODO の最大件数。
const TODO_MAX_FILE_SIZE = 2097152; // これより大きいファイルは TODO を探さない（生成物・データの可能性が高い）。
const MAX_TASK_DOCUMENTS = 100; // 課題を探す公開文書の最大件数。
const TASK_TEXT_MAX_CHARS = 200; // 課題 1 件の本文の最大文字数。
const SECTION_TEXT_MAX_CHARS = 1200; // 文書の節から取り出す本文の最大文字数。
const PORTFOLIO_TEXT_MAX_CHARS = 300; // 横断サマリーに載せる文の最大文字数。
const RECENT_DOCUMENT_DAYS = 30; // 文書の更新がこの日数以内なら、文書由来の課題の確度を medium にする。
const DAY_MS = 86400000; // 1 日のミリ秒。
const MAX_KEY_FILES = 100; // 主要ファイルの最大件数。
const MAX_NAMES_PER_LIST = 60; // 依存・ターゲットなど、名前の一覧の最大件数。
const MAX_COMMAND_CHARS = 200; // コマンド文字列の最大文字数。
const MAX_TEST_FILE_SAMPLES = 20; // テストファイルの例として出す最大件数。
const MAX_COMMANDS = 60; // ビルド方式に載せる scripts のコマンド文字列の最大件数（全マニフェストの合計）。
const MAX_ENTRY_POINTS = 100; // エントリーポイントの最大件数。
const MAX_TEST_CONFIG_ITEMS = 50; // テストの構成のうち、コマンドと設定ファイルの項目の最大件数（それぞれ）。
const MAX_DOCUMENT_TASKS = 2000; // 文書から集める課題の最大件数。
const MAX_NEXT_CHECKS = 8; // 「次に確認すべき事項」の最大件数。
const SPLIT_WALK_MIN_SHARE = 500; // 最上位のディレクトリごとに分けて走査するときの、1 ディレクトリの最小の枠。
const BRIDGE_CONFIG_FILE_NAME = '.chatgpt-project-bridge.json'; // 公開設定ファイル。本文を読まず、構造の一覧にも出さない。
const PORTFOLIO_DETAIL_TOOLS = Object.freeze([
  'get_project_overview', 'get_project_tasks', 'get_project_validation', 'get_project_structure',
  'get_git_branches', 'get_worktree_details', 'get_recent_activity',
]); // 横断サマリーから詳しく見るためのツール。

/*
  拡張子から言語（またはファイルの種類）と分類を引く表。分類は次のとおり。
  programming（プログラム）、markup（HTML・CSS・XML）、document（文書）、data（データ・設定）、build（ビルド定義）、
  binaryAsset（ゲームエンジンのアセット。.uasset は Blueprint を含むバイナリ資産）、media（画像・音声など）、archive（圧縮ファイル）。
*/
const LANGUAGE_TABLE = [
  ['JavaScript', 'programming', ['.js', '.mjs', '.cjs', '.jsx']],
  ['TypeScript', 'programming', ['.ts', '.tsx', '.mts', '.cts']],
  ['Python', 'programming', ['.py', '.pyw', '.pyi']],
  ['C', 'programming', ['.c']],
  ['C/C++ ヘッダー', 'programming', ['.h']],
  ['C++', 'programming', ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.inl', '.ipp']],
  ['C#', 'programming', ['.cs']],
  ['F#', 'programming', ['.fs', '.fsx']],
  ['Visual Basic', 'programming', ['.vb']],
  ['Java', 'programming', ['.java']],
  ['Kotlin', 'programming', ['.kt', '.kts']],
  ['Scala', 'programming', ['.scala']],
  ['Groovy', 'programming', ['.groovy', '.gradle']],
  ['Go', 'programming', ['.go']],
  ['Rust', 'programming', ['.rs']],
  ['Ruby', 'programming', ['.rb']],
  ['PHP', 'programming', ['.php']],
  ['Swift', 'programming', ['.swift']],
  ['Objective-C', 'programming', ['.m']],
  ['Objective-C++', 'programming', ['.mm']],
  ['Dart', 'programming', ['.dart']],
  ['Lua', 'programming', ['.lua']],
  ['R', 'programming', ['.r']],
  ['Perl', 'programming', ['.pl', '.pm']],
  ['Shell', 'programming', ['.sh', '.bash', '.zsh', '.fish']],
  ['PowerShell', 'programming', ['.ps1', '.psm1', '.psd1']],
  ['Batch', 'programming', ['.bat', '.cmd']],
  ['GDScript', 'programming', ['.gd']],
  ['シェーダー', 'programming', ['.hlsl', '.glsl', '.shader', '.usf', '.ush', '.compute', '.wgsl', '.frag', '.vert', '.gdshader', '.gdshaderinc']],
  ['SQL', 'programming', ['.sql']],
  ['Vue', 'programming', ['.vue']],
  ['Svelte', 'programming', ['.svelte']],
  ['HTML', 'markup', ['.html', '.htm']],
  ['CSS', 'markup', ['.css', '.scss', '.sass', '.less']],
  ['XML', 'markup', ['.xml', '.xaml', '.xsd', '.plist']],
  ['Markdown', 'document', ['.md', '.markdown', '.mdx']],
  ['reStructuredText', 'document', ['.rst']],
  ['テキスト', 'document', ['.txt']],
  ['JSON', 'data', ['.json', '.jsonc', '.json5']],
  ['YAML', 'data', ['.yml', '.yaml']],
  ['TOML', 'data', ['.toml']],
  ['INI・設定', 'data', ['.ini', '.cfg', '.conf', '.properties']],
  ['CSV', 'data', ['.csv', '.tsv']],
  ['CMake', 'build', ['.cmake']],
  ['MSBuild', 'build', ['.csproj', '.vcxproj', '.fsproj', '.vbproj', '.props', '.targets', '.sln']],
  ['Unreal Engine のプロジェクト・プラグイン定義', 'build', ['.uproject', '.uplugin']],
  ['Unreal アセット（バイナリ。Blueprint を含む）', 'binaryAsset', ['.uasset', '.umap']],
  ['Unity アセット', 'binaryAsset', ['.unity', '.prefab', '.asset', '.mat', '.meta', '.anim', '.controller']],
  ['Godot リソース', 'binaryAsset', ['.tscn', '.tres', '.godot', '.scn', '.res', '.ctex', '.oggvorbisstr', '.translation']],
  ['Godot のメタデータ', 'data', ['.import', '.uid']],
  ['Qt のフォーム・リソース定義', 'markup', ['.ui', '.qrc']],
  ['qmake', 'build', ['.pro', '.pri']],
  ['翻訳（gettext）', 'data', ['.po', '.pot']],
  ['翻訳（Qt のコンパイル済み）', 'binaryAsset', ['.qm']],
  ['画像', 'media', ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.psd', '.webp', '.ico', '.svg', '.exr', '.hdr', '.dds', '.tif', '.tiff']],
  ['音声', 'media', ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif']],
  ['動画', 'media', ['.mp4', '.mov', '.webm', '.avi', '.mkv']],
  ['3D モデル', 'media', ['.fbx', '.obj', '.blend', '.blend1', '.gltf', '.glb', '.dae', '.3ds']],
  ['フォント', 'media', ['.ttf', '.otf', '.woff', '.woff2']],
  ['実行ファイル・ライブラリ（バイナリ）', 'binary', ['.exe', '.dll', '.so', '.dylib', '.lib', '.a', '.o', '.pdb', '.pck', '.wasm']],
  ['ログ', 'data', ['.log']],
  ['ロックファイル', 'data', ['.lock']],
  ['圧縮ファイル', 'archive', ['.zip', '.7z', '.tar', '.gz', '.tgz', '.rar', '.xz', '.bz2']],
];
const LANGUAGE_BY_EXTENSION = new Map(); // 拡張子 → { language, category }。
for (const [language, category, extensions] of LANGUAGE_TABLE) {
  for (const extension of extensions) LANGUAGE_BY_EXTENSION.set(extension, { language, category });
}
const LANGUAGE_BY_FILE_NAME = new Map([
  ['makefile', { language: 'Makefile', category: 'build' }],
  ['gnumakefile', { language: 'Makefile', category: 'build' }],
  ['cmakelists.txt', { language: 'CMake', category: 'build' }],
  ['dockerfile', { language: 'Dockerfile', category: 'build' }],
  ['containerfile', { language: 'Dockerfile', category: 'build' }],
  ['jenkinsfile', { language: 'Groovy', category: 'build' }],
  ['gemfile', { language: 'Ruby', category: 'build' }],
  ['rakefile', { language: 'Ruby', category: 'build' }],
]); // 拡張子では決まらない、名前で決まるファイル（小文字で引く）。
const OTHER_LANGUAGE = Object.freeze({ language: 'other', category: 'other' }); // 表に無いもの。
const AMBIGUOUS_TS_LANGUAGE = Object.freeze({ language: '.ts（TypeScript か Qt の翻訳ファイル。判別できない）', category: 'ambiguous' }); // JS/TS の目印が無いプロジェクトの .ts。
const SCRIPT_ECOSYSTEM_FILE_PATTERN = /^(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|deno\.jsonc?)$/i; // .ts を TypeScript と見なしてよい目印。

/*
  フレームワーク・エンジン・ビルド方式の目印になるファイルの表。namePattern はファイル名、pathPattern はプロジェクト相対パスに当てる。
  label は応答に出す名前、description は paths の権限が無いときに根拠として出す一般的な説明（ファイル名を含めない）、
  build はビルド方式の種類、parse は本文の解析（sourceText の権限があるときだけ使う）、ecosystem は依存の配布元。
*/
const MARKER_RULES = [
  { id: 'unreal', label: 'Unreal Engine', kind: 'engine', namePattern: /\.uproject$/i, description: 'Unreal Engine のプロジェクトファイル', build: 'Unreal（Unreal Build Tool）', parse: parseUproject, ecosystem: 'Unreal Engine プラグイン' },
  { id: 'unreal-plugin', label: 'Unreal Engine（プラグイン）', kind: 'engine', namePattern: /\.uplugin$/i, description: 'Unreal Engine のプラグイン定義' },
  { id: 'unreal-module', label: 'Unreal Engine（C++ モジュール）', kind: 'engine', namePattern: /\.build\.cs$/i, description: 'Unreal Engine のモジュール定義' },
  { id: 'unity', label: 'Unity', kind: 'engine', pathPattern: /(?:^|\/)ProjectSettings\/ProjectVersion\.txt$/i, description: 'Unity のエディターのバージョン記録', build: 'Unity', parse: parseUnityVersion },
  { id: 'godot', label: 'Godot', kind: 'engine', namePattern: /^project\.godot$/i, description: 'Godot のプロジェクトファイル', build: 'Godot', parse: parseGodotProject },
  { id: 'node', label: 'Node.js（npm パッケージ）', kind: 'runtime', namePattern: /^package\.json$/i, description: 'Node.js のパッケージ定義', build: 'npm scripts', parse: parsePackageJson, ecosystem: 'npm' },
  { id: 'typescript', label: 'TypeScript', kind: 'language', namePattern: /^tsconfig(?:\.[\w-]+)?\.json$/i, description: 'TypeScript のコンパイラー設定' },
  { id: 'deno', label: 'Deno', kind: 'runtime', namePattern: /^deno\.jsonc?$/i, description: 'Deno の設定' },
  { id: 'cmake', label: 'CMake', kind: 'buildSystem', namePattern: /^CMakeLists\.txt$/i, description: 'CMake のビルド定義', build: 'CMake', parse: parseCmakeLists, ecosystem: 'CMake の find_package' },
  { id: 'python-pyproject', label: 'Python', kind: 'runtime', namePattern: /^pyproject\.toml$/i, description: 'Python のプロジェクト定義', build: 'Python（PEP 517 のビルド定義）', parse: parsePyproject, ecosystem: 'PyPI' },
  { id: 'python-requirements', label: 'Python', kind: 'runtime', namePattern: /^requirements(?:[-_.][\w.-]+)?\.txt$/i, description: 'Python の依存一覧', parse: parseRequirements, ecosystem: 'PyPI' },
  { id: 'python-setup', label: 'Python', kind: 'runtime', namePattern: /^(?:setup\.py|setup\.cfg|Pipfile)$/, description: 'Python のパッケージ定義', build: 'Python（setuptools / Pipenv）' },
  { id: 'cargo', label: 'Rust（Cargo）', kind: 'buildSystem', namePattern: /^Cargo\.toml$/i, description: 'Rust（Cargo）のパッケージ定義', build: 'Cargo', parse: parseCargoManifest, ecosystem: 'crates.io' },
  { id: 'go', label: 'Go（Go modules）', kind: 'buildSystem', namePattern: /^go\.mod$/i, description: 'Go のモジュール定義', build: 'Go modules', parse: parseGoMod, ecosystem: 'Go modules' },
  { id: 'dotnet', label: '.NET', kind: 'runtime', namePattern: /\.(?:csproj|fsproj|vbproj)$/i, description: '.NET のプロジェクトファイル', build: 'MSBuild', parse: parseMsbuildProject, ecosystem: 'NuGet' },
  { id: 'vcxproj', label: 'C++（MSBuild）', kind: 'buildSystem', namePattern: /\.vcxproj$/i, description: 'Visual C++ のプロジェクトファイル', build: 'MSBuild', parse: parseMsbuildProject },
  { id: 'solution', label: 'Visual Studio ソリューション', kind: 'buildSystem', namePattern: /\.sln$/i, description: 'Visual Studio のソリューション', build: 'MSBuild' },
  { id: 'make', label: 'Make', kind: 'buildSystem', namePattern: /^(?:GNUmakefile|makefile|Makefile)$/, description: 'Make のビルド定義', build: 'Makefile', parse: parseMakefile },
  { id: 'gradle', label: 'Gradle', kind: 'buildSystem', namePattern: /^(?:build|settings)\.gradle(?:\.kts)?$/i, description: 'Gradle のビルド定義', build: 'Gradle' },
  { id: 'maven', label: 'Maven', kind: 'buildSystem', namePattern: /^pom\.xml$/i, description: 'Maven のビルド定義', build: 'Maven' },
  { id: 'meson', label: 'Meson', kind: 'buildSystem', namePattern: /^meson\.build$/i, description: 'Meson のビルド定義', build: 'Meson' },
  { id: 'bazel', label: 'Bazel', kind: 'buildSystem', namePattern: /^(?:WORKSPACE|WORKSPACE\.bazel|MODULE\.bazel|BUILD\.bazel)$/, description: 'Bazel のビルド定義', build: 'Bazel' },
  { id: 'ruby', label: 'Ruby（Bundler）', kind: 'runtime', namePattern: /^Gemfile$/, description: 'Ruby の依存定義' },
  { id: 'php', label: 'PHP（Composer）', kind: 'runtime', namePattern: /^composer\.json$/i, description: 'PHP の依存定義' },
  { id: 'swift', label: 'Swift Package Manager', kind: 'buildSystem', namePattern: /^Package\.swift$/, description: 'Swift のパッケージ定義', build: 'Swift Package Manager' },
  { id: 'dart', label: 'Dart / Flutter', kind: 'runtime', namePattern: /^pubspec\.yaml$/i, description: 'Dart のパッケージ定義' },
  { id: 'docker', label: 'Docker', kind: 'container', namePattern: /^(?:Dockerfile|Containerfile)$|\.dockerfile$/i, description: 'コンテナイメージの定義', build: 'Docker（コンテナイメージ）' },
  { id: 'compose', label: 'Docker Compose', kind: 'container', namePattern: /^(?:docker-)?compose\.ya?ml$/i, description: 'Docker Compose の定義' },
];

const NODE_FRAMEWORK_PACKAGES = new Map([
  ['react', 'React'], ['react-dom', 'React'], ['vue', 'Vue'], ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'],
  ['@sveltejs/kit', 'SvelteKit'], ['@angular/core', 'Angular'], ['express', 'Express'], ['koa', 'Koa'], ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS'], ['hono', 'Hono'], ['electron', 'Electron'], ['react-native', 'React Native'], ['three', 'three.js'],
  ['phaser', 'Phaser'], ['vite', 'Vite'], ['webpack', 'webpack'], ['typescript', 'TypeScript'],
]); // package.json の依存名 → フレームワーク名。
const PYTHON_FRAMEWORK_PACKAGES = new Map([
  ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['numpy', 'NumPy'], ['pandas', 'pandas'], ['torch', 'PyTorch'],
  ['tensorflow', 'TensorFlow'], ['pyside6', 'Qt for Python（PySide6）'], ['pyqt5', 'PyQt5'], ['pyqt6', 'PyQt6'], ['pygame', 'pygame'],
]); // Python の依存名（小文字）→ フレームワーク名。
const NODE_TEST_PACKAGES = new Map([
  ['jest', 'Jest'], ['mocha', 'Mocha'], ['vitest', 'Vitest'], ['ava', 'AVA'], ['tap', 'node-tap'], ['jasmine', 'Jasmine'],
  ['karma', 'Karma'], ['@playwright/test', 'Playwright'], ['playwright', 'Playwright'], ['cypress', 'Cypress'], ['uvu', 'uvu'],
]); // package.json の依存名 → テストの枠組み。
const PYTHON_TEST_PACKAGES = new Map([['pytest', 'pytest'], ['nose2', 'nose2'], ['tox', 'tox'], ['hypothesis', 'Hypothesis']]); // Python の依存名 → テストの枠組み。
const DOTNET_TEST_PACKAGES = new Map([
  ['xunit', 'xUnit.net'], ['xunit.core', 'xUnit.net'], ['nunit', 'NUnit'], ['mstest.testframework', 'MSTest'], ['mstest', 'MSTest'],
  ['microsoft.net.test.sdk', 'Microsoft.NET.Test.Sdk'],
]); // NuGet のパッケージ名（小文字）→ テストの枠組み。

const TEST_CONFIG_RULES = [
  { name: 'Jest', namePattern: /^jest\.config\.(?:[cm]?[jt]s|json)$/i },
  { name: 'Vitest', namePattern: /^vitest\.config\.[cm]?[jt]s$/i },
  { name: 'Playwright', namePattern: /^playwright\.config\.[cm]?[jt]s$/i },
  { name: 'Cypress', namePattern: /^(?:cypress\.config\.[cm]?[jt]s|cypress\.json)$/i },
  { name: 'Karma', namePattern: /^karma\.conf\.[cm]?[jt]s$/i },
  { name: 'Mocha', namePattern: /^\.mocharc(?:\.[\w]+)?$/i },
  { name: 'pytest', namePattern: /^(?:pytest\.ini|conftest\.py)$/i },
  { name: 'tox', namePattern: /^tox\.ini$/i },
  { name: 'PHPUnit', namePattern: /^phpunit\.xml(?:\.dist)?$/i },
  { name: 'RSpec', namePattern: /^\.rspec$/i },
]; // テストの設定ファイル（存在だけで分かるもの）。
const TEST_FILE_NAME_PATTERNS = [
  /\.(?:test|spec)\.[A-Za-z0-9]+$/i,
  /^test_[^/]+\.py$/i,
  /_test\.(?:py|go)$/i,
  /Tests?\.(?:cs|java|kt|swift)$/,
  /_spec\.rb$/i,
  /(?:^|[-_.])self-?test(?:[-_.]|$)/i,
]; // テストファイルの名前の規約。
const TEST_DIRECTORY_NAME_PATTERN = /^(?:test|tests|__tests__|spec|specs|testing|e2e)$/i; // テスト用ディレクトリの名前の規約。

const CI_RULES = [
  { kind: 'GitHub Actions', pathPattern: /^\.github\/workflows\/[^/]+\.ya?ml$/i },
  { kind: 'GitLab CI', pathPattern: /^\.gitlab-ci\.ya?ml$/i },
  { kind: 'Azure Pipelines', pathPattern: /^(?:[^/]+\/)?azure-pipelines[^/]*\.ya?ml$/i },
  { kind: 'Jenkins', pathPattern: /^(?:[^/]+\/)?Jenkinsfile$/ },
  { kind: 'CircleCI', pathPattern: /^\.circleci\/config\.ya?ml$/i },
  { kind: 'Travis CI', pathPattern: /^\.travis\.ya?ml$/i },
  { kind: 'AppVeyor', pathPattern: /^\.?appveyor\.ya?ml$/i },
  { kind: 'Bitbucket Pipelines', pathPattern: /^bitbucket-pipelines\.ya?ml$/i },
]; // CI の設定ファイル（プロジェクト相対パス）。

const KEY_FILE_RULES = [
  { role: 'readme', label: '説明文書（README）', confidence: 'medium', namePattern: /^readme(?:\.[a-z0-9]+)*$/i },
  { role: 'license', label: 'ライセンス', confidence: 'medium', namePattern: /^(?:license|licence|copying)(?:[-.][\w]+)*$/i },
  { role: 'changelog', label: '変更履歴', confidence: 'medium', namePattern: /^(?:changelog|changes|history)(?:[-.][\w]+)*$/i },
  { role: 'dependencyLock', label: '依存のロックファイル', confidence: 'medium', anyCategory: true, namePattern: /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum|packages\.lock\.json)$/i },
]; // 名前の規約で役割が分かる主要ファイル（目印・CI・テスト設定は別の表で判定する）。anyCategory が無い規則は、文書か分類不明の拡張子だけに当てる。
const KEY_DIRECTORY_MAX_DEPTH = 3; // 主要ディレクトリを探す深さ。
const KEY_DIRECTORY_RULES = [
  { role: 'testDirectory', label: 'テスト用ディレクトリ', confidence: 'low', namePattern: TEST_DIRECTORY_NAME_PATTERN },
  { role: 'docsDirectory', label: '文書のディレクトリ', confidence: 'low', namePattern: /^(?:docs?|documentation)$/i },
  { role: 'ciDirectory', label: 'CI・リポジトリ設定のディレクトリ', confidence: 'low', namePattern: /^(?:\.github|\.circleci|\.gitlab)$/i },
]; // 名前の規約で役割が分かる主要ディレクトリ。

const MODULE_NAME_CONVENTIONS = new Map([
  ['src', 'ソースコード'], ['source', 'ソースコード'], ['lib', 'ライブラリ'], ['include', 'C/C++ のヘッダー'],
  ['test', 'テスト'], ['tests', 'テスト'], ['__tests__', 'テスト'], ['spec', 'テスト'], ['specs', 'テスト'], ['e2e', 'テスト（E2E）'],
  ['docs', '文書'], ['doc', '文書'], ['documentation', '文書'], ['scripts', 'スクリプト'], ['tools', '補助ツール'],
  ['assets', 'アセット（素材）'], ['examples', '使用例'], ['samples', '使用例'], ['config', '設定'], ['configs', '設定'],
  ['content', 'コンテンツ（Unreal Engine の規約ではアセット）'], ['plugins', 'プラグイン'], ['packages', 'パッケージ'],
  ['projectsettings', 'Unity のプロジェクト設定'], ['references', '参考資料'], ['.github', 'GitHub の設定（CI など）'],
  ['cmd', 'コマンド（Go の規約ではエントリーポイント）'], ['pkg', 'パッケージ（Go の規約）'], ['internal', '内部パッケージ（Go の規約）'],
  ['public', '静的ファイル'], ['static', '静的ファイル'], ['app', 'アプリケーション本体'], ['data', 'データ'], ['installer', 'インストーラー'],
]); // 最上位ディレクトリの名前の規約（小文字で引く）→ よくある役割。推測（inferred, low）として扱う。

const ENTRY_POINT_FILE_PATTERN = /^(?:main|__main__|app|index|server|cli|program)\.(?:py|js|mjs|cjs|ts|go|rs|cs)$/i; // 名前の規約でエントリーポイントらしいファイル。

const RECORD_DIRECTORY_PATTERN = /^(?:testresults|test-results|test_results|test-reports|test_reports|reports|coverage|benchmarks?|bench[\w.-]*|junit)$/i; // テスト結果・記録の候補ディレクトリ（最上位だけ見る）。
const ROOT_RECORD_FILE_PATTERN = /^(?:junit[\w.-]*\.xml|test-report[\w.-]*\.xml|test-results?[\w.-]*\.xml|TEST-[\w.-]+\.xml|[\w.-]+\.trx)$/i; // 最上位に置かれた記録ファイルの候補。

const TODO_SCAN_EXTRA_EXTENSIONS = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.cmake', '.yml', '.yaml', '.toml', '.ini', '.cfg']); // プログラム以外で TODO を探す拡張子。
const TODO_SCAN_FILE_NAMES = new Set(['makefile', 'gnumakefile', 'cmakelists.txt', 'dockerfile', 'jenkinsfile']); // 名前で TODO を探すファイル（小文字）。
const TODO_EXCLUDED_NAME_PATTERNS = [
  /\.min\./i, /\.map$/i, /\.lock$/i,
  /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|composer\.lock|gemfile\.lock|go\.sum)$/i,
]; // ソースの TODO を探さないファイル（圧縮済み・ロックファイルなど）。
const TODO_QUICK_PATTERN = /TODO|FIXME|XXX|HACK/; // 本文に印の語が 1 つも無いファイルは行ごとに調べない。
const VENDORED_DIRECTORY_PATTERN = /^(?:3rdparty|third[-_]?party|vendors?|external|extern|deps|submodules?)$/i; // 第三者のコードを置くことが多いディレクトリ名（規約による推測）。
// コメントの書き出し（// # /* * ; -- <!-- REM ::）の直後にある TODO / FIXME / XXX / HACK の印と、その後ろの本文。
const TODO_COMMENT_PATTERN = /(?:\/\/+|#+|\/\*+|^\s*\*+|^\s*;+|--|<!--|^\s*(?:REM|rem|::))\s*@?(TODO|FIXME|XXX|HACK)\b(?:\([^)]{0,40}\))?\s*[:：-]?\s*(.*)$/;

const TEMPLATE_LINES = new Set([
  'このプロジェクトの目的を記載してください。',
  '主要な言語、フレームワーク、実行環境を記載してください。',
  '重要なフォルダーやコンポーネントを記載してください。',
  '変わりにくい設計判断、品質条件、禁止事項を記載してください。',
  '人が確認した現在のフェーズ、実装済み機能、作業中の内容を記載してください。',
  '未解決事項、リスク、ChatGPTへ相談したい内容を記載してください。',
  '次に行う作業と受入条件を記載してください。',
  '現在のGit情報は `get_project_status` または `get_recent_changes` のライブ値を優先する。',
  '不明な事項を過去の会話から推測しない。',
  'まだ更新されていません。`project-bridge.ps1 -Action Update` を実行してください。',
].map(normalizeDocumentLine)); // 同梱の空欄テンプレート（assets/CHATGPT_PROJECT_*.template.md）の定型文。
const PLACEHOLDER_PATTERNS = [
  /を(?:記載|記入|入力|記述|追記)してください[。.]?$/,
  /\{\{[A-Z0-9_]+\}\}/,
  /^(?:tbd|tba|todo|未記入|未定|記入予定|準備中)[。.]?$/i,
  /^(?:write|describe|fill in|add) .{1,80} here\.?$/i,
  /^lorem ipsum/i,
  /^この文書と .+ の更新日時を確認する。$/,
]; // テンプレートの記入例・空欄の書式。
const METADATA_LINE_PATTERN = /^(?:最終確認日|最終更新日|更新日|作成日|last\s+(?:reviewed|updated))\s*[:：]/i; // 日付の記録の行（中身として数えない）。
const NON_CONTENT_PATTERNS = [/^(?:[-*_]\s*){3,}$/, /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/]; // 区切り線・表の区切り行。
const TREE_LINE_PATTERN = /^([\s│|]*)[├└+|`]\s*[─—-]{1,3}\s*(\S+)\s{2,}(\S.*)$/; // ディレクトリの木構造の 1 行（├─ 名前   説明）。1 つ目の組は入れ子の深さを表す前置き。
const NONE_LINE_PATTERN =/^(?:なし|無し|特になし|特に無し|ありません|なし。|none|n\/a|nothing)[。.]?$/i; // 「なし」を表す行（課題として拾わない）。

const DOCUMENT_FIELD_RULES = Object.freeze({
  purpose: { pattern: /(?:目的|概要|ねらい|\b(?:purpose|overview|about|goals?|summary)\b)/i },
  audience: { pattern: /(?:利用者|対象者|対象|ユーザー|読者|\b(?:audience|users?|target)\b)/i, exclude: /対象外/ },
  phase: { pattern: /(?:現在のフェーズ|フェーズ|現在状態|現状|進捗|\b(?:phase|stage|current status)\b)/i },
  implementedFeatures: { pattern: /(?:実装済|実装状況|実装されている|主な機能|機能一覧|追加した機能|できること|\b(?:implemented|features)\b)/i, exclude: /未実装/ },
  artifactLocations: { pattern: /(?:成果物|出力先|配布物|\b(?:artifacts?|outputs?|deliverables?)\b)/i },
  techStack: { pattern: /(?:技術構成|技術スタック|使用技術|\btech(?:nology)?\s*stack\b|\btechnologies\b)/i },
  modules: { pattern: /(?:主要構成|ディレクトリ構成|フォルダー構成|構成|モジュール|\b(?:architecture|structure|components|modules|layout)\b)/i, exclude: /技術構成/ },
  buildMethods: { pattern: /(?:ビルド|\bbuild(?:ing)?\b)/i },
  externalServices: { pattern: /(?:外部サービス|外部連携|連携先|\bexternal\s+services?\b|\bintegrations?\b)/i },
}); // 概要の各項目を、保存文書のどの見出しから取るか。英単語は単語の境界で照合する（unknown の known などに当てない）。
const TASK_HEADING_RULES = [
  { kind: 'doc-blocker', pattern: /(?:ブロッカー|障害|妨げ|\bblocked\b|\bblockers?\b)/i },
  { kind: 'doc-issue', pattern: /(?:課題|問題|リスク|相談|未解決|バグ|不具合|技術的負債|\bissues?\b|\brisks?\b|\bknown\b|\bbugs?\b)/i },
  { kind: 'doc-next-work', pattern: /(?:次の作業|次の(?:ステップ|タスク)|次に(?:行う|やる|すべき|取り組む)|今後|予定|未実装|残件|やること|\broadmap\b|\bnext\b|\btodo\b)/i },
]; // 課題の種類を決める見出しの語。上から順に判定する。
const TASK_HEADING_EXCLUDE_PATTERN = /相談するときの注意/; // テンプレートの「ChatGPTへ相談するときの注意」は利用上の注意で、課題の節ではない。
const TASK_KIND_ORDER = ['doc-blocker', 'doc-issue', 'doc-open-item', 'doc-next-work', 'code-todo']; // 課題の並び順。

// ---- 汎用の小さな関数 ----

// 現在時刻を ISO 8601 で返す。
function nowIso() {
  return new Date().toISOString();
}

// ミリ秒の時刻を ISO 8601 にする。数でなければ null。
function isoFromMs(milliseconds) {
  const value = Number(milliseconds);
  return Number.isFinite(value) && milliseconds !== null ? new Date(value).toISOString() : null;
}

// 文字列を比べる（並べ替え用。ロケールに依存しない）。
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// プロジェクト相対パスの最後の要素（ファイル名・ディレクトリ名）を返す。
function baseNameOf(relativePath) {
  const text = String(relativePath || '');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

// ファイル名の拡張子を小文字のドット付きで返す。拡張子が無い・先頭のドットだけ（.gitignore など）なら空文字。
function extensionOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

// 文字列を最大文字数で切り、切ったら末尾に「…」を付ける。サロゲートペアの途中では切らない。
function clipText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join('')}…`;
}

// BOM を除いて JSON を読む。読めなければ null。
function parseJsonOrNull(text) {
  try {
    const body = String(text);
    return JSON.parse(body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body);
  } catch {
    return null;
  }
}

// 重複と空を除き、上限件数で切った文字列の配列を返す。
function uniqueLimited(values, maxCount = MAX_NAMES_PER_LIST) {
  return [...new Set(values.filter(value => typeof value === 'string' && value !== ''))].slice(0, maxCount);
}

// ISO 8601 の日時から、基準時刻までの経過日数（切り捨て）を返す。読めなければ null。
function ageInDays(isoText, nowMs) {
  const parsed = Date.parse(isoText || '');
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / DAY_MS)) : null;
}

// 公開設定ファイル（.chatgpt-project-bridge.json）か。本文を読まず、構造の一覧にも出さない。
function isBridgeConfigPath(relativePath) {
  return baseNameOf(relativePath).toLowerCase() === BRIDGE_CONFIG_FILE_NAME;
}

// ファイル名から言語（またはファイルの種類）と分類を返す。表に無いものは other。
function classifyLanguage(fileName) {
  return LANGUAGE_BY_FILE_NAME.get(fileName.toLowerCase()) || LANGUAGE_BY_EXTENSION.get(extensionOf(fileName)) || OTHER_LANGUAGE;
}

/*
  ファイルの一覧を言語ごとに数え、件数の多い順に { language, category, files, bytes } で返す。
  .ts は Qt の翻訳ファイルにも使われるので、JS/TS の目印（package.json・tsconfig・deno.json）が無ければ「判別できない」として数える。
*/
function summarizeLanguages(fileEntries) {
  const scriptEcosystem = fileEntries.some(entry => SCRIPT_ECOSYSTEM_FILE_PATTERN.test(baseNameOf(entry.path))); // JS/TS の目印があるか。
  const byLanguage = new Map(); // 言語 → 集計。
  for (const entry of fileEntries) {
    const name = baseNameOf(entry.path);
    const { language, category } = !scriptEcosystem && extensionOf(name) === '.ts' ? AMBIGUOUS_TS_LANGUAGE : classifyLanguage(name);
    const bucket = byLanguage.get(language) || { language, category, files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += Number(entry.size) || 0;
    byLanguage.set(language, bucket);
  }
  return [...byLanguage.values()].sort((left, right) => right.files - left.files || right.bytes - left.bytes || compareText(left.language, right.language));
}

// ファイルごとのサイズを、起点より下の各ディレクトリへ足し合わせる。戻り値: ディレクトリのパス → { files, bytes }。
function aggregateDirectories(fileEntries, startPath) {
  const totals = new Map(); // ディレクトリ → 集計。
  const prefixLength = startPath ? startPath.length : 0; // 起点のパスの長さ。起点そのものは数えない。
  for (const entry of fileEntries) {
    let slash = entry.path.lastIndexOf('/');
    while (slash > prefixLength) {
      const directory = entry.path.slice(0, slash);
      const bucket = totals.get(directory) || { files: 0, bytes: 0 };
      bucket.files += 1;
      bucket.bytes += Number(entry.size) || 0;
      totals.set(directory, bucket);
      slash = entry.path.lastIndexOf('/', slash - 1);
    }
  }
  return totals;
}

// 文書・設定・測定値に書かれている項目を作る。
function knownItem(value, evidence = [], extra = {}) {
  return { value, status: 'known', evidence, ...extra };
}

// 規約や名前からの推測の項目を作る。basis に理由、confidence に確度（low / medium）。
function inferredItem(value, basis, confidence, evidence = [], extra = {}) {
  return { value, status: 'inferred', confidence, basis, evidence, ...extra };
}

// 根拠が無い項目を作る。value は必ず null。
function unknownItem(note, extra = {}) {
  return { value: null, status: 'unknown', evidence: [], ...(note ? { note } : {}), ...extra };
}

// 一覧の項目の状態から、まとめの状態（known > inferred > unknown）を決める。
function overallStatus(items) {
  if (items.some(item => item.status === 'known')) return 'known';
  if (items.some(item => item.status === 'inferred')) return 'inferred';
  return 'unknown';
}

// ---- 文書（Markdown）の解析 ----

// 文書の 1 行を比較用に整える（前後の空白・引用・箇条書きの記号・チェックボックスを除き、空白を 1 つにまとめる）。
function normalizeDocumentLine(text) {
  return String(text || '').trim()
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 文書の 1 行が、空欄テンプレートの定型文・記入例の書式か。
function isTemplateLine(text) {
  const normalized = normalizeDocumentLine(text);
  if (!normalized) return false;
  return TEMPLATE_LINES.has(normalized) || PLACEHOLDER_PATTERNS.some(pattern => pattern.test(normalized));
}

// 文書の 1 行が、人が書いた中身として数えられるか（空行・定型文・日付の記録・区切り線・自動収集の区間を除く）。
function isContentLine(entry) {
  if (entry.auto) return false;
  if (entry.code) return entry.text.trim() !== '';
  const normalized = normalizeDocumentLine(entry.text);
  if (!normalized || isTemplateLine(entry.text) || METADATA_LINE_PATTERN.test(normalized)) return false;
  return !NON_CONTENT_PATTERNS.some(pattern => pattern.test(entry.text.trim()));
}

/*
  Markdown を見出しと本文の行に分ける。見出しの入れ子は、各行が属する見出しの列（stack）で表す。
  コードブロックの中は見出しとして扱わず、code: true の行にする。HTML コメントは読み飛ばし、
  <!-- AUTO:BEGIN ... --> から <!-- AUTO:END ... --> までは自動収集の区間（auto: true）として印を付ける。
  戻り値: { headings: [{ level, text, line, auto }], lines: [{ line, text, code, auto, stack }] }
*/
function parseMarkdown(text) {
  const headings = []; // 見出しの一覧。
  const lines = []; // 見出し以外の行。
  const stack = []; // 現在の行が属する見出しの列（外側から内側へ）。
  let fence = null; // コードブロックの開始記号。ブロック外なら null。
  let inAuto = false; // 自動収集の区間の中か。
  let inComment = false; // 複数行の HTML コメントの中か。
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    if (inComment) {
      if (raw.includes('-->')) inComment = false;
      return;
    }
    if (fence) {
      if (raw.trim().startsWith(fence)) { fence = null; return; }
      lines.push({ line: lineNumber, text: raw, code: true, auto: inAuto, stack: stack.slice() });
      return;
    }
    const fenceMatch = /^\s*(```|~~~)/.exec(raw);
    if (fenceMatch) { fence = fenceMatch[1]; return; }
    const autoMarkers = [...raw.matchAll(/<!--\s*AUTO:(BEGIN|END)\b/gi)]; // 1 行に BEGIN と END が並ぶこともある（例: 更新日時の埋め込み）。
    if (autoMarkers.length > 0) {
      inAuto = autoMarkers[autoMarkers.length - 1][1].toUpperCase() === 'BEGIN'; // 行の最後の印で、次の行からの状態が決まる。
      return; // 印のある行は自動収集の値を含むので、中身として数えない。
    }
    if (/^\s*<!--/.test(raw)) {
      if (!raw.includes('-->')) inComment = true;
      return;
    }
    const headingMatch = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(raw);
    if (headingMatch) {
      const heading = { level: headingMatch[1].length, text: headingMatch[2].trim(), line: lineNumber, auto: inAuto };
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
      headings.push(heading);
      return;
    }
    lines.push({ line: lineNumber, text: raw, code: false, auto: inAuto, stack: stack.slice() });
  });
  return { headings, lines };
}

/*
  公開許可された文書 1 件を解析する。節ごとに、人が書いた中身があるか（filled）を調べ、
  文書全体が空欄テンプレートのままか（templateUnfilled）を判定する。
  templateUnfilled は「中身の行が 1 つも無く、テンプレートの定型文が 1 つ以上ある」とき true。自動収集の区間は中身に数えない。
*/
function analyzeDocument(document) {
  const parsed = parseMarkdown(document.text);
  const sections = parsed.headings.filter(heading => !heading.auto).map(heading => {
    const body = parsed.lines.filter(entry => !entry.auto && entry.stack.includes(heading)); // 見出しの下の行（下位の見出しの中を含む）。
    const contentLines = body.filter(entry => isContentLine(entry));
    return { heading, contentLines, filled: contentLines.length > 0 };
  });
  const visibleLines = parsed.lines.filter(entry => !entry.auto); // 自動収集の区間を除いた行。
  const hasContent = visibleLines.some(entry => isContentLine(entry));
  const templateLineCount = visibleLines.filter(entry => !entry.code && (isTemplateLine(entry.text) || /\{\{[A-Z0-9_]+\}\}/.test(entry.text))).length
    + parsed.headings.filter(heading => /\{\{[A-Z0-9_]+\}\}/.test(heading.text)).length;
  const reviewLine = visibleLines.find(entry => /^最終確認日\s*[:：]/.test(entry.text.trim())); // テンプレートが作成時に入れる日付の行。
  const reviewDate = reviewLine ? /^最終確認日\s*[:：]\s*(\S+)/.exec(reviewLine.text.trim())?.[1] || null : null;
  return {
    path: document.path,
    title: document.title,
    modified: document.modified,
    parsed,
    sections,
    hasContent,
    templateUnfilled: !hasContent && templateLineCount > 0,
    statedReviewDate: reviewDate && !/\{\{/.test(reviewDate) ? reviewDate : null,
  };
}

// 節の中身の行をつないだ本文を返す（上限で切る）。
function sectionText(section, maxChars = SECTION_TEXT_MAX_CHARS) {
  return clipText(section.contentLines.map(entry => entry.text.trim()).join('\n').trim(), maxChars);
}

/*
  文書の一覧から、見出しが規則に合う節を探す。見出しのレベル 1（表題）は対象にしない。
  中身のある節を優先し、無ければ未記入の節（filled: false）を返す。どちらも無ければ null。
*/
function findDocumentSection(analyses, rule) {
  let unfilled = null; // 最初に見つかった未記入の節。
  for (const analysis of analyses) {
    for (const section of analysis.sections) {
      if (section.heading.level < 2) continue;
      const headingText = section.heading.text;
      if (!rule.pattern.test(headingText) || (rule.exclude && rule.exclude.test(headingText))) continue;
      if (section.filled) return { analysis, section, filled: true };
      unfilled ??= { analysis, section, filled: false };
    }
  }
  return unfilled;
}

// 文書の節を指す根拠を作る。
function documentEvidence(found) {
  return { type: 'document', path: found.analysis.path, heading: found.section.heading.text, line: found.section.heading.line };
}

/*
  文書の節から概要の 1 項目を作る。中身のある節なら known（根拠に文書と見出し）、
  見出しはあるが空欄テンプレートのままなら unknown（templateUnfilled: true）、見出しが無ければ unknown。
*/
function documentFieldItem(analyses, rule, missingNote, maxChars = SECTION_TEXT_MAX_CHARS) {
  const found = findDocumentSection(analyses, rule);
  if (found?.filled) {
    return knownItem(sectionText(found.section, maxChars), [documentEvidence(found)], { sourceKind: SOURCE_KIND.DOCUMENT, sourceUpdatedAt: found.analysis.modified });
  }
  if (found) {
    return unknownItem('該当する節はあるが、空欄テンプレートのまま（未記入）。', { templateUnfilled: true, checked: [{ path: found.analysis.path, heading: found.section.heading.text }] });
  }
  return unknownItem(missingNote || '公開許可された文書に、該当する見出しの節が見つからない。');
}

// README の最初の段落（表題の直後、最初の小見出しより前）を返す。画像・バッジ・表・定型文は除く。無ければ null。
function readmeFirstParagraph(analysis) {
  const collected = []; // 段落の行。
  let started = false; // 段落の途中か。
  for (const entry of analysis.parsed.lines) {
    if (entry.stack.some(heading => heading.level >= 2)) break;
    if (entry.code || entry.auto) continue;
    const trimmed = entry.text.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    if (/^(?:!\[|\[!\[|<|\|)/.test(trimmed) || !isContentLine(entry)) continue;
    collected.push(trimmed);
    started = true;
  }
  return collected.length > 0 ? collected.join(' ') : null;
}

// 表の行のうち、直後が区切り行のもの（見出し行）の行番号を集める。
function tableHeaderLineNumbers(lines) {
  const headers = new Set(); // 見出し行の行番号。
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const current = lines[index].text.trim();
    const next = lines[index + 1].text.trim();
    if (current.startsWith('|') && NON_CONTENT_PATTERNS[1].test(next)) headers.add(lines[index].line);
  }
  return headers;
}

// 表の行をセルの配列にする。区切り行・見出し行・表でない行は null。
function tableCells(entry, headerLines) {
  const trimmed = entry.text.trim();
  if (!trimmed.startsWith('|') || headerLines.has(entry.line) || NON_CONTENT_PATTERNS[1].test(trimmed)) return null;
  const cells = trimmed.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
  return cells.some(cell => cell !== '') ? cells : null;
}

/*
  文書の「主要構成」などの節から、名前（パス）と役割の対を取り出す。次の 3 つの書き方を読む。
  表の行（| 名前 | 役割 |）、`名前`: 役割 の形の箇条書き、コードブロックの木構造の最上位の行（├─ 名前/   役割）。
*/
function parseDocumentedModules(found) {
  const results = []; // { name, role, status, evidence }
  const headerLines = tableHeaderLineNumbers(found.section.contentLines);
  for (const entry of found.section.contentLines) {
    let name = null; // 文書に書かれた名前。
    let role = null; // 文書に書かれた役割。
    const cells = entry.code ? null : tableCells(entry, headerLines);
    if (entry.code) {
      const tree = TREE_LINE_PATTERN.exec(entry.text);
      if (!tree || tree[1].replace(/\s/g, '') !== '') continue; // 木構造の最上位の行だけを読む（入れ子の行は親の補足）。
      name = tree[2];
      role = tree[3];
    } else if (cells && cells.length >= 2) {
      name = /`([^`]+)`/.exec(cells[0])?.[1] || cells[0];
      role = cells.slice(1).filter(Boolean).join(' / ');
    } else {
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(entry.text);
      if (!bullet) continue;
      const codeName = /^`([^`]+)`(.*)$/.exec(bullet[1]);
      if (codeName) {
        name = codeName[1];
        role = codeName[2];
      } else {
        const plain = /^([\w.\-/]+\/?)\s*[:：—–]\s*(.+)$/.exec(bullet[1]);
        if (!plain) continue;
        name = plain[1];
        role = plain[2];
      }
    }
    role = String(role || '').replace(/^[\s:：—–\-・、#]+/, '').trim();
    name = String(name || '').replace(/^\.\//, '').trim();
    if (!name || !role) continue;
    results.push({ name: clipText(name, 120), role: clipText(role, 200), status: 'known', evidence: [documentEvidence(found)] });
    if (results.length >= 50) break;
  }
  return results;
}

// 見出しの列（外側から内側）から、課題の種類を決める。内側の見出しを優先する。どれにも当たらなければ null。
function classifyTaskHeadingStack(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const heading = stack[index];
    if (TASK_HEADING_EXCLUDE_PATTERN.test(heading.text)) return null;
    const rule = TASK_HEADING_RULES.find(candidate => candidate.pattern.test(heading.text));
    if (rule) return { kind: rule.kind, heading };
  }
  return null;
}

// 行頭の空白の幅を返す（タブは 4 として数える）。
function indentWidth(prefix) {
  return [...String(prefix || '')].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
}

// ---- マニフェスト・記録ファイルの解析（本文は boundary が秘密値を伏せたもの）----

// package.json の本文から、名前・エントリーポイント・scripts・依存の名前を取り出す。JSON として読めなければ null。
function parsePackageJson(text) {
  const data = parseJsonOrNull(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  // オブジェクトのうち、値が文字列の項目だけを残す。オブジェクトでなければ空。
  const stringMap = value => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string'))
    : {});
  // オブジェクトのキーの一覧を返す。オブジェクトでなければ空。
  const keysOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);
  const bin = typeof data.bin === 'string' ? { [typeof data.name === 'string' ? data.name : '(既定)']: data.bin } : stringMap(data.bin);
  return {
    ecosystemName: typeof data.name === 'string' ? data.name : null,
    main: typeof data.main === 'string' ? data.main : null,
    module: typeof data.module === 'string' ? data.module : null,
    bin,
    scripts: stringMap(data.scripts),
    runtimeDependencies: keysOf(data.dependencies),
    developmentDependencies: [...keysOf(data.devDependencies), ...keysOf(data.optionalDependencies), ...keysOf(data.peerDependencies)],
    engines: stringMap(data.engines),
  };
}

// .uproject（JSON）から、EngineAssociation・モジュール・有効なプラグインを取り出す。
function parseUproject(text) {
  const data = parseJsonOrNull(text);
  if (!data || typeof data !== 'object') return null;
  const modules = Array.isArray(data.Modules) ? data.Modules.filter(item => typeof item?.Name === 'string').map(item => ({ name: item.Name, type: typeof item.Type === 'string' ? item.Type : null })) : [];
  const plugins = Array.isArray(data.Plugins) ? data.Plugins.filter(item => typeof item?.Name === 'string' && item.Enabled !== false).map(item => item.Name) : [];
  return {
    engineAssociation: typeof data.EngineAssociation === 'string' ? data.EngineAssociation : null,
    modules: modules.slice(0, MAX_NAMES_PER_LIST),
    runtimeDependencies: plugins,
    developmentDependencies: [],
  };
}

// Unity の ProjectVersion.txt から、エディターのバージョンを取り出す。
function parseUnityVersion(text) {
  return { editorVersion: /m_EditorVersion:\s*(\S+)/.exec(text)?.[1] || null };
}

// Godot の project.godot から、名前・機能（エンジンの版を含む）・メインシーンを取り出す。
function parseGodotProject(text) {
  const featureText = /^\s*config\/features\s*=\s*PackedStringArray\(([^)]*)\)/m.exec(text)?.[1] || '';
  return {
    projectTitle: /^\s*config\/name\s*=\s*"([^"]*)"/m.exec(text)?.[1] || null,
    features: [...featureText.matchAll(/"([^"]*)"/g)].map(match => match[1]),
    mainScene: /^\s*run\/main_scene\s*=\s*"([^"]*)"/m.exec(text)?.[1] || null,
  };
}

// CMakeLists.txt から、project 名・実行ファイル・ライブラリ・テストの有無・find_package を取り出す。
function parseCmakeLists(text) {
  const body = String(text).replace(/#[^\n]*/g, ''); // コメントを除く。
  const projectTitle = /\bproject\s*\(\s*([A-Za-z0-9_.+-]+)/i.exec(body)?.[1] || null; // project() の名前。
  // ${PROJECT_NAME} などは、同じファイルの project() の名前が分かるときだけ置き換える（ほかの変数は書かれたまま）。
  const expand = name => (projectTitle ? name.replace(/\$\{(?:PROJECT_NAME|CMAKE_PROJECT_NAME)\}/g, projectTitle) : name);
  // 命令（add_executable など）の最初の引数を、重複なく集める。
  const namesOf = pattern => uniqueLimited([...body.matchAll(pattern)].map(match => expand(match[1])));
  return {
    projectTitle,
    minimumVersion: /\bcmake_minimum_required\s*\(\s*VERSION\s+([0-9.]+)/i.exec(body)?.[1] || null,
    executables: namesOf(/\badd_executable\s*\(\s*([A-Za-z0-9_.+:${}-]+)/gi),
    libraries: namesOf(/\badd_library\s*\(\s*([A-Za-z0-9_.+:${}-]+)/gi),
    testing: /\benable_testing\s*\(/i.test(body) || /\badd_test\s*\(/i.test(body),
    testCount: [...body.matchAll(/\badd_test\s*\(/gi)].length,
    runtimeDependencies: namesOf(/\bfind_package\s*\(\s*([A-Za-z0-9_.+-]+)/gi),
    developmentDependencies: [],
  };
}

// TOML の 1 行から、引用符の外にある # 以降（コメント）を除く。
function stripTomlComment(line) {
  let quote = null; // 引用符の中ならその文字。
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

// 引用符の外の括弧（[ と {）の開き過ぎの数を返す。複数行の配列が閉じたかの判定に使う。
function bracketBalance(value) {
  let balance = 0; // 開き括弧の数 − 閉じ括弧の数。
  let quote = null; // 引用符の中ならその文字。
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '{') balance += 1;
    else if (character === ']' || character === '}') balance -= 1;
  }
  return balance;
}

/*
  TOML を、節ごとのキーと生の値へ大まかに分ける（完全な TOML の解析器ではない）。
  表の配列（[[bin]] など）は「名前#連番」の節にする。複数行の配列・インラインテーブルは 1 つの値にまとめる。
  戻り値: Map（節名 → Map（キー → 生の値の文字列））。先頭の節名は空文字。
*/
function parseTomlLite(text) {
  const sections = new Map([['', new Map()]]);
  const arrayCounters = new Map(); // 表の配列の名前 → これまでの件数。
  let current = ''; // 現在の節名。
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    const arrayTable = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
    if (arrayTable) {
      const count = arrayCounters.get(arrayTable[1]) || 0;
      arrayCounters.set(arrayTable[1], count + 1);
      current = `${arrayTable[1]}#${count}`;
      sections.set(current, new Map());
      continue;
    }
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (table) {
      current = table[1].replace(/\s+/g, '');
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const keyValue = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line);
    if (!keyValue) continue;
    let value = keyValue[2]; // 生の値。
    while (bracketBalance(value) > 0 && index + 1 < lines.length) {
      index += 1;
      value += `\n${stripTomlComment(lines[index])}`;
    }
    sections.get(current).set(keyValue[1].replace(/^["']|["']$/g, ''), value.trim());
  }
  return sections;
}

// TOML の生の値から、文字列をすべて取り出す。
function tomlStrings(raw) {
  return [...String(raw || '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(match => match[1] ?? match[2]);
}

// TOML の生の値から、最初の文字列を取り出す。無ければ null。
function tomlString(raw) {
  return tomlStrings(raw)[0] ?? null;
}

// 依存の指定（例: "fastapi>=0.1"）からパッケージ名だけを取り出す。
function dependencyNamesFromSpecs(specs) {
  return specs.map(spec => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1]).filter(Boolean);
}

// pyproject.toml から、名前・依存・scripts・ビルドの方式・pytest の設定の有無を取り出す。
function parsePyproject(text) {
  const sections = parseTomlLite(text);
  const project = sections.get('project') || new Map();
  const poetry = sections.get('tool.poetry') || new Map();
  const runtime = dependencyNamesFromSpecs(tomlStrings(project.get('dependencies')));
  runtime.push(...[...(sections.get('tool.poetry.dependencies') || new Map()).keys()].filter(name => name.toLowerCase() !== 'python'));
  const development = []; // 開発用・任意の依存。
  const scripts = {}; // コマンド名 → 呼び出し先（モジュール:関数）。
  for (const [sectionName, values] of sections) {
    if (sectionName === 'project.optional-dependencies' || sectionName === 'dependency-groups') {
      for (const raw of values.values()) development.push(...dependencyNamesFromSpecs(tomlStrings(raw)));
    }
    if (/^tool\.poetry\.(?:dev-dependencies|group\.[^.]+\.dependencies)$/.test(sectionName)) development.push(...values.keys());
    if (sectionName === 'project.scripts' || sectionName === 'tool.poetry.scripts') {
      for (const [key, raw] of values) scripts[key] = tomlString(raw) || '';
    }
  }
  return {
    ecosystemName: tomlString(project.get('name') ?? poetry.get('name') ?? ''),
    requiresPython: tomlString(project.get('requires-python') ?? ''),
    runtimeDependencies: uniqueLimited(runtime, 200),
    developmentDependencies: uniqueLimited(development, 200),
    scripts,
    hasBuildSystem: sections.has('build-system'),
    buildBackend: tomlString(sections.get('build-system')?.get('build-backend') ?? ''),
    pytestConfigured: sections.has('tool.pytest.ini_options') || sections.has('tool.pytest'),
  };
}

// requirements.txt から、パッケージ名を取り出す（オプション行・URL・コメントは除く）。
function parseRequirements(text) {
  const names = String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(line));
  return { runtimeDependencies: uniqueLimited(dependencyNamesFromSpecs(names), 200), developmentDependencies: [] };
}

// Cargo.toml から、パッケージ名・edition・依存・バイナリ・ライブラリの有無を取り出す。
function parseCargoManifest(text) {
  const sections = parseTomlLite(text);
  const packageSection = sections.get('package') || new Map();
  const runtime = [...(sections.get('dependencies') || new Map()).keys()];
  const development = [...(sections.get('dev-dependencies') || new Map()).keys(), ...(sections.get('build-dependencies') || new Map()).keys()];
  for (const sectionName of sections.keys()) {
    const dotted = /^(dependencies|dev-dependencies|build-dependencies)\.(.+)$/.exec(sectionName);
    if (dotted) (dotted[1] === 'dependencies' ? runtime : development).push(dotted[2]);
  }
  const binaries = [...sections.keys()].filter(name => name.startsWith('bin#')).map(name => tomlString(sections.get(name).get('name') ?? '')).filter(Boolean);
  return {
    ecosystemName: tomlString(packageSection.get('name') ?? ''),
    edition: tomlString(packageSection.get('edition') ?? ''),
    runtimeDependencies: uniqueLimited(runtime, 200),
    developmentDependencies: uniqueLimited(development, 200),
    binaries,
    hasLibrary: sections.has('lib'),
    workspace: sections.has('workspace'),
  };
}

// go.mod から、モジュール名・Go の版・直接の依存を取り出す。
function parseGoMod(text) {
  const direct = []; // 直接の依存。
  let indirectCount = 0; // 間接の依存の数。
  // require の 1 行を、直接の依存か間接の依存（// indirect）として数える。
  const addRequirement = line => {
    const match = /^\s*([^\s()]+)\s+(\S+)/.exec(line);
    if (!match || match[1] === 'require') return;
    if (/\/\/\s*indirect/.test(line)) indirectCount += 1;
    else direct.push(match[1]);
  };
  for (const block of String(text).matchAll(/^\s*require\s*\(([\s\S]*?)^\s*\)/gm)) block[1].split(/\r?\n/).forEach(addRequirement);
  for (const single of String(text).matchAll(/^\s*require\s+([^\s(][^\r\n]*)$/gm)) addRequirement(single[1]);
  return {
    ecosystemName: /^\s*module\s+(\S+)/m.exec(text)?.[1] || null,
    goVersion: /^\s*go\s+(\S+)/m.exec(text)?.[1] || null,
    runtimeDependencies: uniqueLimited(direct, 200),
    developmentDependencies: [],
    indirectDependencyCount: indirectCount,
  };
}

// MSBuild のプロジェクトファイル（.csproj・.vcxproj など）から、SDK・TargetFramework・OutputType・PackageReference などを取り出す。
function parseMsbuildProject(text) {
  // 要素（<Tag>値</Tag>）の最初の値を返す。無ければ null。
  const tagValue = tag => new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i').exec(text)?.[1]?.trim() || null;
  const frameworks = (tagValue('TargetFrameworks') || tagValue('TargetFramework') || '').split(';').map(item => item.trim()).filter(Boolean);
  return {
    sdk: /<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(text)?.[1] || null,
    targetFrameworks: frameworks,
    outputType: tagValue('OutputType'),
    configurationType: tagValue('ConfigurationType'),
    assemblyName: tagValue('AssemblyName'),
    useWpf: /<UseWPF>\s*true\s*</i.test(text),
    useWindowsForms: /<UseWindowsForms>\s*true\s*</i.test(text),
    runtimeDependencies: uniqueLimited([...String(text).matchAll(/<PackageReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi)].map(match => match[1]), 200),
    developmentDependencies: [],
  };
}

// Makefile から、ターゲット名を取り出す（. で始まる特殊ターゲット・% の型ルール・変数の代入は除く）。
function parseMakefile(text) {
  const targets = []; // ターゲット名。
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s/.test(line) || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_./%-][A-Za-z0-9_./%\s-]*?)\s*:(?![=:])/.exec(line);
    if (!match) continue;
    for (const target of match[1].trim().split(/\s+/)) {
      if (target && !target.startsWith('.') && !target.includes('%')) targets.push(target);
    }
  }
  return { targets: uniqueLimited(targets) };
}

// XML の開始タグの属性を、名前 → 値のオブジェクトにする。
function parseXmlAttributes(attributeText) {
  const attributes = {};
  for (const match of String(attributeText || '').matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1]] = match[2] ?? match[3];
  return attributes;
}

// 数として読める値なら数、そうでなければ null。
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// JUnit XML の testsuites / testsuite から、件数・失敗・スキップ・時間・timestamp を取り出す。JUnit の形でなければ null。
function parseJunitRecord(text) {
  const suitesTag = /<testsuites\b([^>]*)>/i.exec(text);
  const suites = [...String(text).matchAll(/<testsuite\b([^>]*?)\/?>/gi)].map(match => parseXmlAttributes(match[1]));
  if (!suitesTag && suites.length === 0) return null;
  const top = suitesTag ? parseXmlAttributes(suitesTag[1]) : {};
  // testsuite の属性を全部足す。
  const sum = key => suites.reduce((total, attributes) => total + (numberOrNull(attributes[key]) ?? 0), 0);
  // testsuites の属性があればそれを、無ければ testsuite の合計を使う。
  const pick = key => numberOrNull(top[key]) ?? (suites.length > 0 ? sum(key) : null);
  const total = pick('tests');
  const failures = pick('failures') ?? 0;
  const errors = pick('errors') ?? 0;
  const skipped = pick('skipped') ?? pick('disabled') ?? 0;
  return {
    total,
    failed: failures + errors,
    skipped,
    passed: total === null ? null : Math.max(0, total - failures - errors - skipped),
    durationSeconds: pick('time'),
    timestamp: top.timestamp || suites.find(attributes => attributes.timestamp)?.timestamp || null,
    suites: suites.length,
  };
}

// TRX（Visual Studio のテスト結果）の Counters と Times から、件数と日時を取り出す。TRX の形でなければ null。
function parseTrxRecord(text) {
  const counters = /<Counters\b([^>]*)\/?>/i.exec(text);
  if (!counters) return null;
  const attributes = parseXmlAttributes(counters[1]);
  const times = parseXmlAttributes(/<Times\b([^>]*)\/?>/i.exec(text)?.[1] || '');
  const failed = (numberOrNull(attributes.failed) ?? 0) + (numberOrNull(attributes.error) ?? 0) + (numberOrNull(attributes.timeout) ?? 0) + (numberOrNull(attributes.aborted) ?? 0);
  return {
    total: numberOrNull(attributes.total),
    executed: numberOrNull(attributes.executed),
    passed: numberOrNull(attributes.passed),
    failed,
    skipped: numberOrNull(attributes.notExecuted),
    outcome: /<ResultSummary\b[^>]*\boutcome\s*=\s*"([^"]+)"/i.exec(text)?.[1] || null,
    timestamp: times.finish || times.start || times.creation || null,
  };
}

// coverage-summary.json（istanbul の json-summary）から、全体の網羅率（%）を取り出す。形が違えば null。
function parseCoverageSummary(text) {
  const data = parseJsonOrNull(text);
  if (!data?.total || typeof data.total !== 'object') return null;
  // 全体の網羅率（%）を 1 つ読む。
  const percent = key => numberOrNull(data.total[key]?.pct);
  return { linesPct: percent('lines'), statementsPct: percent('statements'), branchesPct: percent('branches'), functionsPct: percent('functions') };
}

// ファイル名と置き場所から、記録ファイルの種類を決める。記録ではなさそうなら null。
function classifyRecordFile(fileName, directoryName) {
  if (/\.trx$/i.test(fileName)) return 'trx';
  if (/^coverage-summary\.json$/i.test(fileName)) return 'coverage';
  if (/^(?:lcov\.info|coverage\.xml|cobertura[\w.-]*\.xml|clover\.xml|coverage-final\.json)$/i.test(fileName)) return 'coverage';
  if (/\.xml$/i.test(fileName) && (directoryName || /(?:junit|test)/i.test(fileName))) return 'junit';
  if (directoryName && /^bench/i.test(directoryName) && /\.(?:json|csv|txt|md|log)$/i.test(fileName)) return 'benchmark';
  return null;
}

// テストファイルらしいか（名前の規約、またはテスト用ディレクトリの下のプログラム）を判定する。
function isTestFile(entry) {
  if (entry.kind !== 'file') return false;
  const name = baseNameOf(entry.path);
  if (TEST_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return true;
  const segments = entry.path.split('/').slice(0, -1);
  return segments.some(segment => TEST_DIRECTORY_NAME_PATTERN.test(segment)) && classifyLanguage(name).category === 'programming';
}

// ソースの TODO を探す対象のファイルか（プログラムなどの拡張子。圧縮済み・ロックファイル・公開設定ファイルは除く）。
function isTodoScanTarget(entry) {
  if (entry.kind !== 'file' || isBridgeConfigPath(entry.path)) return false;
  const name = baseNameOf(entry.path);
  if (TODO_EXCLUDED_NAME_PATTERNS.some(pattern => pattern.test(name))) return false;
  if (TODO_SCAN_FILE_NAMES.has(name.toLowerCase())) return true;
  const extension = extensionOf(name);
  return classifyLanguage(name).category === 'programming' || TODO_SCAN_EXTRA_EXTENSIONS.has(extension);
}

// 目印の規則に合うか（ファイル名またはパス）。
function matchesMarkerRule(rule, entry) {
  return rule.namePattern ? rule.namePattern.test(baseNameOf(entry.path)) : rule.pathPattern.test(entry.path);
}

// path 引数を検証し、プロジェクト相対のディレクトリ（/ 区切り）にする。親参照・絶対パス・ドライブ指定は invalid_argument。
function normalizeStartPath(value) {
  const text = requireString(value, 'path', { maxLength: 512, fallback: null });
  if (text === null) return null;
  const slashed = text.trim().replace(/\\/g, '/');
  if (slashed.includes('\0') || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'path はプロジェクト相対のパスで指定してください（絶対パスは使えません）。');
  }
  const segments = slashed.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'path に親ディレクトリ（..）は使えません。');
  return segments.length === 0 ? null : segments.join('/');
}

/*
  分析層を作る。server.mjs が呼び出しごとに作るので、走査と文書の結果はこのオブジェクトの中でだけ使い回す。
  引数: dependencies = { projectName, osName, boundary, documents }（形は server.mjs の createAnalyzerForCall を参照）
  戻り値: { getStructure, getOverview, getTasks, getValidation, getPortfolioEntry }
*/
export function createAnalyzer(dependencies) {
  const projectName = String(dependencies?.projectName ?? ''); // 表示用のプロジェクト名。
  const osName = String(dependencies?.osName ?? ''); // 'windows' | 'linux' など。
  const boundary = dependencies?.boundary; // 公開境界の関数群。
  const documentStore = dependencies?.documents; // 公開許可された文書の読み取り。
  const exposure = Object.freeze({
    paths: boundary?.exposure?.paths === true,
    sourceText: boundary?.exposure?.sourceText === true,
    branchNames: boundary?.exposure?.branchNames === true,
  }); // 権限。キーが無ければ非公開。
  const walkCache = new Map(); // 走査の条件 → 結果。
  let documentCache = null; // 読み込んだ文書。

  // 1 回の応答の中で集める付随情報（隠した項目・注意・打ち切り・使った文書）を作る。
  function newCollection() {
    return { hidden: new Set(), warnings: [], truncated: false, usedDocuments: new Map(), configModified: [], filesRead: 0, readFailures: 0 };
  }

  /*
    公開境界の走査を呼ぶ。同じ条件の走査は使い回す。公開設定ファイルは結果から除き、隠した件数に数える。
    引数: options（boundary.walk に渡す）、rethrowInvalidArgument（利用者の path 引数の不備を invalid_argument として投げ直すか）
    戻り値: { ok: true, startPath, entries, truncated, counts, excludedDirectoryNames } または { ok: false, errorClass }
  */
  function walkProject(options, { rethrowInvalidArgument = false } = {}) {
    const key = JSON.stringify([options.maxDepth, options.maxEntries, options.startPath || '', Boolean(options.includeExcludedDirectories)]);
    if (walkCache.has(key)) return walkCache.get(key);
    let outcome; // 走査の結果。
    try {
      const raw = boundary.walk({ ...options, startPath: options.startPath || undefined });
      const rawEntries = Array.isArray(raw?.entries) ? raw.entries : [];
      const entries = rawEntries.filter(entry => !isBridgeConfigPath(entry.path));
      outcome = {
        ok: true,
        startPath: raw?.startPath || '',
        entries,
        truncated: raw?.truncated === true,
        counts: {
          hidden: Number(raw?.counts?.hidden || 0) + (rawEntries.length - entries.length),
          links: Number(raw?.counts?.links || 0),
          excludedDirectories: Number(raw?.counts?.excludedDirectories || 0),
          unreadable: Number(raw?.counts?.unreadable || 0),
        },
        excludedDirectoryNames: Array.isArray(raw?.excludedDirectoryNames) ? raw.excludedDirectoryNames : [],
      };
    } catch (error) {
      if (rethrowInvalidArgument && error instanceof BridgeToolError && error.errorClass === ERROR_CLASS.INVALID_ARGUMENT) throw error;
      outcome = { ok: false, errorClass: error instanceof BridgeToolError ? error.errorClass : ERROR_CLASS.INTERNAL };
    }
    walkCache.set(key, outcome);
    return outcome;
  }

  /*
    プロジェクト全体を、既定の除外ありで走査する。境界の走査は深さ優先で、前のディレクトリ（例: 大量の画像・アセット）で
    件数の上限を使い切ると、後ろの src や tests に届かない。そこで 1 回の走査が上限に当たったときだけ、
    最上位のディレクトリごとに件数の枠を分けて走査し直す（walkByTopDirectory）。
  */
  function walkRoot(maxDepth = STRUCTURE_WALK_DEPTH, maxEntries = STRUCTURE_WALK_ENTRIES) {
    const key = `byTopDirectory|${maxDepth}|${maxEntries}`; // 分けて走査した結果の使い回しの鍵。
    if (walkCache.has(key)) return walkCache.get(key);
    const single = walkProject({ maxDepth, maxEntries, includeExcludedDirectories: false });
    let outcome = single; // 返す走査結果。
    if (single.ok && single.truncated && maxDepth > 1) {
      const top = walkProject({ maxDepth: 1, maxEntries, includeExcludedDirectories: false });
      if (top.ok && !top.truncated) outcome = walkByTopDirectory(top, maxDepth, maxEntries);
    }
    walkCache.set(key, outcome);
    return outcome;
  }

  /*
    最上位のディレクトリごとに、件数の枠を等分して走査し、結果を 1 つにまとめる。
    枠を使い切らなかったぶんは、上限に当たったディレクトリへ 1 回だけ配り直す。深さはプロジェクトのルートからの深さに直す。
    戻り値: walkProject と同じ形に、splitByTopDirectory（分けたディレクトリの数と、途中までになったディレクトリ）を足したもの。
  */
  function walkByTopDirectory(top, maxDepth, maxEntries) {
    const directories = top.entries.filter(entry => entry.kind === 'directory' && !entry.excluded);
    const budget = Math.max(0, maxEntries - top.entries.length); // 最上位を除いた残りの枠。
    const share = Math.max(SPLIT_WALK_MIN_SHARE, Math.floor(budget / Math.max(1, directories.length))); // 1 ディレクトリの枠。
    const results = new Map(); // ディレクトリ → 走査結果。
    // 最上位のディレクトリ 1 つを、指定した枠で走査する。
    const subWalk = (directory, entriesLimit) => walkProject({ maxDepth: maxDepth - 1, maxEntries: Math.min(STRUCTURE_WALK_ENTRIES, entriesLimit), startPath: directory.path, includeExcludedDirectories: false });
    let used = 0; // 使った枠（返ってきたエントリーの数）。
    for (const directory of directories) {
      const sub = subWalk(directory, share);
      results.set(directory.path, sub);
      if (sub.ok) used += sub.entries.length;
    }
    const truncatedDirectories = directories.filter(directory => results.get(directory.path).ok && results.get(directory.path).truncated);
    const extra = truncatedDirectories.length > 0 ? Math.floor(Math.max(0, budget - used) / truncatedDirectories.length) : 0; // 配り直す枠。
    if (extra > 0) for (const directory of truncatedDirectories) results.set(directory.path, subWalk(directory, share + extra));
    const entries = [...top.entries];
    const counts = { ...top.counts };
    const excludedNames = new Set(top.excludedDirectoryNames);
    const partialDirectories = []; // 枠の上限で途中までになったディレクトリ。
    for (const directory of directories) {
      const sub = results.get(directory.path);
      if (!sub.ok) { counts.unreadable += 1; continue; }
      for (const entry of sub.entries) entries.push({ ...entry, depth: entry.depth + 1 });
      for (const name of Object.keys(counts)) counts[name] += Number(sub.counts[name] || 0);
      for (const name of sub.excludedDirectoryNames) excludedNames.add(name);
      if (sub.truncated) partialDirectories.push(directory.path);
    }
    entries.sort((left, right) => compareText(left.path, right.path));
    return {
      ok: true,
      startPath: '',
      entries,
      truncated: partialDirectories.length > 0,
      counts,
      excludedDirectoryNames: [...excludedNames].sort(),
      splitByTopDirectory: { directories: directories.length, entriesPerDirectory: share, partialDirectories },
    };
  }

  // 最上位のディレクトリごとに分けて走査したことを、注意として残す。ディレクトリ名は paths の権限があるときだけ出す。
  function noteSplitWalk(walked, collection) {
    const split = walked.splitByTopDirectory;
    if (!split) return;
    const partial = split.partialDirectories;
    collection.warnings.push(`走査が件数の上限に達したため、最上位のディレクトリごとに件数の枠を分けて走査しました。${partial.length > 0 ? `途中までのディレクトリが ${partial.length} 個あります${exposure.paths ? `（${partial.slice(0, 10).join(', ')}）` : ''}。` : ''}`);
  }

  // ファイルの本文を公開境界を通して読む。sourceText の権限が無ければ呼ばずに null を返し、hidden に記録する。読めなければ null。
  function readProjectFile(relativePath, collection) {
    if (!exposure.sourceText) {
      collection.hidden.add('sourceText');
      return null;
    }
    if (isBridgeConfigPath(relativePath)) return null;
    try {
      const result = boundary.readTextFile(relativePath, { maxBytes: MAX_FILE_BYTES });
      collection.filesRead += 1;
      return result;
    } catch {
      collection.readFailures += 1;
      return null;
    }
  }

  // ファイルの存在・更新日時を調べる（本文は読まない）。失敗は null。
  function statProjectFile(relativePath) {
    try {
      return boundary.statFile(relativePath) || null;
    } catch {
      return null;
    }
  }

  /*
    公開許可された文書を読み、解析した結果を返す。概要文書・状態文書・最上位の README を先に読み、
    ほかの文書は readOne で必要なときに読む。読めない文書は null（例外は投げない）。
  */
  function loadDocuments() {
    if (documentCache) return documentCache;
    const warnings = []; // 文書の読み取りの注意。
    let listed = []; // 公開許可された文書の一覧。
    try {
      const result = documentStore?.list?.();
      listed = Array.isArray(result) ? result : [];
    } catch {
      warnings.push('公開許可された文書の一覧を取得できませんでした。');
    }
    const analyses = new Map(); // パス → 解析結果（読めなければ null）。
    // 公開文書 1 件を読んで解析する（読めなければ null）。同じ文書は 1 回だけ読む。
    const readOne = relativePath => {
      if (!relativePath) return null;
      if (analyses.has(relativePath)) return analyses.get(relativePath);
      let analysis = null;
      try {
        const document = documentStore.read(relativePath);
        if (document && typeof document.text === 'string') analysis = analyzeDocument(document);
      } catch {
        analysis = null;
      }
      analyses.set(relativePath, analysis);
      return analysis;
    };
    const contextPath = documentStore?.contextFile || null; // 設定された概要文書。
    const statusPath = documentStore?.statusFile || null; // 設定された状態文書。
    const readmeListing = listed.find(item => /^readme(?:\.[a-z0-9]+)?$/i.test(String(item?.path || ''))) || null; // 最上位の README（公開許可されたものだけ）。
    documentCache = {
      listed,
      contextPath,
      statusPath,
      readmePath: readmeListing?.path || null,
      context: readOne(contextPath),
      status: readOne(statusPath),
      readme: readmeListing ? readOne(readmeListing.path) : null,
      readOne,
      warnings,
    };
    return documentCache;
  }

  // 公開文書の一覧を、状態文書・概要文書・README・そのほか（パス順）の順に並べる。
  function orderedDocumentPaths(documentsLoaded) {
    const first = [documentsLoaded.statusPath, documentsLoaded.contextPath, documentsLoaded.readmePath].filter(Boolean);
    const rest = documentsLoaded.listed.map(item => item.path).filter(item => typeof item === 'string' && !first.includes(item)).sort(compareText);
    return [...new Set([...first, ...rest])];
  }

  // 使った文書を記録する（sources と evidence に入れる）。
  function noteDocument(collection, analysis) {
    if (analysis) collection.usedDocuments.set(analysis.path, analysis.modified);
  }

  // 公開文書 1 件の事実（存在・未記入か・更新日時・記入済みの節）を作る。読めない文書は、存在だけを調べる（名前は設定された公開文書の名前）。
  function describeDocumentFact(role, relativePath, analysis, collection) {
    if (!relativePath) return { role, path: null, exists: false, readable: false, templateUnfilled: null, modified: null };
    if (analysis) {
      noteDocument(collection, analysis);
      return {
        role,
        path: analysis.path,
        exists: true,
        readable: true,
        title: analysis.title,
        modified: analysis.modified,
        templateUnfilled: analysis.templateUnfilled,
        hasContent: analysis.hasContent,
        filledSections: analysis.sections.filter(section => section.filled && section.heading.level >= 2).map(section => section.heading.text).slice(0, 30),
        unfilledSections: analysis.sections.filter(section => !section.filled && section.heading.level >= 2).map(section => section.heading.text).slice(0, 30),
        ...(analysis.statedReviewDate ? { statedReviewDate: analysis.statedReviewDate, statedReviewDateNote: '文書に書かれた最終確認日。テンプレートの作成時に入る日付のこともある。' } : {}),
      };
    }
    const stat = statProjectFile(relativePath);
    return {
      role,
      path: relativePath,
      exists: stat !== null,
      readable: false,
      templateUnfilled: null,
      modified: stat?.modified || null,
      note: stat ? '公開許可された文書として読めない（許可リストに無い可能性がある）。' : '見つからない（または安全上の理由で調べられない）。',
    };
  }

  // README の事実を作る。公開許可された README が無いときは、paths の権限があれば最上位の README の有無だけを調べる。
  function describeReadmeFact(documentsLoaded, walked, collection) {
    if (documentsLoaded.readme) return describeDocumentFact('readme', documentsLoaded.readmePath, documentsLoaded.readme, collection);
    if (!exposure.paths) return { role: 'readme', path: null, exists: null, readable: false, templateUnfilled: null, modified: null, note: '公開許可された README は無い。ファイル名を出す権限が無いため、ほかの README の有無は調べていない。' };
    const found = walked.ok ? walked.entries.find(entry => entry.kind === 'file' && entry.depth === 1 && /^readme(?:\.[a-z0-9]+)*$/i.test(baseNameOf(entry.path))) : null;
    return {
      role: 'readme',
      path: found?.path || null,
      exists: Boolean(found),
      readable: false,
      templateUnfilled: null,
      modified: found ? isoFromMs(found.modifiedMs) : null,
      note: found ? '公開許可された文書ではないため、本文は読んでいない。' : '最上位に README は見つからない。',
    };
  }

  // 文書の情報源の記述を作る（文書ごとに 1 件。sourceUpdatedAt はその文書の更新日時）。
  function documentSources(collection, collectedAt) {
    return [...collection.usedDocuments.entries()].map(([relativePath, modified]) => describeSource(SOURCE_KIND.DOCUMENT, collectedAt, modified, `公開許可された文書: ${relativePath}`));
  }

  // 使った文書を根拠の一覧にする。
  function documentEvidenceList(collection) {
    return [...collection.usedDocuments.entries()].map(([relativePath, modified]) => ({ type: 'document', path: relativePath, modified }));
  }

  // 走査で見つけたファイルを指す根拠を作る。paths の権限が無ければ空（パスを出さない）。
  function fileEvidence(entry) {
    return exposure.paths && entry ? [{ type: 'file', path: entry.path, modified: isoFromMs(entry.modifiedMs) }] : [];
  }

  // 目印のファイルがあることの根拠の文を作る。paths の権限が無いときはファイル名を出さず、一般的な説明にする。
  function markerBasis(rule, entry, count) {
    if (exposure.paths) return `${entry.path} がある${count > 1 ? `（ほか ${count - 1} 件）` : ''}`;
    return `${rule.description}がある${count > 1 ? `（${count} 件）` : ''}`;
  }

  // マニフェストを指す言い方を返す。paths の権限が無ければファイル名を出さず、一般的な説明にする。
  function manifestLabel(manifest) {
    return exposure.paths ? manifest.entry.path : manifest.rule.description;
  }

  /*
    走査の結果から、フレームワーク・エンジン・ビルド方式の目印を探す。sourceText の権限があれば、浅い場所のマニフェストの本文も読んで解析する。
    戻り値: { detections: [{ rule, entry }], manifests: [{ rule, entry, parsed, readFailed, modified }] }
  */
  function detectMarkers(entries, collection, { readContent = true } = {}) {
    const detections = []; // 目印のファイル。
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.depth > MARKER_MAX_DEPTH) continue;
      const rule = MARKER_RULES.find(candidate => matchesMarkerRule(candidate, entry));
      if (rule) detections.push({ rule, entry });
    }
    const manifests = []; // 本文を読んだマニフェスト。
    if (!readContent) return { detections, manifests };
    const readable = detections.filter(detection => detection.rule.parse && detection.entry.depth <= MANIFEST_MAX_DEPTH)
      .sort((left, right) => left.entry.depth - right.entry.depth || compareText(left.entry.path, right.entry.path));
    if (readable.length === 0) return { detections, manifests };
    if (!exposure.sourceText) {
      collection.hidden.add('sourceText');
      return { detections, manifests };
    }
    for (const detection of readable.slice(0, MAX_MANIFEST_READS)) {
      const file = readProjectFile(detection.entry.path, collection);
      if (!file) {
        manifests.push({ ...detection, parsed: null, readFailed: true, modified: null });
        continue;
      }
      let parsed = null; // 解析結果。
      try { parsed = detection.rule.parse(file.text); } catch { parsed = null; }
      manifests.push({ ...detection, parsed, readFailed: false, modified: file.modified });
      collection.configModified.push(file.modified);
    }
    const failed = manifests.filter(manifest => manifest.readFailed || !manifest.parsed).length;
    if (failed > 0) collection.warnings.push(`設定ファイル ${failed} 件は、読めないか形式を解釈できなかったため、内容を使っていません。`);
    if (readable.length > MAX_MANIFEST_READS) {
      collection.truncated = true;
      collection.warnings.push(`本文を読む設定ファイルが上限（${MAX_MANIFEST_READS} 件）を超えたため、浅い場所のものだけを読みました。`);
    }
    return { detections, manifests };
  }

  // 目印を label ごとにまとめ、最初のファイルと件数を返す。
  function groupDetections(detections, keyOf) {
    const groups = new Map(); // キー → { rule, entry, count }
    for (const detection of detections) {
      const key = keyOf(detection.rule);
      if (!key) continue;
      const group = groups.get(key) || { rule: detection.rule, entry: detection.entry, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    return groups;
  }

  // マニフェストの依存（実行用・開発用）の名前をまとめて返す。
  function dependencyNamesOf(manifest) {
    return [...(manifest.parsed?.runtimeDependencies || []), ...(manifest.parsed?.developmentDependencies || [])];
  }

  /*
    フレームワーク・エンジンの一覧を作る。目印のファイルの存在から分かるものは known（根拠は存在）、
    マニフェストの本文（依存・SDK・EngineAssociation など）から読んだものも known（根拠のファイル名は paths の権限があるときだけ）。
  */
  function buildFrameworksItem(markers, analyses, collection) {
    const list = []; // フレームワーク・エンジン。
    for (const [label, group] of groupDetections(markers.detections, rule => (['engine', 'runtime', 'buildSystem', 'language', 'container'].includes(rule.kind) ? rule.label : null))) {
      list.push({ name: label, kind: group.rule.kind, status: 'known', basis: markerBasis(group.rule, group.entry, group.count), evidence: fileEvidence(group.entry), sourceKind: SOURCE_KIND.STATIC_ANALYSIS });
    }
    // 一覧の中の同じ名前の項目に、本文から読んだ詳細を足す。
    const attachDetail = (label, detail) => {
      const target = list.find(item => item.name === label);
      if (target) target.details = { ...(target.details || {}), ...detail };
    };
    // 依存などから見つけたフレームワークを、重複なく一覧へ足す。
    const addFramework = (name, basis, manifest) => {
      if (list.some(item => item.name === name)) return;
      list.push({ name, kind: 'framework', status: 'known', basis, evidence: fileEvidence(manifest.entry), sourceKind: SOURCE_KIND.CONFIG });
    };
    for (const manifest of markers.manifests) {
      const parsed = manifest.parsed;
      if (!parsed) continue;
      const label = manifestLabel(manifest);
      if (manifest.rule.id === 'node') {
        for (const name of dependencyNamesOf(manifest)) {
          const framework = NODE_FRAMEWORK_PACKAGES.get(name);
          if (framework) addFramework(framework, `${label} の依存に ${name} がある`, manifest);
        }
        if (Object.keys(parsed.engines || {}).length > 0) attachDetail(manifest.rule.label, { engines: parsed.engines });
      } else if (manifest.rule.id.startsWith('python-')) {
        for (const name of dependencyNamesOf(manifest)) {
          const framework = PYTHON_FRAMEWORK_PACKAGES.get(name.toLowerCase());
          if (framework) addFramework(framework, `${label} の依存に ${name} がある`, manifest);
        }
        if (parsed.requiresPython) attachDetail('Python', { requiresPython: parsed.requiresPython });
      } else if (manifest.rule.id === 'dotnet' || manifest.rule.id === 'vcxproj') {
        if (parsed.targetFrameworks.length > 0) attachDetail(manifest.rule.label, { targetFrameworks: uniqueLimited([...(list.find(item => item.name === manifest.rule.label)?.details?.targetFrameworks || []), ...parsed.targetFrameworks]) });
        if (parsed.sdk) attachDetail(manifest.rule.label, { sdk: parsed.sdk });
        if (/Microsoft\.NET\.Sdk\.Web/i.test(parsed.sdk || '')) addFramework('ASP.NET Core', `${label} の SDK が ${parsed.sdk}`, manifest);
        if (parsed.useWpf) addFramework('WPF', `${label} に UseWPF の指定がある`, manifest);
        if (parsed.useWindowsForms) addFramework('Windows Forms', `${label} に UseWindowsForms の指定がある`, manifest);
      } else if (manifest.rule.id === 'unreal' && parsed.engineAssociation) {
        attachDetail('Unreal Engine', { engineAssociation: parsed.engineAssociation, engineAssociationNote: '.uproject の EngineAssociation の値。版番号でなく GUID のときは、ソースからビルドしたエンジンを指す。' });
      } else if (manifest.rule.id === 'unity' && parsed.editorVersion) {
        attachDetail('Unity', { editorVersion: parsed.editorVersion });
      } else if (manifest.rule.id === 'godot' && parsed.features.length > 0) {
        attachDetail('Godot', { features: parsed.features });
      } else if (manifest.rule.id === 'cmake' && parsed.minimumVersion) {
        attachDetail('CMake', { minimumVersion: parsed.minimumVersion });
      } else if (manifest.rule.id === 'go' && parsed.goVersion) {
        attachDetail('Go（Go modules）', { goVersion: parsed.goVersion });
      } else if (manifest.rule.id === 'cargo' && parsed.edition) {
        attachDetail('Rust（Cargo）', { edition: parsed.edition });
      }
    }
    const documented = documentFieldItem(analyses, DOCUMENT_FIELD_RULES.techStack, '公開許可された文書に、技術構成の節が見つからない。');
    const item = { value: list, status: list.length > 0 ? 'known' : documented.status, evidence: [], documented };
    if (!exposure.sourceText) Object.assign(item, { collectionStatus: 'partial', hiddenBy: 'sourceText', note: '依存関係などの本文から分かるフレームワークは、設定ファイルの本文を読む権限（detailExposure.sourceText）が無いため調べていない。' });
    if (list.length === 0 && documented.status !== 'known') item.note = item.note || '目印になるファイルが見つからない。フレームワークが無いことを意味しない。';
    return item;
  }

  /*
    ビルド方式の一覧を作る。種類はファイルの存在から known、scripts・ターゲットなどの詳細は本文を読めたときだけ載せる。
    コマンド文字列はファイル名を含みうるため、paths の権限があるときだけ出す。
  */
  function buildBuildMethods(markers) {
    const list = []; // ビルド方式。
    const nodeManifestCount = markers.manifests.filter(manifest => manifest.rule.id === 'node').length; // 複数あれば scripts の名前にファイルを添える。
    for (const [kind, group] of groupDetections(markers.detections, rule => rule.build || null)) {
      list.push({ kind, status: 'known', basis: markerBasis(group.rule, group.entry, group.count), evidence: fileEvidence(group.entry), contentRead: false, sourceKind: SOURCE_KIND.STATIC_ANALYSIS });
    }
    for (const manifest of markers.manifests) {
      const parsed = manifest.parsed;
      const target = list.find(item => item.kind === manifest.rule.build);
      if (!parsed || !target) continue;
      target.contentRead = true;
      target.sourceKind = SOURCE_KIND.CONFIG;
      const details = target.details || {};
      if (manifest.rule.id === 'node') {
        details.scripts = uniqueLimited([...(details.scripts || []), ...Object.keys(parsed.scripts)]);
        if (exposure.paths) {
          details.commands = { ...(details.commands || {}) };
          for (const [name, command] of Object.entries(parsed.scripts).slice(0, 30)) {
            if (Object.keys(details.commands).length >= MAX_COMMANDS) { details.commandsTruncated = true; break; }
            details.commands[nodeManifestCount > 1 ? `${manifest.entry.path}#${name}` : name] = clipText(command, MAX_COMMAND_CHARS);
          }
        } else {
          details.commandsHidden = true;
        }
      } else if (manifest.rule.id === 'make') {
        const visible = exposure.paths ? parsed.targets : parsed.targets.filter(name => !/[/.]/.test(name));
        details.targets = uniqueLimited([...(details.targets || []), ...visible]);
      } else if (manifest.rule.id === 'cmake') {
        details.executables = uniqueLimited([...(details.executables || []), ...parsed.executables]);
        details.libraries = uniqueLimited([...(details.libraries || []), ...parsed.libraries]);
        if (parsed.projectTitle) details.projectTitle = parsed.projectTitle;
      } else if (manifest.rule.id === 'dotnet' || manifest.rule.id === 'vcxproj') {
        details.outputTypes = uniqueLimited([...(details.outputTypes || []), parsed.outputType, parsed.configurationType].filter(Boolean));
        details.targetFrameworks = uniqueLimited([...(details.targetFrameworks || []), ...parsed.targetFrameworks]);
      } else if (manifest.rule.id === 'cargo') {
        details.binaries = uniqueLimited([...(details.binaries || []), ...parsed.binaries]);
        details.hasLibrary = Boolean(details.hasLibrary || parsed.hasLibrary);
      } else if (manifest.rule.id === 'python-pyproject') {
        if (parsed.buildBackend) details.buildBackend = parsed.buildBackend;
      } else if (manifest.rule.id === 'unreal') {
        details.modules = uniqueLimited([...(details.modules || []), ...parsed.modules.map(module => module.name)]);
      }
      target.details = details;
    }
    return list;
  }

  // エントリーポイントの一覧を作る。マニフェストに書かれたものは known、名前の規約によるものは inferred（low）。パスの値は paths の権限があるときだけ出す。
  function buildEntryPoints(markers, entries) {
    const list = []; // エントリーポイント。
    // パスになりうる値は、paths の権限があるときだけ返す。
    const pathValue = value => (exposure.paths ? value : null);
    for (const manifest of markers.manifests) {
      const parsed = manifest.parsed;
      if (!parsed) continue;
      const evidence = fileEvidence(manifest.entry);
      // マニフェストに書かれたエントリーポイントを 1 件足す。値（パス）を伏せたときは valueHidden を付ける。
      const add = (kind, name, value) => list.push({ kind, name, value: pathValue(value), ...(value && !exposure.paths ? { valueHidden: true } : {}), status: 'known', evidence, sourceKind: SOURCE_KIND.CONFIG });
      if (manifest.rule.id === 'node') {
        if (parsed.main) add('Node.js パッケージの main', null, parsed.main);
        if (parsed.module) add('Node.js パッケージの module', null, parsed.module);
        for (const [command, target] of Object.entries(parsed.bin).slice(0, 20)) add('Node.js パッケージの bin（コマンド）', command, target);
      } else if (manifest.rule.id === 'python-pyproject') {
        for (const [command, target] of Object.entries(parsed.scripts).slice(0, 20)) add('Python のコマンド（scripts）', command, target);
      } else if (manifest.rule.id === 'cargo') {
        for (const binary of parsed.binaries) add('Rust のバイナリ（[[bin]]）', binary, null);
      } else if (manifest.rule.id === 'cmake') {
        for (const executable of parsed.executables) add('CMake の実行ファイル（add_executable）', executable, null);
      } else if (manifest.rule.id === 'dotnet' && /exe/i.test(parsed.outputType || '')) {
        add(`.NET の実行可能プロジェクト（OutputType: ${parsed.outputType}）`, parsed.assemblyName, manifest.entry.path);
      } else if (manifest.rule.id === 'vcxproj' && /application/i.test(parsed.configurationType || '')) {
        add('C++ の実行ファイル（ConfigurationType: Application）', parsed.assemblyName, manifest.entry.path);
      } else if (manifest.rule.id === 'unreal') {
        for (const module of parsed.modules) add(`Unreal Engine のモジュール（${module.type || '種類不明'}）`, module.name, null);
      } else if (manifest.rule.id === 'godot' && parsed.mainScene) {
        add('Godot のメインシーン', null, parsed.mainScene);
      }
    }
    if (exposure.paths) {
      for (const entry of entries) {
        if (entry.kind !== 'file' || entry.depth > 2 || !ENTRY_POINT_FILE_PATTERN.test(baseNameOf(entry.path))) continue;
        if (list.some(item => item.value === entry.path)) continue;
        list.push({ kind: '名前の規約によるエントリーポイント候補', name: null, value: entry.path, status: 'inferred', confidence: 'low', basis: 'ファイル名の規約（main・index・app など）', evidence: fileEvidence(entry), sourceKind: SOURCE_KIND.STATIC_ANALYSIS });
        if (list.length >= MAX_ENTRY_POINTS) break;
      }
    }
    return list.slice(0, MAX_ENTRY_POINTS);
  }

  // 依存の一覧（マニフェストごと）を作る。依存の名前は本文由来なので sourceText の権限があるときだけ得られる。
  function buildDependencies(markers) {
    return markers.manifests.filter(manifest => manifest.parsed && (manifest.parsed.runtimeDependencies || manifest.parsed.developmentDependencies)).map(manifest => ({
      ecosystem: manifest.rule.ecosystem || manifest.rule.label,
      ...(exposure.paths ? { manifest: manifest.entry.path } : {}),
      runtime: uniqueLimited(manifest.parsed.runtimeDependencies || []),
      development: uniqueLimited(manifest.parsed.developmentDependencies || []),
      counts: { runtime: (manifest.parsed.runtimeDependencies || []).length, development: (manifest.parsed.developmentDependencies || []).length },
      status: 'known',
      evidence: fileEvidence(manifest.entry),
      sourceKind: SOURCE_KIND.CONFIG,
    }));
  }

  /*
    主要モジュールを作る。文書が書いている役割は known、最上位ディレクトリの名前の規約からの推測は inferred（low）、どちらも無ければ unknown。
    ディレクトリ名は paths の権限があるときだけ出す（無ければ件数だけ）。
  */
  function buildModulesItem(entries, analyses) {
    const found = findDocumentSection(analyses, DOCUMENT_FIELD_RULES.modules);
    const documented = found?.filled ? parseDocumentedModules(found) : [];
    const topDirectories = entries.filter(entry => entry.kind === 'directory' && entry.depth === 1 && !entry.excluded);
    const totals = aggregateDirectories(entries.filter(entry => entry.kind === 'file'), '');
    let directoryItems = null; // 最上位ディレクトリ（paths の権限があるときだけ）。
    if (exposure.paths) {
      directoryItems = topDirectories.slice(0, 100).map(entry => {
        const summary = { name: entry.path, files: totals.get(entry.path)?.files || 0, bytes: totals.get(entry.path)?.bytes || 0 };
        const documentedRole = documented.find(item => item.name.replace(/\/+$/, '').toLowerCase() === entry.path.toLowerCase()); // 名前がディレクトリそのものと一致するときだけ（中のファイルの説明を役割と取り違えない）。
        if (documentedRole) return { ...summary, role: documentedRole.role, status: 'known', evidence: documentedRole.evidence };
        const convention = MODULE_NAME_CONVENTIONS.get(entry.path.toLowerCase());
        if (convention) return { ...summary, role: convention, status: 'inferred', confidence: 'low', basis: 'ディレクトリ名の規約', evidence: [] };
        return { ...summary, role: null, status: 'unknown', evidence: [] };
      });
    }
    const value = {
      topLevelDirectoryCount: topDirectories.length,
      ...(directoryItems ? { topLevelDirectories: directoryItems } : { topLevelDirectoriesHidden: true }),
      documented,
      ...(found?.filled && documented.length === 0 ? { documentedText: sectionText(found.section) } : {}),
    };
    const status = documented.length > 0 || found?.filled ? 'known' : (directoryItems?.some(item => item.status === 'inferred') ? 'inferred' : 'unknown');
    return {
      value,
      status,
      evidence: found?.filled ? [documentEvidence(found)] : [],
      ...(found && !found.filled ? { templateUnfilled: true, note: '主要構成の節は空欄テンプレートのまま（未記入）。' } : {}),
      ...(!exposure.paths ? { note: 'ディレクトリ名を出す権限（gitExposure.paths）が無いため、最上位ディレクトリは件数だけ。文書に書かれた役割は出す。' } : {}),
    };
  }

  // 状態の判定に使う、目的の項目を作る。文書の節（目的・概要）は known、README の最初の段落は inferred（medium）。
  function buildPurposeItem(documentsLoaded, maxChars = SECTION_TEXT_MAX_CHARS) {
    const analyses = [documentsLoaded.context, documentsLoaded.status, documentsLoaded.readme].filter(Boolean);
    const item = documentFieldItem(analyses, DOCUMENT_FIELD_RULES.purpose, '公開許可された文書に、目的・概要の節が見つからない。', maxChars);
    if (item.status === 'known' || !documentsLoaded.readme) return item;
    const paragraph = readmeFirstParagraph(documentsLoaded.readme);
    if (!paragraph) return item;
    return inferredItem(clipText(paragraph, maxChars), 'README の表題の直後の段落。目的として書かれた節ではないため推測とする。', 'medium', [{ type: 'document', path: documentsLoaded.readme.path, heading: documentsLoaded.readme.parsed.headings[0]?.text || null }], {
      sourceKind: SOURCE_KIND.DOCUMENT,
      sourceUpdatedAt: documentsLoaded.readme.modified,
      ...(item.templateUnfilled ? { templateUnfilled: true, checked: item.checked } : {}),
    });
  }

  // 応答を作り、大きさの上限に収める。
  function finishEnvelope({ tool, collectedAt, collection, sources, facts, inferences = [], evidence = [], page = null, limits = {}, pagedKey = null }) {
    const envelope = makeEnvelope({
      tool, collectedAt, sources, facts, inferences, evidence, page,
      hidden: [...collection.hidden], warnings: collection.warnings, truncated: collection.truncated, limits,
    });
    return fitToBudget(envelope, DEFAULT_MAX_RESPONSE_BYTES, pagedKey);
  }

  // 何も取得できなかったときの応答（status: unavailable、errorClass 付き）を作る。
  function unavailableEnvelope(tool, collectedAt, errorClass, errorReason, collection, sources = [], limits = {}) {
    const envelope = makeEnvelope({ tool, collectedAt, errorClass, errorReason, sources, facts: {}, hidden: [...collection.hidden], warnings: collection.warnings, limits });
    return fitToBudget(envelope, DEFAULT_MAX_RESPONSE_BYTES);
  }

  // 主要ファイル・ディレクトリを、名前の規約から役割付きで返す（paths の権限があるときだけ使う）。浅い順。
  function detectKeyFiles(entries) {
    const found = []; // { path, kind, role, roleLabel, confidence, depth }
    for (const entry of entries) {
      const name = baseNameOf(entry.path);
      let rule = null; // 当たった規則。
      if (entry.kind === 'directory') {
        if (!entry.excluded && entry.depth <= KEY_DIRECTORY_MAX_DEPTH) rule = KEY_DIRECTORY_RULES.find(candidate => candidate.namePattern.test(name)) || null;
      } else if (entry.depth <= MARKER_MAX_DEPTH) {
        const category = classifyLanguage(name).category; // 画像（license.svg のアイコンなど）を文書と取り違えないための分類。
        rule = KEY_FILE_RULES.find(candidate => candidate.namePattern.test(name) && (candidate.anyCategory || category === 'document' || category === 'other')) || null;
        if (!rule) {
          const marker = MARKER_RULES.find(candidate => matchesMarkerRule(candidate, entry));
          if (marker) rule = { role: marker.kind === 'container' ? 'container' : 'manifest', label: `${marker.kind === 'container' ? 'コンテナの定義' : 'マニフェスト・ビルド定義'}（${marker.label}）`, confidence: 'medium' };
        }
        if (!rule) {
          const ci = CI_RULES.find(candidate => candidate.pathPattern.test(entry.path));
          if (ci) rule = { role: 'ci', label: `CI の設定（${ci.kind}）`, confidence: 'medium' };
        }
        if (!rule) {
          const testConfig = TEST_CONFIG_RULES.find(candidate => candidate.namePattern.test(name));
          if (testConfig) rule = { role: 'testConfig', label: `テストの設定（${testConfig.name}）`, confidence: 'medium' };
        }
      }
      if (rule) found.push({ path: entry.path, kind: entry.kind, role: rule.role, roleLabel: rule.label, confidence: rule.confidence, depth: entry.depth });
    }
    found.sort((left, right) => left.depth - right.depth || compareText(left.path, right.path));
    return found.slice(0, MAX_KEY_FILES).map(({ depth, ...rest }) => ({ ...rest, depth, roleStatus: 'inferred' }));
  }

  /*
    get_project_structure: ディレクトリ構造と言語別のファイル数を返す。走査は深さ 12 まで既定の除外ありで行い（ルートからの走査が上限に当たれば
    最上位のディレクトリごとに枠を分けて走査し直す）、表示だけ depth で絞る。件数は走査したぶん全部を数える。
    ファイル名・ディレクトリ名は paths の権限があるときだけ出す（無ければ件数・言語別の件数・サイズの合計だけ）。
  */
  function getStructure(input = {}) {
    const tool = 'get_project_structure';
    const depth = clampInteger(input.depth, 'depth', { min: 1, max: 8, fallback: 3 });
    const limit = clampInteger(input.limit, 'limit', { min: 1, max: 1000, fallback: 200 });
    const offset = clampInteger(input.offset, 'offset', { min: 0, max: 10000000, fallback: 0 });
    const requestedPath = normalizeStartPath(input.path);
    const collectedAt = nowIso();
    const collection = newCollection();
    const sources = [describeSource(SOURCE_KIND.STATIC_ANALYSIS, collectedAt, null, '呼び出し時点のファイル構成の走査（ファイルの本文は読まない）')];
    const limits = { depth, limit, walkMaxDepth: STRUCTURE_WALK_DEPTH, walkMaxEntries: STRUCTURE_WALK_ENTRIES };
    let startPath = null; // 走査の起点。
    if (!exposure.paths) {
      collection.hidden.add('paths');
      if (requestedPath) collection.warnings.push('ファイル名を出す権限（gitExposure.paths）が無いため、path 引数は使わず、プロジェクト全体を数えました。');
    } else {
      startPath = requestedPath;
    }
    const walked = startPath
      ? walkProject({ maxDepth: STRUCTURE_WALK_DEPTH, maxEntries: STRUCTURE_WALK_ENTRIES, startPath, includeExcludedDirectories: false }, { rethrowInvalidArgument: true })
      : walkRoot();
    if (!walked.ok) return unavailableEnvelope(tool, collectedAt, walked.errorClass, 'ファイル構成を走査できませんでした。原因は特定できません。', collection, sources, limits);
    noteSplitWalk(walked, collection);
    if (startPath && walked.entries.length === 0 && walked.counts.unreadable > 0) {
      return unavailableEnvelope(tool, collectedAt, ERROR_CLASS.NOT_FOUND, 'path の場所が見つからないか、ディレクトリとして読めません。', collection, sources, limits);
    }
    const files = walked.entries.filter(entry => entry.kind === 'file');
    const directories = walked.entries.filter(entry => entry.kind === 'directory');
    const depthLimited = directories.filter(entry => !entry.excluded && entry.depth >= STRUCTURE_WALK_DEPTH).length; // 深さの上限で中を見ていないディレクトリ。
    if (walked.truncated) {
      collection.truncated = true;
      collection.warnings.push(`走査したエントリーが上限（${STRUCTURE_WALK_ENTRIES} 件）に達したため、件数は途中までです。`);
    }
    if (depthLimited > 0) collection.warnings.push(`深さの上限（${STRUCTURE_WALK_DEPTH}）のため、${depthLimited} 個のディレクトリの中は数えていません。`);
    const facts = {
      scope: { ...(exposure.paths ? { path: walked.startPath || '' } : {}), depthShown: depth },
      summary: {
        totalFiles: files.length,
        totalDirectories: directories.length,
        totalBytes: files.reduce((total, entry) => total + (Number(entry.size) || 0), 0),
        scannedEntries: walked.entries.length,
        skipped: { ...walked.counts },
        depthLimitedDirectories: depthLimited,
        truncated: walked.truncated,
        splitByTopDirectory: walked.splitByTopDirectory
          ? {
            directories: walked.splitByTopDirectory.directories,
            entriesPerDirectory: walked.splitByTopDirectory.entriesPerDirectory,
            partialDirectoryCount: walked.splitByTopDirectory.partialDirectories.length,
            ...(exposure.paths ? { partialDirectories: walked.splitByTopDirectory.partialDirectories } : {}),
          }
          : null,
      },
      languages: summarizeLanguages(files).map(({ language, category, files: fileCount, bytes }) => ({ language, category, files: fileCount, bytes })),
      excludedDirectories: { count: walked.counts.excludedDirectories, ...(exposure.paths ? { names: walked.excludedDirectoryNames } : {}) },
    };
    const inferences = [];
    let page = null; // ページ情報。
    if (exposure.paths) {
      const totals = aggregateDirectories(files, walked.startPath);
      const shown = walked.entries.filter(entry => entry.depth <= depth).map(entry => ({
        path: entry.path,
        kind: entry.kind,
        depth: entry.depth,
        bytes: entry.kind === 'file' ? Number(entry.size) || 0 : (entry.excluded ? null : totals.get(entry.path)?.bytes || 0),
        ...(entry.kind === 'directory' ? { files: entry.excluded ? null : totals.get(entry.path)?.files || 0 } : {}),
        modifiedAt: isoFromMs(entry.modifiedMs),
        excluded: entry.excluded === true,
      }));
      const paged = paginate(shown, offset, limit);
      facts.entries = paged.items;
      page = paged.page;
      facts.keyFiles = detectKeyFiles(walked.entries);
      if (facts.keyFiles.length > 0) inferences.push({ claim: 'keyFiles の role は、ファイル名・ディレクトリ名の規約から推測した役割で、内容は確かめていない。', basis: 'ファイル名の規約', confidence: 'medium', evidence: [] });
    }
    if (walked.counts.excludedDirectories > 0) {
      inferences.push({ claim: 'excluded: true のディレクトリは、生成物・依存・キャッシュと見なして中を数えていない。', basis: 'ディレクトリ名の規約（既定の除外の一覧）', confidence: 'medium', evidence: [] });
    }
    return finishEnvelope({ tool, collectedAt, collection, sources, facts, inferences, evidence: [], page, limits, pagedKey: 'entries' });
  }

  /*
    get_project_overview: 目的・言語・フレームワーク・ビルド方法・エントリーポイント・主要モジュール・依存・実装済み機能・フェーズを根拠付きで返す。
    Git の情報は扱わない（別ツール）。
  */
  function getOverview() {
    const tool = 'get_project_overview';
    const collectedAt = nowIso();
    const collection = newCollection();
    if (!exposure.paths) collection.hidden.add('paths');
    if (!exposure.sourceText) collection.hidden.add('sourceText');
    const walked = walkRoot();
    const documentsLoaded = loadDocuments();
    collection.warnings.push(...documentsLoaded.warnings);
    const analyses = [documentsLoaded.context, documentsLoaded.status, documentsLoaded.readme].filter(Boolean);
    if (!walked.ok && analyses.length === 0) {
      return unavailableEnvelope(tool, collectedAt, walked.errorClass, 'ファイル構成を走査できず、公開許可された文書も読めませんでした。', collection);
    }
    if (!walked.ok) collection.warnings.push('ファイル構成を走査できませんでした。文書から分かる項目だけを返します。');
    if (walked.ok) noteSplitWalk(walked, collection);
    if (walked.ok && walked.truncated) {
      collection.truncated = true;
      collection.warnings.push(`走査したエントリーが上限（${STRUCTURE_WALK_ENTRIES} 件）に達したため、言語・目印の検出は途中までです。`);
    }
    const entries = walked.ok ? walked.entries : [];
    const files = entries.filter(entry => entry.kind === 'file');
    const markers = detectMarkers(entries, collection);
    const contentNote = '設定ファイルの本文を読む権限（detailExposure.sourceText）が無いため、取得していない。';
    const frameworks = buildFrameworksItem(markers, analyses, collection);
    const buildList = buildBuildMethods(markers);
    const buildDocumented = documentFieldItem(analyses, DOCUMENT_FIELD_RULES.buildMethods, '公開許可された文書に、ビルドの節が見つからない。');
    const buildMethods = { value: buildList, status: buildList.length > 0 ? 'known' : buildDocumented.status, evidence: [], documented: buildDocumented };
    if (!exposure.sourceText) Object.assign(buildMethods, { collectionStatus: 'partial', hiddenBy: 'sourceText', note: `種類はファイルの存在から判定した。scripts・ターゲットなどの詳細は、${contentNote}` });
    const entryList = buildEntryPoints(markers, entries);
    const entryPoints = entryList.length > 0 ? { value: entryList, status: overallStatus(entryList), evidence: [] } : unknownItem('マニフェストにエントリーポイントの記述が見つからない。');
    if (!exposure.sourceText) Object.assign(entryPoints, { collectionStatus: 'partial', hiddenBy: 'sourceText', note: contentNote });
    const dependencyList = buildDependencies(markers);
    let dependencies; // 依存の項目。
    if (!exposure.sourceText) dependencies = unknownItem(contentNote, { collectionStatus: 'partial', hiddenBy: 'sourceText' });
    else if (dependencyList.length > 0) dependencies = { value: dependencyList, status: 'known', evidence: [] };
    else dependencies = unknownItem(markers.detections.length > 0 ? '依存を読めるマニフェストが見つからない（または読めなかった）。' : 'マニフェストが見つからない。');
    const languages = summarizeLanguages(files).filter(item => item.language !== 'other').slice(0, 10);
    const facts = {
      documents: {
        context: describeDocumentFact('context', documentsLoaded.contextPath, documentsLoaded.context, collection),
        status: describeDocumentFact('status', documentsLoaded.statusPath, documentsLoaded.status, collection),
        readme: describeReadmeFact(documentsLoaded, walked, collection),
        allowedDocumentCount: documentsLoaded.listed.length,
      },
      purpose: buildPurposeItem(documentsLoaded),
      audience: documentFieldItem(analyses, DOCUMENT_FIELD_RULES.audience, '公開許可された文書に、利用者・対象の節が見つからない。'),
      phase: documentFieldItem(documentsLoaded.status ? [documentsLoaded.status, ...analyses.filter(item => item !== documentsLoaded.status)] : analyses, DOCUMENT_FIELD_RULES.phase, '公開許可された文書に、現在のフェーズ・現在状態の節が見つからない。'),
      implementedFeatures: documentFieldItem(analyses, DOCUMENT_FIELD_RULES.implementedFeatures, '公開許可された文書に、実装済み機能の節が見つからない（現在状態の節に含まれている可能性はあるが、推測で補わない）。'),
      artifactLocations: documentFieldItem(analyses, DOCUMENT_FIELD_RULES.artifactLocations, '公開許可された文書に、成果物・出力先の節が見つからない。'),
      languages: languages.length > 0
        ? knownItem(languages, [], { basis: '拡張子ごとのファイル数（呼び出し時点の走査）', sourceKind: SOURCE_KIND.STATIC_ANALYSIS })
        : unknownItem(walked.ok ? '言語を判定できるファイルが見つからない。' : 'ファイル構成を走査できなかった。'),
      frameworks,
      buildMethods,
      entryPoints,
      dependencies,
      modules: buildModulesItem(entries, analyses),
      externalServices: documentFieldItem(analyses, DOCUMENT_FIELD_RULES.externalServices, '文書・設定に外部サービスの明示が無い。依存の名前から外部サービスを推測しない。'),
      scan: { totalFiles: files.length, truncated: walked.ok ? walked.truncated : null, filesRead: collection.filesRead, readFailures: collection.readFailures },
    };
    const sources = [...documentSources(collection, collectedAt), describeSource(SOURCE_KIND.STATIC_ANALYSIS, collectedAt, null, '呼び出し時点のファイル構成の走査')];
    if (markers.manifests.some(manifest => !manifest.readFailed)) {
      const newest = collection.configModified.filter(Boolean).sort().pop() || null;
      sources.push(describeSource(SOURCE_KIND.CONFIG, collectedAt, newest, '設定ファイル（マニフェスト）の本文'));
    }
    const evidence = [...documentEvidenceList(collection), ...(exposure.paths ? markers.detections.slice(0, 50).flatMap(detection => fileEvidence(detection.entry)) : [])];
    const inferences = [];
    if (facts.modules.value.topLevelDirectories?.some(item => item.status === 'inferred')) {
      inferences.push({ claim: 'modules の一部の役割は、ディレクトリ名の規約から推測した（文書には書かれていない）。', basis: 'ディレクトリ名の規約（src・tests・docs など）', confidence: 'low', evidence: [] });
    }
    if (facts.purpose.status === 'inferred') inferences.push({ claim: '目的は README の冒頭の段落から推測した。', basis: facts.purpose.basis, confidence: 'medium', evidence: facts.purpose.evidence });
    return finishEnvelope({ tool, collectedAt, collection, sources, facts, inferences, evidence, limits: { walkMaxDepth: STRUCTURE_WALK_DEPTH, walkMaxEntries: STRUCTURE_WALK_ENTRIES, maxManifestReads: MAX_MANIFEST_READS, maxFileBytes: MAX_FILE_BYTES } });
  }

  /*
    文書 1 件から課題を集める。未完了のチェックボックスは doc-open-item、課題・次の作業・ブロッカーの見出しの下の項目はその種類。
    テンプレートの定型文・「なし」の行・完了済みのチェックボックス・自動収集の区間・コードブロックは拾わない。
    一覧の無い節は、最初の段落を 1 件として拾う。確度は文書の更新が 30 日以内なら medium、それより古ければ low。
  */
  function extractDocumentTasks(analysis, nowMs) {
    const age = ageInDays(analysis.modified, nowMs);
    const fresh = age !== null && age <= RECENT_DOCUMENT_DAYS;
    const confidence = fresh ? 'medium' : 'low';
    const note = fresh
      ? `文書の更新日時: ${analysis.modified}。文書に書かれた時点の内容で、今も有効とは限らない`
      : `文書の更新日時が古い（${analysis.modified || '不明'}${age !== null ? `、約 ${age} 日前` : ''}）。今も有効とは限らない`;
    const tasks = []; // 集めた課題。
    const sectionsWithItems = new Set(); // 一覧の項目があった節（見出し）。
    const paragraphs = new Map(); // 見出し → 一覧の無い節の最初の段落。
    const headerLines = tableHeaderLineNumbers(analysis.parsed.lines);
    // 文書の 1 行から、課題の 1 件を作る。
    const makeTask = (kind, text, entry, heading, extra = {}) => ({
      id: `${kind}:${analysis.path}:${entry.line}`,
      kind,
      text: clipText(String(text).trim(), TASK_TEXT_MAX_CHARS),
      location: { path: analysis.path, heading: heading?.text ?? null, line: entry.line },
      source: SOURCE_KIND.DOCUMENT,
      sourceUpdatedAt: analysis.modified || null,
      confidence,
      note,
      ...extra,
    });
    for (const entry of analysis.parsed.lines) {
      if (entry.auto || entry.code) continue;
      const section = classifyTaskHeadingStack(entry.stack);
      const innermost = entry.stack.length > 0 ? entry.stack[entry.stack.length - 1] : null;
      const checkbox = /^(\s*)(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s*(.*)$/.exec(entry.text);
      if (checkbox) {
        if (section) sectionsWithItems.add(section.heading);
        const body = checkbox[3].trim();
        if (checkbox[2] !== ' ' || !body || isTemplateLine(body) || NONE_LINE_PATTERN.test(body)) continue;
        tasks.push(makeTask('doc-open-item', body, entry, innermost, section ? { sectionKind: section.kind } : {}));
        continue;
      }
      if (!section) continue;
      const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(entry.text);
      const cells = bullet ? null : tableCells(entry, headerLines);
      if (bullet || cells) {
        sectionsWithItems.add(section.heading);
        if (bullet && indentWidth(bullet[1]) >= 2) continue; // 入れ子の項目は親の補足として扱い、別の課題にしない。
        const body = bullet ? bullet[2].trim() : cells.filter(Boolean).join(' / ');
        if (!body || isTemplateLine(body) || NONE_LINE_PATTERN.test(normalizeDocumentLine(body))) continue;
        tasks.push(makeTask(section.kind, body, entry, innermost));
        continue;
      }
      const trimmed = entry.text.trim();
      if (!trimmed) {
        const open = paragraphs.get(section.heading); // 空行で段落が終わる。
        if (open) open.closed = true;
        continue;
      }
      if (!isContentLine(entry) || NONE_LINE_PATTERN.test(normalizeDocumentLine(trimmed)) || trimmed.startsWith('|')) continue;
      const paragraph = paragraphs.get(section.heading);
      if (!paragraph) paragraphs.set(section.heading, { kind: section.kind, entry, heading: innermost, texts: [trimmed], closed: false });
      else if (!paragraph.closed) paragraph.texts.push(trimmed);
    }
    for (const [heading, paragraph] of paragraphs) {
      if (sectionsWithItems.has(heading)) continue;
      tasks.push(makeTask(paragraph.kind, paragraph.texts.join(' '), paragraph.entry, paragraph.heading));
    }
    return tasks.sort((left, right) => left.location.line - right.location.line);
  }

  // 公開文書のすべて（上限あり）から課題を集める。
  function collectDocumentTasks(collection, nowMs) {
    const documentsLoaded = loadDocuments();
    collection.warnings.push(...documentsLoaded.warnings.filter(warning => !collection.warnings.includes(warning)));
    const ordered = orderedDocumentPaths(documentsLoaded);
    const tasks = []; // 文書から集めた課題。
    const scanned = []; // 調べた文書。
    for (const relativePath of ordered.slice(0, MAX_TASK_DOCUMENTS)) {
      const analysis = documentsLoaded.readOne(relativePath);
      if (!analysis) continue;
      noteDocument(collection, analysis);
      const found = extractDocumentTasks(analysis, nowMs);
      const room = Math.max(0, MAX_DOCUMENT_TASKS - tasks.length); // 上限までの残り。
      tasks.push(...found.slice(0, room));
      scanned.push({ path: analysis.path, modified: analysis.modified, templateUnfilled: analysis.templateUnfilled, items: found.length });
      if (found.length > room) {
        collection.truncated = true;
        collection.warnings.push(`文書の課題が上限（${MAX_DOCUMENT_TASKS} 件）に達したため、残りは集めていません。`);
        break;
      }
    }
    if (ordered.length > MAX_TASK_DOCUMENTS) {
      collection.truncated = true;
      collection.warnings.push(`公開文書が上限（${MAX_TASK_DOCUMENTS} 件）を超えたため、課題は一部の文書からだけ集めました。`);
    }
    return { tasks, scanned };
  }

  /*
    ソースの TODO / FIXME / XXX / HACK コメントを集める。sourceText と paths の両方の権限があるときだけ呼ぶ。
    読むファイルは TODO_MAX_FILES 件まで、時間は TODO_TIME_BUDGET_MS まで。超えたら打ち切って truncated にする。
  */
  function collectCodeTodos(collection, nowMs) {
    const walked = walkRoot();
    if (!walked.ok) {
      collection.warnings.push('ファイル構成を走査できなかったため、ソースの TODO は集めていません。');
      return { scan: { performed: false, reason: 'ファイル構成を走査できませんでした。', errorClass: walked.errorClass }, tasks: [] };
    }
    noteSplitWalk(walked, collection);
    const candidates = walked.entries.filter(entry => isTodoScanTarget(entry));
    const started = Date.now();
    const tasks = []; // 集めた TODO。
    let filesScanned = 0; // 本文を読もうとしたファイル数。
    let skippedLarge = 0; // 大きすぎて読まなかったファイル数。
    let unreadable = 0; // 読めなかったファイル数（リンク・バイナリ・hardlink など）。
    let clippedFiles = 0; // 上限で切り詰めて読んだファイル数。
    let truncatedBy = null; // 打ち切りの理由。
    for (const entry of candidates) {
      if (filesScanned >= TODO_MAX_FILES) { truncatedBy = 'files'; break; }
      if (Date.now() - started > TODO_TIME_BUDGET_MS) { truncatedBy = 'time'; break; }
      if ((Number(entry.size) || 0) > TODO_MAX_FILE_SIZE) { skippedLarge += 1; continue; }
      if (!entry.size) continue;
      filesScanned += 1;
      const file = readProjectFile(entry.path, collection);
      if (!file) { unreadable += 1; continue; }
      if (file.clipped) clippedFiles += 1;
      if (!TODO_QUICK_PATTERN.test(file.text)) continue;
      const age = ageInDays(file.modified, nowMs);
      const lines = file.text.split(/\r?\n/);
      const possiblyVendored = entry.path.split('/').slice(0, -1).some(segment => VENDORED_DIRECTORY_PATTERN.test(segment)); // 第三者のコードの置き場所らしいか。
      let perFile = 0; // このファイルから集めた件数。
      for (let index = 0; index < lines.length; index += 1) {
        const match = TODO_COMMENT_PATTERN.exec(lines[index]);
        if (!match) continue;
        const rest = match[2].replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
        tasks.push({
          id: `code-todo:${entry.path}:${index + 1}`,
          kind: 'code-todo',
          marker: match[1],
          text: clipText(rest ? `${match[1]}: ${rest}` : lines[index].trim(), TASK_TEXT_MAX_CHARS),
          location: { path: entry.path, heading: null, line: index + 1 },
          source: SOURCE_KIND.STATIC_ANALYSIS,
          sourceUpdatedAt: file.modified || null,
          confidence: 'low',
          note: `ファイルの最終更新日時: ${file.modified || '不明'}${age !== null ? `（約 ${age} 日前）` : ''}。今も未解決とは限らない${possiblyVendored ? '。置き場所のディレクトリ名から、第三者のコードの可能性がある（推測）' : ''}`,
          ...(possiblyVendored ? { possiblyVendored: true } : {}),
        });
        perFile += 1;
        if (tasks.length >= TODO_MAX_ITEMS) { truncatedBy = 'items'; break; }
        if (perFile >= TODO_MAX_PER_FILE) break;
      }
      if (truncatedBy === 'items') break;
    }
    if (walked.truncated) truncatedBy ??= 'walkEntries';
    if (truncatedBy) {
      collection.truncated = true;
      const reasons = { files: `読むファイルの上限（${TODO_MAX_FILES} 件）`, time: `時間の上限（約 ${TODO_TIME_BUDGET_MS / 1000} 秒）`, items: `件数の上限（${TODO_MAX_ITEMS} 件）`, walkEntries: `走査の上限（${STRUCTURE_WALK_ENTRIES} 件）` };
      collection.warnings.push(`${reasons[truncatedBy]}に達したため、ソースの TODO の走査を途中で打ち切りました。`);
    }
    return {
      scan: {
        performed: true,
        filesConsidered: candidates.length,
        filesScanned,
        skippedLarge,
        unreadable,
        clippedFiles,
        possiblyVendoredItems: tasks.filter(task => task.possiblyVendored).length,
        truncated: Boolean(truncatedBy),
        truncatedBy,
        limits: { maxFiles: TODO_MAX_FILES, timeBudgetMs: TODO_TIME_BUDGET_MS, maxItems: TODO_MAX_ITEMS, maxPerFile: TODO_MAX_PER_FILE, maxFileBytes: MAX_FILE_BYTES },
      },
      tasks,
    };
  }

  // 課題を、種類の順（ブロッカー → 課題 → 未完了の項目 → 次の作業 → TODO）、同じ種類の中は場所の順に並べる。
  function sortTasks(tasks, documentOrder) {
    const documentIndex = new Map(documentOrder.map((relativePath, index) => [relativePath, index]));
    return tasks.slice().sort((left, right) => {
      const kindDifference = TASK_KIND_ORDER.indexOf(left.kind) - TASK_KIND_ORDER.indexOf(right.kind);
      if (kindDifference !== 0) return kindDifference;
      const vendoredDifference = Number(Boolean(left.possiblyVendored)) - Number(Boolean(right.possiblyVendored)); // 第三者のコードらしい TODO は後ろへ。
      if (vendoredDifference !== 0) return vendoredDifference;
      const leftIndex = documentIndex.get(left.location.path) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = documentIndex.get(right.location.path) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || compareText(left.location.path, right.location.path) || left.location.line - right.location.line;
    });
  }

  // get_project_tasks: 公開文書の未完了項目・課題・次の作業・ブロッカーと、ソースの TODO を、根拠・確認日時・確度付きで返す。
  function getTasks(input = {}) {
    const tool = 'get_project_tasks';
    const limit = clampInteger(input.limit, 'limit', { min: 1, max: 200, fallback: 100 });
    const offset = clampInteger(input.offset, 'offset', { min: 0, max: 10000000, fallback: 0 });
    const collectedAt = nowIso();
    const nowMs = Date.now();
    const collection = newCollection();
    const documentResult = collectDocumentTasks(collection, nowMs);
    let codeResult; // ソースの TODO の走査結果。
    if (exposure.sourceText && exposure.paths) {
      codeResult = collectCodeTodos(collection, nowMs);
    } else {
      const missing = []; // 足りない権限。
      if (!exposure.sourceText) { missing.push('detailExposure.sourceText'); collection.hidden.add('sourceText'); }
      if (!exposure.paths) { missing.push('gitExposure.paths'); collection.hidden.add('paths'); }
      codeResult = { scan: { performed: false, reason: `ソースの TODO を探すには、ファイルの本文を読む権限（detailExposure.sourceText）とファイル名を出す権限（gitExposure.paths）の両方が必要です。許可されていない権限: ${missing.join('、')}` }, tasks: [] };
    }
    const documentOrder = orderedDocumentPaths(loadDocuments());
    const allTasks = sortTasks([...documentResult.tasks, ...codeResult.tasks], documentOrder);
    const counts = Object.fromEntries(TASK_KIND_ORDER.map(kind => [kind, allTasks.filter(task => task.kind === kind).length]));
    counts.total = allTasks.length;
    const blockerCount = counts['doc-blocker'];
    const paged = paginate(allTasks, offset, limit);
    const facts = {
      tasks: paged.items,
      counts,
      blockers: blockerCount > 0
        ? { status: 'known', count: blockerCount, note: '文書のブロッカーの節に書かれた項目（tasks の kind: doc-blocker）。今も解消していないとは限らない。' }
        : { status: 'unknown', note: '妨げている問題を示す記述は見つからなかった。無いことを意味しない' },
      documentsScanned: documentResult.scanned,
      codeTodoScan: codeResult.scan,
    };
    const sources = documentSources(collection, collectedAt);
    if (codeResult.scan.performed) sources.push(describeSource(SOURCE_KIND.STATIC_ANALYSIS, collectedAt, null, '呼び出し時点のソースの本文（TODO / FIXME / XXX / HACK コメント）'));
    const inferences = [{ claim: '文書の項目は、その文書が書かれた時点の内容で、今も未完了・未解決とは限らない。', basis: '文書の更新日時より後の変化は、このツールでは確かめられない', confidence: 'high', evidence: [] }];
    if (codeResult.scan.performed) inferences.push({ claim: 'ソースの TODO コメントは書かれた時点の記録で、今も未解決とは限らない。', basis: 'コメントの有無だけを見ており、対応済みかは確かめていない', confidence: 'high', evidence: [] });
    if (codeResult.scan.possiblyVendoredItems > 0) inferences.push({ claim: 'possiblyVendored: true の TODO は、第三者のコード（同梱したライブラリなど）のものの可能性がある。', basis: 'ディレクトリ名の規約（3rdparty・vendor・external など）', confidence: 'low', evidence: [] });
    return finishEnvelope({
      tool, collectedAt, collection, sources, facts, inferences, evidence: documentEvidenceList(collection), page: paged.page,
      limits: { limit, maxTaskDocuments: MAX_TASK_DOCUMENTS, maxDocumentTasks: MAX_DOCUMENT_TASKS, maxTextChars: TASK_TEXT_MAX_CHARS, recentDocumentDays: RECENT_DOCUMENT_DAYS }, pagedKey: 'tasks',
    });
  }

  /*
    最上位の決め打ちの候補（記録の置き場所のディレクトリと、記録ファイルの名前）から、過去のテスト結果・網羅率・ベンチマークの記録を探す。
    生成物のディレクトリ（coverage など）にあることが多いので、候補のディレクトリは除外を外して浅く（深さ 2）見る。
    内容（件数・日時）は sourceText の権限があるときだけ、maxParse 件まで読む。
  */
  function collectPastRecords(entries, collection, maxParse) {
    const candidates = []; // { entry, directoryName }
    let truncated = false; // 候補の走査が上限で途中になったか。
    for (const entry of entries) {
      if (entry.depth !== 1) continue;
      if (entry.kind === 'file' && ROOT_RECORD_FILE_PATTERN.test(baseNameOf(entry.path))) candidates.push({ entry, directoryName: '' });
      if (entry.kind === 'directory' && RECORD_DIRECTORY_PATTERN.test(baseNameOf(entry.path))) {
        const sub = walkProject({ startPath: entry.path, maxDepth: RECORD_WALK_DEPTH, maxEntries: RECORD_WALK_ENTRIES, includeExcludedDirectories: true });
        if (!sub.ok) continue;
        if (sub.truncated) truncated = true;
        for (const child of sub.entries) if (child.kind === 'file') candidates.push({ entry: child, directoryName: baseNameOf(entry.path) });
      }
    }
    const records = []; // 見つけた記録。
    let parsedCount = 0; // 内容を読んだ件数。
    let contentSkipped = false; // 権限が無くて内容を読まなかった記録があるか。
    for (const candidate of candidates) {
      const kind = classifyRecordFile(baseNameOf(candidate.entry.path), candidate.directoryName);
      if (!kind) continue;
      if (records.length >= MAX_RECORDS) { truncated = true; break; }
      const fileModified = isoFromMs(candidate.entry.modifiedMs);
      const record = {
        kind,
        recordedAt: fileModified,
        recordedAtSource: 'fileModified',
        fileModified,
        total: null,
        passed: null,
        failed: null,
        skipped: null,
        ...(exposure.paths ? { path: candidate.entry.path } : {}),
        semantics: 'pastRecord',
        contentRead: false,
      };
      const parsers = { junit: parseJunitRecord, trx: parseTrxRecord };
      const parsable = kind === 'junit' || kind === 'trx' || (kind === 'coverage' && /^coverage-summary\.json$/i.test(baseNameOf(candidate.entry.path)));
      if (parsable && !exposure.sourceText) contentSkipped = true;
      if (parsable && exposure.sourceText && parsedCount < maxParse) {
        parsedCount += 1;
        const file = readProjectFile(candidate.entry.path, collection);
        if (file) {
          record.contentRead = true;
          const parsed = kind === 'coverage' ? parseCoverageSummary(file.text) : parsers[kind](file.text);
          if (!parsed) {
            record.kind = 'unknown';
            record.note = '内容は想定した形式（JUnit XML・TRX・coverage-summary.json）ではなかった。';
          } else if (kind === 'coverage') {
            Object.assign(record, { coverage: parsed });
          } else {
            Object.assign(record, { total: parsed.total, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped });
            if (parsed.durationSeconds !== undefined && parsed.durationSeconds !== null) record.durationSeconds = parsed.durationSeconds;
            if (parsed.outcome) record.outcome = parsed.outcome;
            if (parsed.timestamp) {
              record.recordedAt = parsed.timestamp;
              record.recordedAtSource = 'recordContent';
            }
          }
        }
      }
      records.push(record);
    }
    if (contentSkipped) collection.hidden.add('sourceText');
    if (truncated) {
      collection.truncated = true;
      collection.warnings.push('記録ファイルの候補が多いため、一部だけを調べました。');
    }
    return { records, truncated };
  }

  // テストの構成（枠組み・コマンド・設定ファイル・テストファイルの件数）を集める。
  function collectTestConfiguration(entries, markers) {
    const items = []; // テストの構成の項目。
    // テストの枠組みを、重複なく一覧へ足す。
    const addFramework = (name, basis, evidence, sourceKind, extra = {}) => {
      if (items.some(item => item.type === 'framework' && item.name === name)) return;
      items.push({ type: 'framework', name, status: 'known', basis, evidence, sourceKind, ...extra });
    };
    for (const manifest of markers.manifests) {
      const parsed = manifest.parsed;
      if (!parsed) continue;
      const label = manifestLabel(manifest);
      const evidence = fileEvidence(manifest.entry);
      if (manifest.rule.id === 'node') {
        for (const name of dependencyNamesOf(manifest)) {
          const framework = NODE_TEST_PACKAGES.get(name);
          if (framework) addFramework(framework, `${label} の依存に ${name} がある`, evidence, SOURCE_KIND.CONFIG);
        }
        for (const [name, command] of Object.entries(parsed.scripts)) {
          if (!/(?:^|[:_-])(?:test|tests|selftest|spec|e2e)(?:$|[:_-])/i.test(name)) continue;
          if (items.filter(item => item.type === 'command').length >= MAX_TEST_CONFIG_ITEMS) break;
          items.push({ type: 'command', script: name, command: exposure.paths ? clipText(command, MAX_COMMAND_CHARS) : null, ...(exposure.paths ? {} : { commandHidden: true }), status: 'known', basis: `${label} の scripts`, evidence, sourceKind: SOURCE_KIND.CONFIG, executed: false });
          if (/\bnode\b[^&|;]*--test\b/.test(command)) addFramework('Node.js のテストランナー（node --test）', `${label} の scripts.${name} のコマンド`, evidence, SOURCE_KIND.CONFIG);
        }
      } else if (manifest.rule.id.startsWith('python-')) {
        for (const name of dependencyNamesOf(manifest)) {
          const framework = PYTHON_TEST_PACKAGES.get(name.toLowerCase());
          if (framework) addFramework(framework, `${label} の依存に ${name} がある`, evidence, SOURCE_KIND.CONFIG);
        }
        if (parsed.pytestConfigured) addFramework('pytest', `${label} に pytest の設定（tool.pytest）がある`, evidence, SOURCE_KIND.CONFIG);
      } else if (manifest.rule.id === 'dotnet') {
        for (const name of parsed.runtimeDependencies) {
          const framework = DOTNET_TEST_PACKAGES.get(name.toLowerCase());
          if (framework) addFramework(framework, `${label} の PackageReference に ${name} がある`, evidence, SOURCE_KIND.CONFIG);
        }
      } else if (manifest.rule.id === 'cmake' && parsed.testing) {
        addFramework('CTest', `${label} に enable_testing / add_test がある`, evidence, SOURCE_KIND.CONFIG, { registeredTests: parsed.testCount });
      }
    }
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.depth > MARKER_MAX_DEPTH) continue;
      const rule = TEST_CONFIG_RULES.find(candidate => candidate.namePattern.test(baseNameOf(entry.path)));
      if (!rule) continue;
      if (items.filter(item => item.type === 'configFile').length >= MAX_TEST_CONFIG_ITEMS) break;
      items.push({ type: 'configFile', name: rule.name, status: 'known', basis: exposure.paths ? `${entry.path} がある` : `${rule.name} の設定ファイルがある`, evidence: fileEvidence(entry), sourceKind: SOURCE_KIND.STATIC_ANALYSIS });
    }
    const testFiles = entries.filter(entry => isTestFile(entry));
    if (testFiles.some(entry => /_test\.go$/.test(entry.path))) {
      items.push({ type: 'framework', name: 'go test', status: 'inferred', confidence: 'medium', basis: '_test.go のファイルがある（Go の規約）', evidence: [], sourceKind: SOURCE_KIND.STATIC_ANALYSIS });
    }
    items.push({
      type: 'testFiles',
      count: testFiles.length,
      status: 'known',
      basis: 'ファイル名・ディレクトリ名の規約（*.test.*・*.spec.*・test_*.py・*_test.go・*Tests.cs・*-selftest.*、テスト用ディレクトリ（test・tests・__tests__ など）の下のプログラム）に一致したファイルの数。テストであることは確かめていない',
      ...(exposure.paths ? { samples: testFiles.slice(0, MAX_TEST_FILE_SAMPLES).map(entry => entry.path) } : {}),
      sourceKind: SOURCE_KIND.STATIC_ANALYSIS,
    });
    return { items, testFiles };
  }

  // CI の設定ファイルを種類ごとに集める。
  function collectCiConfiguration(entries) {
    const groups = new Map(); // 種類 → ファイル。
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const rule = CI_RULES.find(candidate => candidate.pathPattern.test(entry.path));
      if (!rule) continue;
      const list = groups.get(rule.kind) || [];
      list.push(entry);
      groups.set(rule.kind, list);
    }
    return [...groups.entries()].map(([kind, list]) => ({
      kind,
      count: list.length,
      status: 'known',
      basis: exposure.paths ? `${list[0].path} がある${list.length > 1 ? `（ほか ${list.length - 1} 件）` : ''}` : `${kind} の設定ファイルがある`,
      ...(exposure.paths ? { paths: list.slice(0, 20).map(entry => entry.path) } : {}),
      evidence: exposure.paths ? list.slice(0, 20).flatMap(entry => fileEvidence(entry)) : [],
      latestModified: isoFromMs(Math.max(...list.map(entry => Number(entry.modifiedMs) || 0))),
      sourceKind: SOURCE_KIND.STATIC_ANALYSIS,
    }));
  }

  /*
    get_project_validation: ビルド設定・自動テストの構成・過去のテスト結果の記録・CI 設定を返す。
    「設定されている（configured）」「過去に記録がある（pastRecords）」「今回実行した（executedNow）」を別の項目に分け、ビルドとテストは実行しない。
  */
  function getValidation() {
    const tool = 'get_project_validation';
    const collectedAt = nowIso();
    const collection = newCollection();
    if (!exposure.paths) collection.hidden.add('paths');
    if (!exposure.sourceText) collection.hidden.add('sourceText');
    const walked = walkRoot();
    if (!walked.ok) return unavailableEnvelope(tool, collectedAt, walked.errorClass, 'ファイル構成を走査できませんでした。原因は特定できません。', collection);
    noteSplitWalk(walked, collection);
    if (walked.truncated) {
      collection.truncated = true;
      collection.warnings.push(`走査したエントリーが上限（${STRUCTURE_WALK_ENTRIES} 件）に達したため、構成の検出は途中までです。`);
    }
    const entries = walked.entries;
    const markers = detectMarkers(entries, collection);
    const build = buildBuildMethods(markers).map(item => ({ ...item, executed: false }));
    const tests = collectTestConfiguration(entries, markers);
    const ci = collectCiConfiguration(entries);
    const past = collectPastRecords(entries, collection, MAX_RECORDS);
    const configTimes = [
      ...markers.detections.map(detection => Number(detection.entry.modifiedMs) || 0),
      ...entries.filter(entry => entry.kind === 'file' && (CI_RULES.some(rule => rule.pathPattern.test(entry.path)) || TEST_CONFIG_RULES.some(rule => rule.namePattern.test(baseNameOf(entry.path))))).map(entry => Number(entry.modifiedMs) || 0),
    ].filter(Boolean);
    const recordTimes = past.records.map(record => Date.parse(record.fileModified || '')).filter(Number.isFinite);
    const newest = Math.max(0, ...configTimes, ...recordTimes);
    const notes = []; // 構成についての注意。
    if (build.length === 0) notes.push('ビルド方式の目印になるファイルは見つからなかった（ビルドが無いことを意味しない）。');
    if (ci.length === 0) notes.push('CI の設定ファイルは、決め打ちの候補の場所では見つからなかった（CI が無いことを意味しない）。');
    const facts = {
      executedNow: { performed: false, note: 'このサーバーはビルドもテストも実行しません' },
      configured: {
        status: build.length > 0 || ci.length > 0 || tests.items.some(item => item.type !== 'testFiles' || item.count > 0) ? 'known' : 'unknown',
        semantics: 'configured',
        build,
        tests: tests.items,
        ci,
        notes,
      },
      pastRecords: past.records.length > 0
        ? { found: true, count: past.records.length, records: past.records, note: '過去に作られた記録ファイルの内容で、今回の実行結果ではない。' }
        : { found: false, records: [], note: '決め打ちの候補の場所に記録ファイルは見つからなかった。テストが無い・失敗していることを意味しない。' },
      ciRunRecords: { status: 'unknown', note: 'CI の実行結果はリモートにあり、このサーバーからは見えません' },
      lastVerifiedAt: {
        value: newest > 0 ? new Date(newest).toISOString() : null,
        status: newest > 0 ? 'known' : 'unknown',
        note: '設定ファイル・記録ファイルの更新日時のうち最新のもの。テストやビルドが成功した日時ではない。',
      },
    };
    const sources = [describeSource(SOURCE_KIND.STATIC_ANALYSIS, collectedAt, null, '呼び出し時点のファイル構成の走査')];
    if (markers.manifests.some(manifest => !manifest.readFailed)) sources.push(describeSource(SOURCE_KIND.CONFIG, collectedAt, collection.configModified.filter(Boolean).sort().pop() || null, 'ビルド・テストの設定ファイルの本文'));
    if (past.records.length > 0) {
      const newestRecord = past.records.map(record => record.fileModified).filter(Boolean).sort().pop() || null;
      sources.push(describeSource(SOURCE_KIND.TEST_LOG, collectedAt, newestRecord, '過去に作られたテスト結果・網羅率・ベンチマークの記録ファイル'));
    }
    const inferences = [];
    if (past.records.length > 0) {
      inferences.push({
        claim: '記録は過去の実行結果であり、現在の状態を保証しない',
        basis: '記録の日時以降にコードや設定が変わったかは、このツールでは確かめられない',
        confidence: 'high',
        evidence: exposure.paths ? past.records.slice(0, 10).map(record => ({ type: 'file', path: record.path, modified: record.fileModified })) : [],
      });
    }
    if (tests.testFiles.length > 0) inferences.push({ claim: 'テストファイルの件数は名前の規約で数えたもので、実行できるか・成功するかは分からない。', basis: 'ファイル名の規約', confidence: 'high', evidence: [] });
    const evidence = exposure.paths ? [...markers.detections.slice(0, 30).flatMap(detection => fileEvidence(detection.entry)), ...ci.flatMap(item => item.evidence)] : [];
    return finishEnvelope({ tool, collectedAt, collection, sources, facts, inferences, evidence, limits: { walkMaxDepth: STRUCTURE_WALK_DEPTH, walkMaxEntries: STRUCTURE_WALK_ENTRIES, recordWalkDepth: RECORD_WALK_DEPTH, maxRecords: MAX_RECORDS, maxFileBytes: MAX_FILE_BYTES } });
  }

  // 横断サマリーのテスト状況を決める。記録 > 構成 > 見つからない（走査が完全なときだけ none-detected）> 不明。
  function portfolioTestStatus(walked, markers, collection) {
    if (!walked.ok) return { level: 'unknown', lastRecordedAt: null, summary: 'ファイル構成を走査できなかったため、テストの状況は分からない。' };
    const past = collectPastRecords(walked.entries, collection, exposure.sourceText ? PORTFOLIO_MAX_RECORDS_PARSED : 0);
    const testFiles = walked.entries.filter(entry => isTestFile(entry)).length;
    const configFiles = walked.entries.filter(entry => entry.kind === 'file' && TEST_CONFIG_RULES.some(rule => rule.namePattern.test(baseNameOf(entry.path)))).length;
    if (past.records.length > 0) {
      const latest = past.records.map(record => record.recordedAt).filter(Boolean).sort().pop() || null;
      const failed = past.records.reduce((total, record) => total + (Number(record.failed) || 0), 0);
      const withCounts = past.records.filter(record => record.total !== null).length;
      return {
        level: 'pastRecord',
        lastRecordedAt: latest,
        failedInRecords: withCounts > 0 ? failed : null,
        summary: `過去の記録ファイルが ${past.records.length} 件ある${withCounts > 0 ? `（記録上の失敗 ${failed} 件）` : '（内容は読んでいない）'}。過去の結果で、現在の状態は保証しない。`,
      };
    }
    if (testFiles > 0 || configFiles > 0) {
      return { level: 'configured', lastRecordedAt: null, summary: `テストの構成がある（名前の規約に合うテストファイル ${testFiles} 件、設定ファイル ${configFiles} 件）。実行結果の記録は見つからない。` };
    }
    if (walked.truncated) return { level: 'unknown', lastRecordedAt: null, summary: '走査を途中で打ち切ったため、テストの有無は分からない。' };
    return { level: 'none-detected', lastRecordedAt: null, summary: `浅い走査（深さ ${PORTFOLIO_WALK_DEPTH} まで）では、テストの構成も記録も見つからなかった。無いことを意味しない。` };
  }

  // 横断サマリーの「次に確認すべき事項」を、事実から機械的に作る。どれも提案で、断定ではない。
  function portfolioNextChecks({ documentsLoaded, git, testStatus, blockerCount, walked, nowMs }) {
    const checks = []; // 提案の文。
    const contextName = documentsLoaded.contextPath || '概要文書';
    const statusName = documentsLoaded.statusPath || '状態文書';
    if (!documentsLoaded.context) checks.push(`提案: 概要文書（${contextName}）を公開許可された文書として読めませんでした。設定の contextFile と allowFiles を確認してください。`);
    else if (documentsLoaded.context.templateUnfilled) checks.push(`提案: 概要文書（${contextName}）が空欄テンプレートのままのようです。目的と技術構成を記入するか確認してください。`);
    if (!documentsLoaded.status) {
      checks.push(`提案: 状態文書（${statusName}）を公開許可された文書として読めませんでした。設定の statusFile と allowFiles を確認してください。`);
    } else {
      const phase = findDocumentSection([documentsLoaded.status], DOCUMENT_FIELD_RULES.phase);
      if (documentsLoaded.status.templateUnfilled || (phase && !phase.filled)) checks.push(`提案: 状態文書（${statusName}）の現在状態が未記入のようです。現在のフェーズと実装済み機能を記入するか確認してください。`);
      const age = ageInDays(documentsLoaded.status.modified, nowMs);
      if (age !== null && age > RECENT_DOCUMENT_DAYS) checks.push(`提案: 状態文書の更新が約 ${age} 日前です。内容が今も正しいか確認してください。`);
    }
    if (git.status === STATUS.UNAVAILABLE) {
      if (git.errorClass === ERROR_CLASS.NOT_A_GIT_REPOSITORY) checks.push('提案: このプロジェクトは Git リポジトリのルートではないため、Git の情報はありません。意図した構成か確認してください。');
      else checks.push(`提案: Git の情報を取得できませんでした（分類: ${git.errorClass || '不明'}）。get_git_branches で詳細を確認してください。`);
    }
    if (Number.isFinite(git.uncommittedCount) && git.uncommittedCount > 0) checks.push(`提案: 未コミットの変更が ${git.uncommittedCount} 件あります。get_worktree_details で内容を確認してください。`);
    if (/^(?:unborn|none|no-?commits?|empty|missing)$/i.test(String(git.headState || ''))) checks.push('提案: HEAD がありません（まだコミットが無い可能性があります）。意図した状態か確認してください。');
    else if (/^detached$/i.test(String(git.headState || ''))) checks.push('提案: detached HEAD の状態です。意図した状態か確認してください。');
    if (blockerCount > 0) checks.push(`提案: 文書にブロッカーが ${blockerCount} 件書かれています。get_project_tasks で今も有効か確認してください。`);
    if (testStatus.level === 'pastRecord' && Number(testStatus.failedInRecords) > 0) checks.push(`提案: 過去のテスト記録に失敗が ${testStatus.failedInRecords} 件あります（記録の日時: ${testStatus.lastRecordedAt || '不明'}）。今も失敗するか確認してください。`);
    else if (testStatus.level === 'configured') checks.push('提案: テストの構成はありますが、実行結果の記録は見つかりませんでした。必要なら手元でテストを実行して確認してください。');
    else if (testStatus.level === 'none-detected' || testStatus.level === 'unknown') checks.push('提案: テストの構成・記録を確認できませんでした（無いとは限りません）。get_project_validation で確認してください。');
    if (walked.ok && walked.truncated) checks.push('提案: ファイル数が多く、軽量な走査を途中で打ち切りました。get_project_structure で確認してください。');
    return checks.slice(0, MAX_NEXT_CHECKS);
  }

  /*
    全プロジェクト横断サマリーの 1 件分を返す（envelope ではない）。全文の走査はせず、浅い走査と保存文書だけを使う。
    引数: { gitSummary }（server.mjs が Git 層から得た軽量情報。Promise でもよい。無ければ git.status は unavailable）
  */
  async function getPortfolioEntry({ gitSummary } = {}) {
    let summary = null; // Git の軽量情報。
    try { summary = await gitSummary; } catch { summary = null; }
    const nowMs = Date.now();
    const collection = newCollection();
    const walked = walkRoot(PORTFOLIO_WALK_DEPTH, PORTFOLIO_WALK_ENTRIES);
    const documentsLoaded = loadDocuments();
    collection.warnings.push(...documentsLoaded.warnings);
    if (!walked.ok) collection.warnings.push('ファイル構成を走査できませんでした。');
    else noteSplitWalk(walked, collection);
    if (walked.ok && walked.truncated) {
      collection.truncated = true;
      collection.warnings.push(`軽量な走査の上限（${PORTFOLIO_WALK_ENTRIES} 件）に達したため、言語・技術は途中までの集計です。`);
    }
    const entries = walked.ok ? walked.entries : [];
    const markers = detectMarkers(entries, collection, { readContent: false });
    const purposeItem = buildPurposeItem(documentsLoaded, PORTFOLIO_TEXT_MAX_CHARS);
    const languages = summarizeLanguages(entries.filter(entry => entry.kind === 'file')).filter(item => item.category === 'programming' && item.language !== 'C/C++ ヘッダー').slice(0, 3);
    const technologies = [
      ...languages.map(item => ({ name: item.language, status: 'known', kind: 'language', files: item.files })),
      ...[...groupDetections(markers.detections, rule => (['engine', 'runtime', 'buildSystem'].includes(rule.kind) ? rule.label : null)).keys()].slice(0, 5).map(name => ({ name, status: 'known', kind: 'marker' })),
    ];
    const hasGitSummary = summary !== null && typeof summary === 'object';
    if (hasGitSummary && !exposure.branchNames && summary.currentBranch) collection.hidden.add('branchNames');
    const git = {
      status: hasGitSummary ? (summary.status || STATUS.UNAVAILABLE) : STATUS.UNAVAILABLE,
      headState: hasGitSummary ? summary.headState ?? null : null,
      currentBranch: hasGitSummary && exposure.branchNames ? summary.currentBranch ?? null : null,
      uncommittedCount: hasGitSummary && Number.isFinite(summary.uncommittedCount) ? summary.uncommittedCount : null,
      errorClass: hasGitSummary ? summary.errorClass ?? null : null,
    };
    let implementationStatus; // 状態文書の現在状態の節。
    if (!documentsLoaded.status) {
      implementationStatus = { value: null, status: 'unknown', templateUnfilled: null, note: '状態文書を公開許可された文書として読めない。' };
    } else {
      const phase = findDocumentSection([documentsLoaded.status], DOCUMENT_FIELD_RULES.phase);
      if (phase?.filled) implementationStatus = { value: sectionText(phase.section, PORTFOLIO_TEXT_MAX_CHARS), status: 'known', templateUnfilled: false, evidence: [documentEvidence(phase)] };
      else if (phase) implementationStatus = { value: null, status: 'unknown', templateUnfilled: true, note: '状態文書の現在状態の節は空欄テンプレートのまま（未記入）。' };
      else implementationStatus = { value: null, status: 'unknown', templateUnfilled: documentsLoaded.status.templateUnfilled, note: '状態文書に現在状態の節が見つからない。' };
      noteDocument(collection, documentsLoaded.status);
    }
    const documentTasks = collectDocumentTasks(collection, nowMs).tasks;
    const blockerCount = documentTasks.filter(task => task.kind === 'doc-blocker').length;
    const testStatus = portfolioTestStatus(walked, markers, collection);
    const nextChecks = portfolioNextChecks({ documentsLoaded, git, testStatus, blockerCount, walked, nowMs });
    const unavailable = !walked.ok && !documentsLoaded.context && !documentsLoaded.status && !documentsLoaded.readme;
    return {
      projectName,
      os: osName,
      purpose: { value: purposeItem.value, status: purposeItem.status, evidence: purposeItem.evidence, ...(purposeItem.templateUnfilled ? { templateUnfilled: true } : {}) },
      technologies,
      lastActivityAt: summary?.lastCommitAt ?? null,
      git,
      implementationStatus,
      openIssues: {
        documentItemCount: documentTasks.length,
        blockerCount,
        codeTodoCount: null,
        note: 'コードの TODO は時間がかかるため数えていません。get_project_tasks で確認できます。文書の項目は今も未解決とは限りません。',
      },
      testStatus,
      nextChecks,
      detailTools: [...PORTFOLIO_DETAIL_TOOLS],
      collection: {
        status: unavailable ? STATUS.UNAVAILABLE : (collection.hidden.size > 0 || collection.truncated ? STATUS.PARTIAL : STATUS.OK),
        hidden: [...collection.hidden],
        errorClass: unavailable ? walked.errorClass : null,
        warnings: collection.warnings,
      },
    };
  }

  return { getStructure, getOverview, getTasks, getValidation, getPortfolioEntry };
}
