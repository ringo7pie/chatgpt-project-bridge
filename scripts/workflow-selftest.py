#!/usr/bin/env python3
"""クラウドへ接続せずAddProjectの状態機械とkey guardを検証する。"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # 試験で読み込む project-bridge.py の __pycache__ をリポジトリに作らない。


SCRIPT_ROOT = Path(__file__).resolve().parent  # 検証対象スクリプトの配置先。
BRIDGE = SCRIPT_ROOT / "project-bridge.py"  # Ubuntu向け中核CLI。
TUNNEL_A = "tunnel_" + "1" * 32  # 正常系で使う非実在Tunnel ID。
TUNNEL_B = "tunnel_" + "2" * 32  # mismatch検証用の非実在Tunnel ID。
FORBIDDEN_SAMPLES = {
    "LF": "\n",
    "U+2028": chr(0x2028),
    "U+2029": chr(0x2029),
    "U+202E": chr(0x202E),
    "U+200B": chr(0x200B),
    "ESC": "\x1b",
    "C1": "\x9b",
}  # 公開範囲の設定に使えない文字（共通仕様S1）の代表。名前から文字への対応。
QUOTE_VECTORS = [
    ("README.md", '"README.md"'),
    ('a"b', '"a\\"b"'),
    ("a\\b", '"a\\\\b"'),
    ("x\ny", '"x\\u000ay"'),
    ("a" + chr(0x2028) + "b", '"a\\u2028b"'),
    ("a" + chr(0x202E) + "b", '"a\\u202eb"'),
    ("a" + chr(0x3000) + "b", '"a\\u3000b"'),
    ("a\tb", '"a\\u0009b"'),
    ("日本語 a b", '"日本語 a b"'),
    ("\U0001F600", '"\U0001F600"'),
    ("\U000E0041", '"\\U000e0041"'),
    ("", '""'),
]  # 共通仕様S2の試験ベクトル（入力, 表示）。3言語で同じ出力になること。


# subprocessを秘密値なしの隔離環境で実行する。
# 新しいsessionで起動して制御端末を外し、getpassが/dev/ttyではなく渡したstdinを読むようにする。
def run_bridge(arguments: list[str], environment: dict[str, str], stdin: str = "", expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(BRIDGE), *arguments],
        input=stdin,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
        start_new_session=True,
        timeout=240,
    )
    if result.returncode != expected:
        raise AssertionError(f"return code {result.returncode} != {expected}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")
    return result


# official CLIの必要部分だけを再現するfake clientを作る。
def write_fake_client(path: Path) -> None:
    source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

args = sys.argv[1:]
log = Path(os.environ["FAKE_TUNNEL_LOG"])
if "--help" in args:
    print("--profile-dir --control-plane-api-key-ref --profile --pid.file --log.file --health.url-file")
    raise SystemExit(0)
action = args[0] if args else ""
with log.open("a", encoding="utf-8") as stream:
    stream.write(action + "\n")
if action == "init":
    if os.environ.get("FAKE_INIT_FAIL") == "1":
        raise SystemExit(23)
    def value(flag):
        return args[args.index(flag) + 1]
    profile_dir = Path(value("--profile-dir"))
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / f"{value('--profile')}.yaml").write_text(
        "tunnel: " + value("--tunnel-id") + "\ncommand: " + value("--mcp-command") + "\n",
        encoding="utf-8",
    )
elif action == "doctor":
    raise SystemExit(0)
elif action == "run":
    raise SystemExit(0)
'''
    path.write_text(source, encoding="utf-8", newline="\n")
    path.chmod(0o755)


# configからprofile名と隔離key/profileのパスを返す。
def state_paths(project: Path, home: Path) -> tuple[Path, Path]:
    config = json.loads((project / ".chatgpt-project-bridge.json").read_text(encoding="utf-8"))
    profile = config["profileName"]
    return (
        home / ".config" / "tunnel-client" / "profiles" / f"{profile}.yaml",
        home / ".config" / "tunnel-client" / "secrets" / f"{profile}.key",
    )


# configからprofile名を読み、隔離homeでの公開範囲承認ファイルのパスを返す。
def approval_path(project: Path, home: Path) -> Path:
    config = json.loads((project / ".chatgpt-project-bridge.json").read_text(encoding="utf-8"))
    return home / ".config" / "chatgpt-project-bridge" / "approvals" / f"{config['profileName']}.json"


# 同梱MCPサーバーに現在の公開範囲と指紋を出力させる。
def print_exposure(project: Path, environment: dict[str, str]) -> dict:
    node = environment.get("BRIDGE_TEST_NODE") or "node"  # 試験に使うNode.js。
    result = subprocess.run(
        [node, str(SCRIPT_ROOT / "server.mjs"), "--print-exposure", "--project-root", str(project), "--config", str(project / ".chatgpt-project-bridge.json")],
        text=True,
        capture_output=True,
        env=environment,
        check=True,
    )
    return json.loads(result.stdout)


# 配下の全エントリについて、種別・mode・内容のSHA-256を集める。書き込みの有無を前後比較するために使う。
def snapshot_tree(base: Path) -> dict[str, str]:
    entries: dict[str, str] = {}  # 相対パスから「種別・mode・内容ハッシュ」への対応。
    for item in sorted(base.rglob("*")):
        relative = item.relative_to(base).as_posix()
        mode = stat.S_IMODE(item.lstat().st_mode)
        if item.is_symlink():
            entries[relative] = f"symlink {mode:o} {os.readlink(item)}"
        elif item.is_dir():
            entries[relative] = f"dir {mode:o}"
        else:
            entries[relative] = f"file {mode:o} {hashlib.sha256(item.read_bytes()).hexdigest()}"
    return entries


# show-exposureの出力が決められた形のJSON 1つだけであることを確かめて返す。
def parse_exposure_report(result: subprocess.CompletedProcess[str]) -> dict:
    assert result.stderr == "", f"show-exposureが標準エラーへ出力した: {result.stderr}"
    report = json.loads(result.stdout)  # 標準出力全体が1つのJSONでなければここで失敗する。
    expected_types = {
        "schemaVersion": int,
        "projectRoot": str,
        "profile": str,
        "exposureSha256": str,
        "approvalState": str,
        "approvedSha256": (str, type(None)),
        "approvedProjectRoot": (str, type(None)),
        "exposure": dict,
        "changes": list,
    }  # 出力JSONのフィールド名と型。approvedProjectRoot は承認ファイルに記録されたフォルダー（共通仕様S4）。
    assert list(report) == list(expected_types), f"フィールドが想定と違う: {list(report)}"
    for name, expected_type in expected_types.items():
        assert isinstance(report[name], expected_type), f"{name}の型が違う: {report[name]!r}"
    assert report["schemaVersion"] == 1
    assert len(report["exposureSha256"]) == 64 and set(report["exposureSha256"]) <= set("0123456789abcdef")
    assert report["approvalState"] in {"approved", "unapproved", "changed"}
    if report["approvedSha256"] is not None:
        assert len(report["approvedSha256"]) == 64 and set(report["approvedSha256"]) <= set("0123456789abcdef")
    assert all(isinstance(line, str) and line for line in report["changes"])
    return report


# show-exposureが何も書き込まず、未承認・承認済み・変更ありを正しく返すことを、専用の隔離homeで確かめる。
def check_show_exposure(root: Path, base_environment: dict[str, str]) -> None:
    home = root / "show-exposure-home"
    project = root / "show-exposure-project"
    home.mkdir(); project.mkdir()
    (project / "README.md").write_text("# Show Exposure Test\n", encoding="utf-8")
    environment = base_environment.copy()
    environment.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "XDG_STATE_HOME": str(home / ".local" / "state")})
    config_file = project / ".chatgpt-project-bridge.json"  # 公開設定。
    approvals = home / ".config" / "chatgpt-project-bridge" / "approvals"  # 承認ディレクトリ。

    help_text = run_bridge(["--help"], environment).stdout
    for action in ("show-exposure", "approve", "hub-add", "hub-service-uninstall"):
        assert action in help_text, f"--helpのAction一覧に{action}が無い"

    run_bridge(["init", "--project-root", str(project), "--project-name", "ShowExposureTest"], environment)
    profile = json.loads(config_file.read_text(encoding="utf-8"))["profileName"]  # 設定から解決されるプロファイル名。
    current = print_exposure(project, environment)  # server.mjsが返す現在の指紋と公開範囲。

    # 1. 未承認の状態では、決められた形のJSONを返し、承認ディレクトリも作らない。
    before = snapshot_tree(root)
    unapproved = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(project)], environment))
    assert snapshot_tree(root) == before, "未承認のshow-exposureがファイルを作成・変更した"
    assert not approvals.exists(), "show-exposureが承認ディレクトリを作成した"
    assert unapproved["projectRoot"] == str(project.resolve()) and unapproved["profile"] == profile
    assert unapproved["exposureSha256"] == current["sha256"] and unapproved["exposure"] == current["exposure"]
    assert unapproved["approvalState"] == "unapproved" and unapproved["approvedSha256"] is None and unapproved["changes"] == []
    assert unapproved["approvedProjectRoot"] is None

    # 別名とプロファイル明示でも同じ読み取り専用の結果になる。
    for alias in ("ShowExposure", "show_exposure"):
        assert parse_exposure_report(run_bridge([alias, "--project-root", str(project)], environment)) == unapproved
    explicit = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(project), "--profile", "explicit-profile"], environment))
    assert explicit["profile"] == "explicit-profile" and explicit["approvalState"] == "unapproved"
    assert snapshot_tree(root) == before, "別名・プロファイル明示のshow-exposureがファイルを作成・変更した"

    # 2. 承認すると approved になり、承認済みの指紋が返る。表示だけでは承認ファイルを変更しない。
    run_bridge(["approve", "--project-root", str(project), "--exposure-sha256", unapproved["exposureSha256"]], environment)
    approval_file = approvals / f"{profile}.json"
    assert approval_file.is_file() and stat.S_IMODE(approval_file.stat().st_mode) == 0o600
    before = snapshot_tree(root)
    approved = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(project)], environment))
    assert snapshot_tree(root) == before, "承認済みのshow-exposureがファイルを作成・変更した"
    assert approved["approvalState"] == "approved" and approved["approvedSha256"] == unapproved["exposureSha256"] and approved["changes"] == []
    assert approved["approvedProjectRoot"] == str(project.resolve())

    # 3. 設定を変えると changed になり、承認時の指紋と差分の行が返る。
    config = json.loads(config_file.read_text(encoding="utf-8"))
    config["gitExposure"] = {"paths": True, "commitSubjects": False}
    config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    before = snapshot_tree(root)
    changed = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(project)], environment))
    assert snapshot_tree(root) == before, "変更ありのshow-exposureがファイルを作成・変更した"
    assert changed["approvalState"] == "changed" and changed["approvedSha256"] == unapproved["exposureSha256"]
    assert changed["exposureSha256"] != unapproved["exposureSha256"] and changed["exposureSha256"] == print_exposure(project, environment)["sha256"]
    assert changed["changes"] and any(line.startswith("gitExposure:") for line in changed["changes"]), changed["changes"]
    # approveが表示する差分と同じ行であること。ここで承認は保存しない（--exposure-sha256に古い指紋を渡して拒否させる）。
    refused = run_bridge(["approve", "--project-root", str(project), "--exposure-sha256", unapproved["exposureSha256"]], environment, expected=1)
    for line in changed["changes"]:
        assert f"  - {line}" in refused.stdout, f"approveの差分表示にshow-exposureの行が無い: {line}"

    # 4. 存在しない・未指定のproject-root、設定が無いフォルダーは、標準出力へ何も出さず終了コード1で失敗する。
    empty_project = root / "show-exposure-empty"
    empty_project.mkdir()
    failures = [
        ["show-exposure", "--project-root", str(root / "no-such-project")],
        ["show-exposure"],
        ["show-exposure", "--project-root", str(empty_project)],
    ]  # 失敗させる引数の組。
    for arguments in failures:
        failed = run_bridge(arguments, environment, expected=1)
        assert failed.stdout == "" and failed.stderr.startswith("ERROR:"), f"{arguments}: STDOUT={failed.stdout!r} STDERR={failed.stderr!r}"
    assert not (empty_project / ".chatgpt-project-bridge.json").exists()


# 隔離したhomeを指す環境変数を返す。
def isolated_environment(base_environment: dict[str, str], home: Path) -> dict[str, str]:
    environment = base_environment.copy()
    environment.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "XDG_STATE_HOME": str(home / ".local" / "state"), "XDG_DATA_HOME": str(home / ".local" / "share")})
    return environment


# 公開設定を書く。
def write_config(project: Path, config: dict) -> None:
    (project / ".chatgpt-project-bridge.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# init（自己試験とサーバーのGit収集を含む）を通さずに、最小の公開設定と文書を書く。overrides で設定の項目を置き換える。
def write_minimal_project(project: Path, name: str, **overrides: object) -> dict:
    project.mkdir(parents=True, exist_ok=True)
    (project / "README.md").write_text(f"# {name}\n", encoding="utf-8")
    (project / "CHATGPT_PROJECT_CONTEXT.md").write_text("# Context\n", encoding="utf-8")
    (project / "CHATGPT_PROJECT_STATUS.md").write_text("# Status\n", encoding="utf-8")
    config = {
        "schemaVersion": 1,
        "projectName": name,
        "contextFile": "CHATGPT_PROJECT_CONTEXT.md",
        "statusFile": "CHATGPT_PROJECT_STATUS.md",
        "profileName": f"chatgpt-{name.lower()}-00000000",
        "tunnelId": None,
        "healthPort": None,
        "allowFiles": ["CHATGPT_PROJECT_CONTEXT.md", "CHATGPT_PROJECT_STATUS.md", "README.md"],
        "allowDirectories": [],
        "denyDirectories": [".git", "node_modules"],
        "maxDocumentBytes": 524288,
        "gitExposure": {"paths": False, "commitSubjects": False},
    }  # 書き込む公開設定。
    config.update(overrides)
    write_config(project, config)
    return config


# 1文字を表示用の \uXXXX にする（試験で使う文字はすべてBMP内）。
def escaped(character: str) -> str:
    return f"\\u{ord(character):04x}"


# 共通仕様S2の試験ベクトルで、表示用の引用（quote_for_display）と禁止文字の判定を確かめる。
def check_quote_vectors() -> None:
    spec = importlib.util.spec_from_file_location("project_bridge_under_test", BRIDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for value, expected in QUOTE_VECTORS:
        actual = module.quote_for_display(value)
        assert actual == expected, f"quote_for_display({value!r}) = {actual!r}（期待 {expected!r}）"
    # 書式文字・対にならないサロゲートは禁止文字。U+0020以外の空白類（U+00A0）は禁止しないが、表示では退避する。
    assert module.has_forbidden_character("a" + chr(0xAD) + "b") and module.has_forbidden_character("a\ud800b") and module.has_forbidden_character("a\U000e0041b")
    assert not module.has_forbidden_character("a" + chr(0xA0) + "b") and not module.has_forbidden_character("日本語 " + chr(0x1F600))
    assert module.quote_for_display("a" + chr(0xA0) + "b") == '"a\\u00a0b"' and module.quote_for_display("\ud800") == '"\\ud800"'


# git config --list --show-scope -z の出力から実行を伴いうる設定を探す規則（共通仕様S5と例外E1・E2）を、出力を組み立てて確かめる。
def check_git_config_rules() -> None:
    spec = importlib.util.spec_from_file_location("project_bridge_git_rules", BRIDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    separator = chr(0)  # 項目の区切り（NUL）。
    newline = chr(10)  # キーと値の区切り（LF）。

    # (scope, キー, 値) の並びから、git config の -z 出力を組み立てる。値が None ならキーだけの行にする。
    def listing(*entries: tuple[str, str, str | None]) -> str:
        return "".join(f"{scope}{separator}{key}{'' if value is None else newline + value}{separator}" for scope, key, value in entries)

    lfs = [("local", "filter.lfs.clean", "git-lfs clean -- %f"), ("local", "filter.lfs.smudge", "git-lfs smudge -- %f"), ("local", "filter.lfs.process", "git-lfs filter-process"), ("local", "filter.lfs.required", "true")]
    cases = [
        (listing(*lfs), None),
        (listing(("local", "filter.lfs.smudge", "git-lfs smudge --skip -- %f"), ("local", "filter.lfs.process", "git-lfs filter-process --skip")), None),
        (listing(("local", "filter.lfs.clean", "git-lfs clean -- %f; touch x")), "filter.lfs.clean"),
        (listing(("local", "filter.LFS.clean", "git-lfs clean -- %f")), "filter.LFS.clean"),
        (listing(("local", "filter.lfs.clean", None)), "filter.lfs.clean"),
        (listing(("local", "filter.lfs.clean", "git-lfs clean -- %f"), ("local", "filter.lfs.clean", "sh -c evil")), "filter.lfs.clean"),
        (listing(("local", "filter.lfs.clean", "GIT-LFS CLEAN -- %f")), "filter.lfs.clean"),
        (listing(("local", "submodule.x.url", "https://example.invalid/x.git"), ("local", "submodule.active", "."), ("local", "submodule.x.branch", "main")), None),
        (listing(("local", "submodule.x.update", "!sh")), "submodule.x.update"),
        (listing(("system", "core.fsmonitor", "x"), ("global", "alias.st", "status"), ("command", "core.fsmonitor", "false")), None),
        (listing(("worktree", "Core.FSMonitor", "x")), "Core.FSMonitor"),
        (listing(("local", "remote.origin.url", "https://example.invalid/r.git"), ("local", "remote.origin.uploadpack", "x")), "remote.origin.uploadpack"),
    ]  # (git config の出力, 見つかるべきキー。None なら見つからない)。
    for text, expected in cases:
        actual = module.find_unsafe_git_config_key(text)
        assert actual == expected, f"{text!r}: {actual!r}（期待 {expected!r}）"


# 省略形のオプション（--exposure は --exposure-sha256 の省略形）を受け付けず、承認もしないことを確かめる。
def check_no_abbreviation(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "abbreviation"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    project = base / "project"
    config = write_minimal_project(project, "Abbreviation")
    approval_file = home / ".config" / "chatgpt-project-bridge" / "approvals" / f"{config['profileName']}.json"  # 作られてはいけない承認ファイル。
    sha = print_exposure(project, environment)["sha256"]
    refused = run_bridge(["approve", "--project-root", str(project), "--exposure", sha], environment, expected=2)
    assert "--exposure" in refused.stderr and not approval_file.exists(), refused.stderr
    run_bridge(["approve", "--project-root", str(project), "--exposure-sha256", sha], environment)
    assert approval_file.is_file(), "正式なオプション名での承認ができない"


# 公開範囲の設定に使えない文字（共通仕様S1）があれば、show-exposure・approve・init が何も書かずに終了コード1で止まり、
# 引用して見える形にした値をERRORの1行で出すことを確かめる。
def check_forbidden_characters(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "forbidden"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    approvals = home / ".config" / "chatgpt-project-bridge" / "approvals"  # 作られてはいけない承認ディレクトリ。
    fields = ["allowFiles", "denyDirectories", "allowDirectories", "allowFiles", "statusFile", "projectName", "contextFile"]  # 文字ごとに入れる設定の項目。
    for (label, character), field in zip(FORBIDDEN_SAMPLES.items(), fields):
        project = base / f"project-{label}"
        config = write_minimal_project(project, "Forbidden")
        value = f"bad{character}name.md"  # 禁止文字を途中に含む値。
        if field in ("allowFiles", "denyDirectories"):
            config[field] = [*config[field], value]
            item_label = f"{field}[{len(config[field]) - 1}]"
        elif field == "allowDirectories":
            config[field] = [{"path": "docs", "recursive": True}, {"path": value, "recursive": False}]
            item_label = "allowDirectories[1].path"
        else:
            config[field] = value
            item_label = field
        write_config(project, config)
        expected = f'公開範囲の設定に使えない文字が含まれています: {item_label} = "bad{escaped(character)}name.md"'  # 期待するエラー文。
        before = snapshot_tree(base)
        attempts = [
            (["show-exposure", "--project-root", str(project)], ""),
            (["approve", "--project-root", str(project), "--exposure-sha256", "0" * 64], ""),
            (["approve", "--project-root", str(project)], "yes\n"),
        ]  # 失敗させる引数と標準入力の組。
        for arguments, stdin in attempts:
            failed = run_bridge(arguments, environment, stdin, expected=1)
            assert failed.stdout == "", f"{label} {arguments[0]}: 承認の表示へ進んだ: {failed.stdout!r}"
            assert failed.stderr == f"ERROR: {expected}\n", f"{label} {arguments[0]}: {failed.stderr!r}"
        assert snapshot_tree(base) == before, f"{label}: 拒否したのにファイルが作成・変更された"
        assert not approvals.exists(), f"{label}: 承認ディレクトリが作られた"

    # init: プロジェクトルートのフォルダー名、またはプロジェクト名に禁止文字があれば、設定も文書も作らない。
    for label, character in FORBIDDEN_SAMPLES.items():
        bad_root = base / f"init{character}dir"  # 禁止文字を名前に含むフォルダー。
        bad_root.mkdir()
        named = base / f"init-name-{label}"  # 名前だけが不正なプロジェクト。
        named.mkdir()
        before = snapshot_tree(base)
        failed = run_bridge(["init", "--project-root", str(bad_root)], environment, expected=1)
        assert failed.stderr.startswith("ERROR:") and f"init{escaped(character)}dir" in failed.stderr and failed.stderr.count("\n") == 1, f"{label}: {failed.stderr!r}"
        failed = run_bridge(["init", "--project-root", str(named), "--project-name", f"Name{character}X"], environment, expected=1)
        assert failed.stderr == f'ERROR: 公開範囲の設定に使えない文字が含まれています: projectName = "Name{escaped(character)}X"\n', f"{label}: {failed.stderr!r}"
        assert snapshot_tree(base) == before, f"{label}: initが拒否したのにファイルを作成・変更した"


# 紛らわしいが良性の設定（拒否ディレクトリの1項目がカンマ区切りの文字列）でも、承認の表示が1項目1行・引用符付き・件数付きになり、
# 表示の最後が要約と指紋で、その直後がプロンプトになることを確かめる。
def check_approval_display(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "display"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    project = base / "project"
    config = write_minimal_project(project, "Display", denyDirectories=[".git", "a, b, c", "node_modules"], allowDirectories=[{"path": "docs", "recursive": True}, {"path": "notes", "recursive": False}])
    current = print_exposure(project, environment)  # サーバーが正規化した公開範囲と指紋。
    refused = run_bridge(["approve", "--project-root", str(project)], environment, "no\n", expected=1)
    assert "承認されなかった" in refused.stderr
    lines = refused.stdout.split("\n")  # 表示の各行。最後の要素は改行の無いプロンプト。
    files = current["exposure"]["allowFiles"]  # 公開ファイル（並べ替え済み）。
    denied = current["exposure"]["denyDirectories"]  # 拒否ディレクトリ（並べ替え済み）。
    assert lines[0] == "公開範囲の確認（承認状態: 未承認）", lines[:3]
    assert lines[1] == f"プロジェクトルート: {json.dumps(str(project.resolve()))}" and lines[2] == f'プロファイル: "{config["profileName"]}"', lines[:3]
    start = lines.index(f"公開ファイル（{len(files)} 件）:")
    assert lines[start + 1 : start + 1 + len(files)] == [f"  {number}. {json.dumps(item)}" for number, item in enumerate(files, start=1)], lines
    start = lines.index("公開ディレクトリ（2 件）:")
    assert lines[start + 1 : start + 3] == ['  1. "docs"（配下すべて）', '  2. "notes"（直下だけ）'], lines
    start = lines.index(f"拒否ディレクトリ（{len(denied)} 件）:")
    assert lines[start + 1 : start + 1 + len(denied)] == [f"  {number}. {json.dumps(item)}" for number, item in enumerate(denied, start=1)], lines
    assert '  2. "a, b, c"' in lines, "カンマを含む1項目が1行・引用符付きで出ていない"
    assert lines[-1] == "この公開範囲をChatGPTへ公開することを承認しますか? [yes/NO]: ", lines[-2:]
    assert lines[-5:-1] == [
        "─── 承認する内容の要約（最終確認） ───",
        f"公開ファイル {len(files)} 件 / 公開ディレクトリ 2 件（うち配下すべて 1 件） / 拒否ディレクトリ {len(denied)} 件",
        "Git のファイル名: 非公開 / Git のコミット件名: 非公開",
        f"公開範囲の指紋（SHA-256）: {current['sha256']}",
    ], lines[-6:]
    assert not (home / ".config" / "chatgpt-project-bridge" / "approvals" / f"{config['profileName']}.json").exists()


# 承認ファイルが不正なUTF-8・所有者以外が書き込める場合は「未承認」として扱い（公開する側へ倒さない）、
# 承認ディレクトリを所有者以外が書き込める場合は show-exposure が失敗することを確かめる。
def check_approval_file_hardening(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "hardening"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    project = base / "project"
    config = write_minimal_project(project, "Hardening")
    sha = print_exposure(project, environment)["sha256"]
    run_bridge(["approve", "--project-root", str(project), "--exposure-sha256", sha], environment)
    approvals = home / ".config" / "chatgpt-project-bridge" / "approvals"  # 承認ディレクトリ。
    approval_file = approvals / f"{config['profileName']}.json"  # 承認ファイル。
    original = approval_file.read_bytes()  # 正しい承認の内容。
    show = ["show-exposure", "--project-root", str(project)]  # 確認に使う引数。
    assert parse_exposure_report(run_bridge(show, environment))["approvalState"] == "approved"

    approval_file.write_bytes(b'{"sha256": "\xff\xfe", "exposure": {}}\n')
    report = parse_exposure_report(run_bridge(show, environment))
    assert report["approvalState"] == "unapproved" and report["approvedSha256"] is None and report["approvedProjectRoot"] is None, report

    approval_file.write_bytes(original)
    os.chmod(approval_file, 0o620)
    assert parse_exposure_report(run_bridge(show, environment))["approvalState"] == "unapproved", "所有者以外が書き込める承認ファイルを信用した"
    os.chmod(approval_file, 0o600)
    assert parse_exposure_report(run_bridge(show, environment))["approvalState"] == "approved"

    os.chmod(approvals, 0o777)
    try:
        failed = run_bridge(show, environment, expected=1)
        assert failed.stdout == "" and failed.stderr.startswith("ERROR:") and "書き込み権" in failed.stderr, failed.stderr
    finally:
        os.chmod(approvals, 0o700)


# show-exposure の approvedProjectRoot（共通仕様S4）が、承認済み・別フォルダーの承認・承認なしで正しいこと、
# 別フォルダーの承認を上書きする approve は表示の冒頭に警告を出し、非対話（--exposure-sha256）でも警告したうえで承認することを確かめる。
def check_approved_project_root(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "approved-root"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    first = base / "first"
    second = base / "second"
    fresh = base / "fresh"
    write_minimal_project(first, "Shared")
    write_minimal_project(second, "Shared")  # 同じプロファイル名（設定を別のフォルダーへ複製した状態）。
    write_minimal_project(fresh, "Fresh")
    run_bridge(["approve", "--project-root", str(first), "--exposure-sha256", print_exposure(first, environment)["sha256"]], environment)

    approved = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(first)], environment))
    assert approved["approvalState"] == "approved" and approved["approvedProjectRoot"] == str(first.resolve()) == approved["projectRoot"], approved
    other = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(second)], environment))
    assert other["approvalState"] == "changed" and other["approvedProjectRoot"] == str(first.resolve()) != other["projectRoot"], other
    unapproved = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(fresh)], environment))
    assert unapproved["approvalState"] == "unapproved" and unapproved["approvedProjectRoot"] is None, unapproved

    warning = f"警告: このプロファイル名は別のフォルダー {json.dumps(str(first.resolve()))} の承認に使われています。承認すると、そのフォルダーの承認が上書きされます。"  # 期待する警告。
    refused = run_bridge(["approve", "--project-root", str(second)], environment, "no\n", expected=1)
    assert warning in refused.stdout and refused.stdout.index(warning) < refused.stdout.index("公開範囲の確認（承認状態: 前回から変更あり）"), refused.stdout
    accepted = run_bridge(["approve", "--project-root", str(second), "--exposure-sha256", other["exposureSha256"]], environment)
    assert warning in accepted.stdout and "承認を保存しました" in accepted.stdout, accepted.stdout
    overwritten = parse_exposure_report(run_bridge(["show-exposure", "--project-root", str(first)], environment))
    assert overwritten["approvalState"] == "changed" and overwritten["approvedProjectRoot"] == str(second.resolve()), overwritten
    plain = run_bridge(["approve", "--project-root", str(fresh)], environment, "no\n", expected=1)
    assert "警告:" not in plain.stdout, "別フォルダーの承認が無いのに警告した"


# .git/config に実行を伴いうる設定（core.fsmonitor など）があるとき、update が Git を実行せず（フックのマーカーが作られず）、
# 理由を表示して「Git情報なし」で状態文書を更新すること、普通のリポジトリ・Git LFS の正規の設定・サブモジュールのデータ用のキー
# （共通仕様S5の例外E1・E2）では従来どおり Git 情報を集めること、サブモジュールの中のフィルターを実行しないことを確かめる。
def check_git_safety(root: Path, base_environment: dict[str, str]) -> None:
    git = shutil.which("git", path=base_environment.get("PATH"))  # 試験に使うGit。
    if not git:
        print("SKIP: git が無いため、Git の安全な実行の試験を省略しました。")
        return
    base = root / "git"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    marker = base / "hook-ran"  # フック・フィルター・コマンドが実行されたら作られるファイル。
    hook = base / "fsmonitor-hook"  # core.fsmonitor に設定する実行ファイル。
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)

    # Gitを試験用の隔離した環境で実行する。
    def run_git(arguments: list[str], cwd: Path) -> None:
        subprocess.run([git, *arguments], cwd=cwd, env=environment, check=True, capture_output=True, text=True, timeout=60)

    # Gitリポジトリを作り、空のコミットを1つ置く。
    def new_repository(project: Path) -> None:
        run_git(["init", "-q"], project)
        run_git(["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], project)

    # update を実行し、Git情報を集めたか（集めなかったときは理由に出るキー）を確かめる。expected_key が None なら集めること。
    def assert_update(project: Path, expected_key: str | None, label: str) -> None:
        assert not marker.exists(), f"{label}: 試験の準備でフックやフィルターが実行された"
        updated = run_bridge(["update", "--project-root", str(project)], environment)
        assert not marker.exists(), f"{label}: update がフックやフィルターを実行した"
        status_text = (project / "CHATGPT_PROJECT_STATUS.md").read_text(encoding="utf-8")
        if expected_key is None:
            assert "Git の情報を取得しません" not in updated.stdout, f"{label}: {updated.stdout}"
            assert "ブランチ：Git情報なし" not in status_text and "HEAD：Git情報なし" not in status_text, f"{label}: {status_text}"
        else:
            assert f"Git の情報を取得しません: .git/config に実行を伴いうる設定があります: {expected_key}" in updated.stdout, f"{label}: {updated.stdout}"
            assert "ブランチ：Git情報なし" in status_text and "HEAD：Git情報なし" in status_text, f"{label}: {status_text}"

    lfs_values = {"clean": "git-lfs clean -- %f", "smudge": "git-lfs smudge -- %f", "process": "git-lfs filter-process"}  # Git LFS が書く正規の値。
    skip_values = {**lfs_values, "smudge": "git-lfs smudge --skip -- %f", "process": "git-lfs filter-process --skip"}  # git lfs install --skip-smudge の値。
    # (名前, git config へ書く (キー, 値) の一覧, 理由に出るキー。None なら Git 情報を集める)。
    cases = [
        ("clean", [], None),
        ("fsmonitor", [("core.fsmonitor", str(hook))], "core.fsmonitor"),
        ("alias", [("alias.st", "status")], "alias.st"),
        ("lfs", [(f"filter.lfs.{name}", value) for name, value in lfs_values.items()] + [("filter.lfs.required", "true")], None),
        ("lfs-skip", [(f"filter.lfs.{name}", value) for name, value in skip_values.items()], None),
        ("lfs-tampered", [(f"filter.lfs.{name}", value) for name, value in {**lfs_values, "clean": f"git-lfs clean -- %f; touch '{marker}'"}.items()], "filter.lfs.clean"),
        ("submodule-data", [("submodule.x.url", "https://example.invalid/x.git"), ("submodule.x.branch", "main"), ("submodule.active", ".")], None),
        ("submodule-update", [("submodule.x.url", "https://example.invalid/x.git"), ("submodule.x.update", f"!touch '{marker}'")], "submodule.x.update"),
    ]
    for name, settings, expected_key in cases:
        project = base / name
        write_minimal_project(project, f"Git{name}")
        new_repository(project)
        for key, value in settings:
            run_git(["config", "--add", key, value], project)
        assert_update(project, expected_key, name)

    # .git がファイル（gitdir:）の作業ツリーでも、元のリポジトリの .git/config を検査する。
    worktree = base / "worktree"
    run_git(["worktree", "add", "-q", str(worktree)], base / "clean")
    run_git(["config", "core.fsmonitor", str(hook)], base / "clean")
    write_minimal_project(worktree, "GitWorktree")
    assert_update(worktree, "core.fsmonitor", "worktree")

    # サブモジュールの中（検査していない子の .git/config）の clean フィルターを、update が実行しない。親の submodule.*.url・active は妨げない。
    source = base / "submodule-source"
    source.mkdir()
    new_repository(source)
    (source / ".gitattributes").write_text("data.txt filter=evil\n", encoding="utf-8")
    (source / "data.txt").write_text("hello\n", encoding="utf-8")
    run_git(["add", ".gitattributes", "data.txt"], source)
    run_git(["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "data"], source)
    parent = base / "submodule-parent"
    write_minimal_project(parent, "GitParent", gitExposure={"paths": True, "commitSubjects": False})
    new_repository(parent)
    run_git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "child"], parent)
    run_git(["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "child"], parent)
    filter_script = base / "evil-clean"  # 子の clean フィルター。実行されたらマーカーを作る。
    filter_script.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n", encoding="utf-8")
    filter_script.chmod(0o755)
    run_git(["config", "filter.evil.clean", str(filter_script)], parent / "child")
    child_data = parent / "child" / "data.txt"  # 大きさを変えずに内容と時刻だけ変え、git に内容の比較（clean フィルター）をさせる。
    child_data.write_text("HELLO\n", encoding="utf-8")
    os.utime(child_data, (978307200, 978307200))
    assert_update(parent, None, "submodule-filter")
    assert "child" in (parent / "CHATGPT_PROJECT_STATUS.md").read_text(encoding="utf-8"), "サブモジュールの一覧（gitExposure.paths）が集まっていない"


# 公開範囲が64 KiBを超えても（allowFiles 3,000件）、show-exposure が全件を返すことを確かめる（server.mjs が出力を最後まで書くこと）。
def check_large_exposure(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "large"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    project = base / "project"
    files = [f"docs/file-{index:04d}-abcdefghijklmnop.md" for index in range(3000)]  # 公開ファイルの一覧（存在しなくてよい）。
    write_minimal_project(project, "Large", allowFiles=["README.md", *files])
    result = run_bridge(["show-exposure", "--project-root", str(project)], environment)
    assert len(result.stdout.encode("utf-8")) > 64 * 1024, "試験の前提（出力が64 KiBを超える）を満たしていない"
    report = parse_exposure_report(result)
    assert len(report["exposure"]["allowFiles"]) == len(files) + 1 and report["approvalState"] == "unapproved"


# Skillアーカイブも導入済みSkillも無い場所でインストーラーを実行すると、照合を尋ねる前に、Bundleの作り方を案内して止まる。
# 入力は空にする（順番が元に戻って照合を尋ねても、答えが無いのでそこで止まり、依存物の導入へは進まない）。
# Windows版はLinuxで実行できないので、最上位の処理で導入元の確認が照合の確認より前にあることを本文で確かめる。
def check_installer_without_bundle(root: Path, base_environment: dict[str, str]) -> None:
    base = root / "installer"
    home = base / "home"
    home.mkdir(parents=True)
    environment = isolated_environment(base_environment, home)
    result = subprocess.run(
        ["bash", str(SCRIPT_ROOT / "install-ubuntu.sh")],
        input="",
        text=True,
        capture_output=True,
        env=environment,
        check=False,
        start_new_session=True,
        timeout=60,
    )
    assert result.returncode == 1, f"return code {result.returncode}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    if "サポートします" in result.stderr or "/etc/os-release" in result.stderr:
        print("SKIP: インストーラーが対応していないOSのため、Bundleが無いときの案内は確かめていません。", file=sys.stderr)
    else:
        assert "Bundle archiveがありません" in result.stderr and "export-bundle --output-path" in result.stderr, result.stderr
        assert "照合" not in result.stdout + result.stderr, f"照合を先に尋ねた\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        assert snapshot_tree(home) == {}, "Bundleが無いのにhomeへ書き込んだ"
    windows_text = (SCRIPT_ROOT / "install-windows.ps1").read_text(encoding="utf-8-sig")
    top_level = windows_text[windows_text.rindex("\nfunction "):]  # 最後の関数定義から後ろ（最上位の処理を含む）。
    assert top_level.index("Write-MissingBundleGuidance") < top_level.index("Confirm-BundleVerified -Skip:$Verified"), "install-windows.ps1 が導入元の確認より前に照合を尋ねる"


# fresh、resume、mismatch、別root profile、公開範囲の変更と承認、旧形式profile、configure失敗、show-exposureの順で回帰確認する。
def main() -> int:
    if sys.platform != "linux":
        print("workflow-selftestはLinux専用です。", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-bridge-workflow-") as temporary:
        root = Path(temporary)
        home = root / "home"
        project = root / "project"
        failed_project = root / "failed-project"
        home.mkdir(); project.mkdir(); failed_project.mkdir()
        (project / "README.md").write_text("# Test\n", encoding="utf-8")
        (failed_project / "README.md").write_text("# Fail Test\n", encoding="utf-8")
        fake = root / "fake-tunnel-client"
        log = root / "fake.log"
        write_fake_client(fake)
        log.write_text("", encoding="utf-8")
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_STATE_HOME": str(home / ".local" / "state"),
                "FAKE_TUNNEL_LOG": str(log),
            }
        )
        node_override = os.environ.get("BRIDGE_TEST_NODE")
        if node_override:
            test_bin = root / "bin"
            test_bin.mkdir()
            # Volta などと同じ形のシムにする。node は shim への symlink で、shim は呼ばれた名前が node のときだけ動く。
            # 管理スクリプトが symlink を実体まで辿って実行すると、ここで失敗する。
            shim = test_bin / "tool-shim"
            shim.write_text(
                "#!/bin/sh\n"
                'case "$(basename "$0")" in\n'
                f"  node) exec '{node_override}' \"$@\" ;;\n"
                '  *) echo "tool-shim should not be called directly." >&2; exit 126 ;;\n'
                "esac\n",
                encoding="utf-8",
            )
            shim.chmod(0o755)
            (test_bin / "node").symlink_to(shim)
            environment["PATH"] = str(test_bin) + os.pathsep + environment.get("PATH", "")
        common = [
            "add-project",
            "--project-root", str(project),
            "--project-name", "WorkflowTest",
            "--tunnel-id", TUNNEL_A,
            "--tunnel-client-path", str(fake),
            "--no-browser",
            "--no-start",
        ]
        fresh = run_bridge(common, environment, "yes\nsk-test-012345678901234567890123456789\n")
        assert fresh.stdout.count("PROJECT_BRIDGE_SELFTEST PASS") == 1, (
            "fresh出力に自己試験PASSが1回だけ含まれていません。\n"
            f"STDOUT:\n{fresh.stdout}\nSTDERR:\n{fresh.stderr}"
        )
        assert "PROJECT_BRIDGE_SECURITY_SELFTEST PASS" in fresh.stdout
        profile_path, key_path = state_paths(project, home)
        assert profile_path.is_file() and key_path.is_file()
        assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
        assert "--approval-file" in profile_path.read_text(encoding="utf-8")
        approval_file = approval_path(project, home)
        assert approval_file.is_file() and stat.S_IMODE(approval_file.stat().st_mode) == 0o600
        assert json.loads(approval_file.read_text(encoding="utf-8"))["sha256"] == print_exposure(project, environment)["sha256"]

        config_before = (project / ".chatgpt-project-bridge.json").read_bytes()
        key_before = key_path.read_bytes()
        log_before = log.read_bytes()
        mismatch = run_bridge([*common[: common.index("--tunnel-id") + 1], TUNNEL_B, *common[common.index("--tunnel-id") + 2 :]], environment, expected=1)
        assert "Tunnel IDと一致しません" in mismatch.stderr
        assert (project / ".chatgpt-project-bridge.json").read_bytes() == config_before
        assert key_path.read_bytes() == key_before and log.read_bytes() == log_before

        original_profile = profile_path.read_text(encoding="utf-8")
        profile_path.write_text(original_profile.replace(str(project), str(root / "other")), encoding="utf-8")
        wrong_root = run_bridge(common, environment, expected=1)
        assert "別ルートまたは別Tunnel" in wrong_root.stderr
        assert key_path.read_bytes() == key_before and log.read_bytes() == log_before
        profile_path.write_text(original_profile, encoding="utf-8")

        resumed = run_bridge(common, environment)
        assert resumed.stdout.count("PROJECT_BRIDGE_SELFTEST PASS") == 1
        assert "存在確認だけで再利用" in resumed.stdout
        assert "公開範囲は承認済み" in resumed.stdout
        actions = log.read_text(encoding="utf-8").splitlines()
        assert actions.count("init") == 1 and actions.count("doctor") == 2

        # 承認後に公開範囲を広げると、非対話では古い指紋で通らず、鍵とprofileにも触れない。
        config = json.loads((project / ".chatgpt-project-bridge.json").read_text(encoding="utf-8"))
        old_sha = print_exposure(project, environment)["sha256"]
        config["gitExposure"] = {"paths": True, "commitSubjects": True}
        (project / ".chatgpt-project-bridge.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log_before = log.read_bytes()
        widened = run_bridge([*common, "--exposure-sha256", old_sha], environment, expected=1)
        assert "一致しません" in widened.stderr and "前回の承認から変わった項目" in widened.stdout
        assert key_path.read_bytes() == key_before and log.read_bytes() == log_before
        refused = run_bridge(common, environment, "no\n", expected=1)
        assert "承認されなかった" in refused.stderr
        new_sha = print_exposure(project, environment)["sha256"]
        approved = run_bridge(["approve", "--project-root", str(project), "--exposure-sha256", new_sha], environment)
        assert "承認を保存しました" in approved.stdout
        assert json.loads(approval_file.read_text(encoding="utf-8"))["sha256"] == new_sha

        # 2.0.0形式（--approval-fileなし）のprofileは拒否し、--force-reconfigureでだけ再生成する。
        profile_path.write_text(profile_path.read_text(encoding="utf-8").replace("--approval-file", "--legacy-removed"), encoding="utf-8")
        legacy = run_bridge(common, environment, expected=1)
        assert "2.0.0" in legacy.stderr
        assert log.read_bytes() == log_before
        regenerated = run_bridge([*common, "--force-reconfigure"], environment)
        assert "--approval-file" in profile_path.read_text(encoding="utf-8")
        assert "存在確認だけで再利用" in regenerated.stdout
        actions = log.read_text(encoding="utf-8").splitlines()
        assert actions.count("init") == 2 and actions.count("doctor") == 3

        # ハブ: 2つのプロジェクトを、このPCの1つのTunnel・プロファイル・キーで公開する。
        hub_projects = {name: root / name for name in ("hub-a", "hub-b", "hub-c")}  # ハブ試験用の模擬プロジェクト。
        for hub_root in hub_projects.values():
            hub_root.mkdir()
            (hub_root / "README.md").write_text("# Hub Test\n", encoding="utf-8")
        hub_common = ["hub-add", "--tunnel-client-path", str(fake), "--no-browser", "--no-start"]  # hub-add の共通引数。
        before_actions = log.read_text(encoding="utf-8").splitlines()
        first_hub = run_bridge([*hub_common, "--project-root", str(hub_projects["hub-a"]), "--project-name", "HubA", "--tunnel-id", TUNNEL_B], environment, "yes\nsk-test-hub-01234567890123456789012345\n")
        assert "ハブに登録しました: HubA" in first_hub.stdout, first_hub.stdout
        hub_file = home / ".config" / "chatgpt-project-bridge" / "hub.json"
        hub_data = json.loads(hub_file.read_text(encoding="utf-8"))
        assert stat.S_IMODE(hub_file.stat().st_mode) == 0o600
        assert hub_data["tunnelId"] == TUNNEL_B and [item["name"] for item in hub_data["projects"]] == ["HubA"]
        hub_profile = home / ".config" / "tunnel-client" / "profiles" / f"{hub_data['profileName']}.yaml"
        hub_key = home / ".config" / "tunnel-client" / "secrets" / f"{hub_data['profileName']}.key"
        assert "--hub" in hub_profile.read_text(encoding="utf-8") and str(hub_file) in hub_profile.read_text(encoding="utf-8")
        assert hub_key.is_file() and stat.S_IMODE(hub_key.stat().st_mode) == 0o600
        after_first = log.read_text(encoding="utf-8").splitlines()
        assert after_first.count("init") == before_actions.count("init") + 1 and after_first.count("doctor") == before_actions.count("doctor") + 1
        hub_key_before = hub_key.read_bytes()

        second_hub = run_bridge([*hub_common, "--project-root", str(hub_projects["hub-b"]), "--project-name", "HubB"], environment, "yes\n")
        assert "設定済み" in second_hub.stdout, second_hub.stdout
        hub_data = json.loads(hub_file.read_text(encoding="utf-8"))
        assert [item["name"] for item in hub_data["projects"]] == ["HubA", "HubB"]
        assert log.read_text(encoding="utf-8").splitlines() == after_first, "2つ目のhub-addでTunnel Clientが呼ばれた"
        assert hub_key.read_bytes() == hub_key_before

        other_tunnel = run_bridge([*hub_common, "--project-root", str(hub_projects["hub-a"]), "--tunnel-id", TUNNEL_A], environment, expected=1)
        assert "別のTunnel" in other_tunnel.stderr
        clash = run_bridge([*hub_common, "--project-root", str(hub_projects["hub-c"]), "--hub-name", "HubA"], environment, "yes\n", expected=1)
        assert "同じ名前" in clash.stderr
        listed = run_bridge(["hub-list"], environment)
        assert "HubA: 承認済み" in listed.stdout and "HubB: 承認済み" in listed.stdout, listed.stdout
        # キー入力の前で中断した状態（プロファイルあり・キーなし）からやり直すと、キーを聞き直す。プロファイルは作り直さない。
        hub_key.unlink()
        before_retry = log.read_text(encoding="utf-8").splitlines()
        retried = run_bridge([*hub_common, "--project-root", str(hub_projects["hub-a"])], environment, "sk-test-hub-retry-0123456789012345678\n")
        assert "キーの入力から続けます" in retried.stdout, retried.stdout
        assert hub_key.is_file() and stat.S_IMODE(hub_key.stat().st_mode) == 0o600
        after_retry = log.read_text(encoding="utf-8").splitlines()
        assert after_retry.count("init") == before_retry.count("init") and after_retry.count("doctor") == before_retry.count("doctor") + 1

        run_bridge(["hub-remove", "--hub-name", "HubB"], environment)
        assert [item["name"] for item in json.loads(hub_file.read_text(encoding="utf-8"))["projects"]] == ["HubA"]
        assert (hub_projects["hub-b"] / ".chatgpt-project-bridge.json").is_file(), "hub-removeがプロジェクトのファイルを消した"

        # 自動起動用の起動（--service）は入力を求めない。未承認のプロジェクトがあっても、公開しないまま起動する。
        hub_data = json.loads(hub_file.read_text(encoding="utf-8"))
        assert hub_data["notifications"] == {"start": True, "access": True, "intervalSeconds": 60} and hub_data["accessLog"].endswith("access.log")
        service_start = run_bridge(["hub-start", "--service", "--tunnel-client-path", str(fake)], environment)
        assert "公開範囲は承認済み" in service_start.stdout, service_start.stdout
        hub_a_config = json.loads((hub_projects["hub-a"] / ".chatgpt-project-bridge.json").read_text(encoding="utf-8"))
        hub_a_config["gitExposure"] = {"paths": True, "commitSubjects": False}
        (hub_projects["hub-a"] / ".chatgpt-project-bridge.json").write_text(json.dumps(hub_a_config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        unapproved_start = run_bridge(["hub-start", "--service", "--tunnel-client-path", str(fake)], environment)
        assert "未承認のため公開しません" in unapproved_start.stdout, unapproved_start.stdout
        interactive_start = run_bridge(["hub-start", "--tunnel-client-path", str(fake)], environment, "no\n", expected=1)
        assert "承認されなかった" in interactive_start.stderr

        # 停止と、自動起動の登録・解除（ユニットファイルの書き込みだけを確かめる）。
        stopped = run_bridge(["hub-stop", "--tunnel-client-path", str(fake)], environment)
        assert "起動していません" in stopped.stdout
        unit_file = home / ".config" / "systemd" / "user" / "chatgpt-project-bridge-hub.service"
        run_bridge(["hub-service-install", "--no-enable", "--tunnel-client-path", str(fake)], environment)
        unit_text = unit_file.read_text(encoding="utf-8")
        assert "hub-start --service" in unit_text and "Restart=on-failure" in unit_text and "PATH=" in unit_text, unit_text
        run_bridge(["hub-service-uninstall", "--no-enable"], environment)
        assert not unit_file.exists()

        # 1つのプロジェクトの設定が壊れていても（不正なUTF-8）、hub-list はそのプロジェクトだけを使用不可と表示し、
        # 自動起動用の hub-start はそのプロジェクトだけを公開せずにハブを起動する。
        broken = root / "hub-broken"  # 設定が壊れたプロジェクト。
        broken.mkdir()
        (broken / ".chatgpt-project-bridge.json").write_bytes(b'{"projectName": "\xff\xfe"}\n')
        hub_data = json.loads(hub_file.read_text(encoding="utf-8"))
        hub_data["projects"].append({"name": "HubBroken", "root": str(broken), "approvalFile": str(home / ".config" / "chatgpt-project-bridge" / "approvals" / "chatgpt-hubbroken-00000000.json")})
        hub_file.write_text(json.dumps(hub_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        listed = run_bridge(["hub-list"], environment)
        assert "HubBroken: 使用不可" in listed.stdout and "HubA:" in listed.stdout, listed.stdout
        broken_start = run_bridge(["hub-start", "--service", "--tunnel-client-path", str(fake)], environment)
        assert "警告: HubBroken を確認できないため公開しません" in broken_start.stdout and "--- HubA" in broken_start.stdout, broken_start.stdout
        hub_data["projects"] = [item for item in hub_data["projects"] if item["name"] != "HubBroken"]
        hub_file.write_text(json.dumps(hub_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        failed_environment = environment.copy()
        failed_environment["FAKE_INIT_FAIL"] = "1"
        failed_args = [item if item != str(project) else str(failed_project) for item in common]
        run_bridge(failed_args, failed_environment, "yes\nsk-test-must-not-be-written-0123456789\n", expected=23)
        failed_profile = hashlib.sha256(str(failed_project).encode("utf-8")).hexdigest()[:8]
        assert not any((home / ".config" / "tunnel-client" / "secrets").glob(f"*{failed_profile}*.key"))

        # 読み取り専用のshow-exposure。隔離した別のhomeとプロジェクトで、何も書き込まないことと状態の判定を確かめる。
        check_show_exposure(root, environment)

        # 承認表示の無害化・承認ファイルの堅牢化・Gitの安全な実行。それぞれ隔離した別のhomeとプロジェクトで確かめる。
        check_quote_vectors()
        check_git_config_rules()
        check_no_abbreviation(root, environment)
        check_forbidden_characters(root, environment)
        check_approval_display(root, environment)
        check_approval_file_hardening(root, environment)
        check_approved_project_root(root, environment)
        check_git_safety(root, environment)
        check_installer_without_bundle(root, environment)
        # server.mjs が64 KiBを超える出力を最後まで書くことに依存するため、最後に確かめる。
        check_large_exposure(root, environment)
    print("AddProject workflow self-test PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
