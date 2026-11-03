#!/usr/bin/env python3
"""project-bridge-gui.py（Ubuntu 版の管理画面）の自己試験。

説明データの網羅・CLI との突き合わせ・引数配列・承認 JSON の解釈・承認ダイアログへの敵対的な入力
（改行・行区切り・双方向制御などによる偽装）・hub.json の堅牢化・ハブの稼働の判定（PID ファイルと /proc の代わりの
一時フォルダー）と分かっている値の自動入力・端末コマンドと端末窓ヘルパー・画面の構造
（Gtk.OffscreenWindow だけを使い、デスクトップには何も出さない）・実 CLI との連携（一時 HOME/XDG）・
停止とシグナル（スタブの子プロセス）・禁止事項の静的検査（正規表現と ast）を行う。
実機のハブ設定・承認・Tunnel Client・端末窓には触れない。

  python3 scripts/gui-selftest.py [--screenshot-dir <dir>]

最後に PROJECT_BRIDGE_GUI_SELFTEST PASS を出す。1 つでも FAIL があれば終了コード 1。
画面の画像（PNG）は確認用に残す（既定は新しい一時ディレクトリ。パスを表示する）。
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # 試験で読み込むファイルの __pycache__ をリポジトリに作らない。

import argparse
import ast
import copy
import glob
import hashlib
import importlib.util
import json
import os
import pty
import pwd
import re
import select
import shlex
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import traceback
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parent  # 試験対象の置き場所。
REPOSITORY_ROOT = SCRIPT_ROOT.parent  # Skill のソースのルート。
GUI_FILE = SCRIPT_ROOT / "project-bridge-gui.py"  # 試験対象の画面。
CLI_FILE = SCRIPT_ROOT / "project-bridge.py"  # 画面が呼ぶ CLI。
PS1_FILE = SCRIPT_ROOT / "project-bridge.ps1"  # Windows 版の CLI（param ブロックだけ読む）。
HELP_FILE = REPOSITORY_ROOT / "assets" / "gui-help.ja.json"  # 共有の説明データ。
EXPECTED_GROUPS = ["easy", "hub", "legacy", "maintainer"]  # タブの並び。
EXPECTED_DANGEROUS = {"force", "force-reconfigure", "replace-key", "exposure-sha256"}  # dangerous: true のオプション。
EXPECTED_APPROVAL = {"approve", "start", "add-project", "hub-add", "hub-start", "hub-restart"}  # 承認が要る Action。
EXPECTED_KEY = {"save-key", "add-project", "hub-add"}  # キーの入力が要る Action。
EXPECTED_FOREGROUND = {"start", "hub-start", "hub-restart", "add-project", "hub-add"}  # 終わらないことがある Action。
ACTION_FIELDS = {
    "label": str, "group": str, "summary": str, "when": str, "requires": str, "effect": str, "next": str,
    "options": list, "required": list, "interactive": list, "foreground": bool, "caution": str, "src": list, "platformOnly": dict,
}  # Action の必須フィールドと型。
OPTION_FIELDS = {
    "label": str, "summary": str, "example": str, "default": str, "caution": str, "kind": str, "dangerous": bool, "src": list,
}  # オプションの必須フィールドと型。
TUNNEL_ID = "tunnel_" + "0123456789abcdef" * 2  # 試験用の Tunnel ID（実在しない）。
SHA_A = "a" * 64  # 試験用の指紋。
SHA_B = "b" * 64  # 試験用の別の指紋。
TRICKY = "空白 と 日本語;$(touch /tmp/x)`id`\"二重\"'一重'"  # シェルに渡すと壊れる文字を含む値。
FAKE_KEY = "CONTROL_PLANE_API_KEY=sk-test-0123456789abcdefghijklmnop"  # キーらしい値（どこにも入ってはいけない）。
BACKSLASH = chr(92)  # バックスラッシュ（期待値の \\uXXXX がツールで生の文字に変わらないよう、組み立てて書く）。
S2_VECTORS = (
    ("README.md", '"README.md"'),
    ("a" + chr(0x22) + "b", '"a' + BACKSLASH + '"b"'),
    ("a" + BACKSLASH + "b", '"a' + BACKSLASH * 2 + 'b"'),
    ("x" + chr(0x0A) + "y", '"x' + BACKSLASH + 'u000ay"'),
    ("a" + chr(0x2028) + "b", '"a' + BACKSLASH + 'u2028b"'),
    ("a" + chr(0x202E) + "b", '"a' + BACKSLASH + 'u202eb"'),
    ("a" + chr(0x3000) + "b", '"a' + BACKSLASH + 'u3000b"'),
    ("a" + chr(0x09) + "b", '"a' + BACKSLASH + 'u0009b"'),
    ("日本語 a b", '"日本語 a b"'),
    (chr(0x1F600), '"' + chr(0x1F600) + '"'),
    (chr(0xE0041), '"' + BACKSLASH + 'U000e0041"'),
    ("", '""'),
)  # 共通仕様 S2 の試験ベクトル（入力, 期待する出力）。U+2028・U+202E・U+3000 の行は、規則の文（\uXXXX にする）に従った出力。
FORBIDDEN_SAMPLES = (
    "\x00", "\x09", "\x0a", "\x1b", "\x7f", "\x85", "\x9b", "\u00ad", "\u061c", "\u200b", "\u200e", "\u200f", "\u202a", "\u202e",
    "\u2060", "\u2064", "\u2066", "\u2069", "\u206f", "\ufeff", "\U000e0001", "\U000e0041", "\U000e007f", "\u2028", "\u2029", "\ud800", "\udfff",
)  # 共通仕様 S1 の禁止文字の見本（Cc・Cf・Zl・Zp・Cs）。
ALLOWED_SAMPLES = (" ", "\u00a0", "\u3000", "a", "日", "ー", "\U0001f600", "\u0430", "\u03b1", "é")  # 禁止文字ではない文字の見本（拒否しすぎないこと）。


class SkipTest(Exception):
    """この PC では実行できない項目。"""


class Results:
    """項目ごとの PASS / FAIL / SKIP を表示し、失敗の数を数える。"""

    # 結果の記録を始める。
    def __init__(self):
        self.failures = 0  # FAIL の数。

    # 1 項目を実行して結果を表示する。戻り値（補足の行の並び）があれば字下げして出す。
    def run(self, name: str, function) -> None:
        try:
            notes = function() or []
        except SkipTest as reason:
            print(f"SKIP {name}: {reason}", flush=True)
            return
        except Exception as error:  # AssertionError 以外の想定外の例外も、その項目の失敗として出す。
            self.failures += 1
            reason = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
            print(f"FAIL {name}: {reason}", flush=True)
            for line in traceback.format_exc().rstrip().splitlines()[-8:]:
                print(f"    {line}", flush=True)
            return
        print(f"PASS {name}", flush=True)
        for note in notes:
            print(f"  {note}", flush=True)


# ---------------------------------------------------------------------------
# 隔離と後始末
# ---------------------------------------------------------------------------


# ファイルを読み込んでモジュールにする（sys.modules に登録してから実行する）。
def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# 配下の全エントリの種別・mode・内容の SHA-256 を集める。無ければ "absent"。
def content_snapshot(base: Path) -> object:
    if not os.path.lexists(base):
        return "absent"
    entries = {}  # 相対パスから状態への対応。
    items = [base, *sorted(base.rglob("*"))] if base.is_dir() and not base.is_symlink() else [base]
    for item in items:
        relative = item.relative_to(base).as_posix() if item != base else "."
        details = item.lstat()
        if stat.S_ISLNK(details.st_mode):
            entries[relative] = f"symlink {os.readlink(item)}"
        elif stat.S_ISDIR(details.st_mode):
            entries[relative] = f"dir {stat.S_IMODE(details.st_mode):o}"
        else:
            entries[relative] = f"file {stat.S_IMODE(details.st_mode):o} {hashlib.sha256(item.read_bytes()).hexdigest()}"
    return entries


# 配下の全エントリの種別・mode・大きさ・更新時刻だけを集める（秘密ファイルの中身は読まない）。無ければ "absent"。
def metadata_snapshot(base: Path) -> object:
    if not os.path.lexists(base):
        return "absent"
    entries = {}  # 相対パスから状態への対応。
    items = [base, *sorted(base.rglob("*"))] if base.is_dir() and not base.is_symlink() else [base]
    for item in items:
        details = item.lstat()
        relative = item.relative_to(base).as_posix() if item != base else "."
        entries[relative] = f"{stat.S_IFMT(details.st_mode):o} {stat.S_IMODE(details.st_mode):o} {details.st_size} {details.st_mtime_ns}"
    return entries


# 実機の設定（ハブ・承認・Tunnel の設定・自動起動のユニット）の状態を記録する。
def real_state_snapshot(real_home: Path, original_config_home: str | None) -> dict:
    bases = {real_home / ".config"}  # 実機の設定の置き場所。
    if original_config_home and os.path.isabs(original_config_home):
        bases.add(Path(original_config_home))
    snapshot = {}  # 記録した状態。
    for base in sorted(bases):
        snapshot[f"内容 {base / 'chatgpt-project-bridge'}"] = content_snapshot(base / "chatgpt-project-bridge")
        snapshot[f"属性 {base / 'tunnel-client'}"] = metadata_snapshot(base / "tunnel-client")
        snapshot[f"属性 {base / 'systemd' / 'user' / 'chatgpt-project-bridge-hub.service'}"] = metadata_snapshot(base / "systemd" / "user" / "chatgpt-project-bridge-hub.service")
    return snapshot


# リポジトリ内の、試験が残しうるもの（__pycache__・画像・足場・キーなど）を集める。
def repository_artifacts() -> set[str]:
    names = {".chatgpt-project-bridge.json", "hub.json", "CHATGPT_PROJECT_CONTEXT.md", "CHATGPT_PROJECT_STATUS.md"}  # 足場やハブの名前。
    found = set()  # 見つかった相対パス。
    for path in REPOSITORY_ROOT.rglob("*"):
        name = path.name
        if name == "__pycache__" or name.endswith((".pyc", ".png", ".key")) or name in names:
            found.add(path.relative_to(REPOSITORY_ROOT).as_posix())
    return found


# 試験の間だけ、HOME と XDG の全ディレクトリを一時ディレクトリへ向ける。
def isolate_environment(temporary: Path) -> Path:
    home = temporary / "home"  # 試験用の HOME。
    for directory in (home / ".config", home / ".local" / "state", home / ".local" / "share", home / ".cache", temporary / "tmp"):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "TMPDIR": str(temporary / "tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "GSETTINGS_BACKEND": "memory",
        "NO_AT_BRIDGE": "1",
    })
    return home


# ---------------------------------------------------------------------------
# 1. 説明データの網羅
# ---------------------------------------------------------------------------


# 説明データの構造・必須フィールド・参照の整合を確かめる。
def check_help_data(help_data: dict) -> list[str]:
    notes = []  # 補足。
    assert help_data.get("schemaVersion") == 1, "schemaVersion が 1 ではない"
    assert list(help_data["groups"]) == EXPECTED_GROUPS, f"groups の並びが違う: {list(help_data['groups'])}"
    assert all(isinstance(label, str) and label.strip() for label in help_data["groups"].values()), "groups の表示名が空"
    actions, options = help_data["actions"], help_data["options"]
    assert len(actions) == 26, f"Action が 26 個ではない: {len(actions)}"
    empty_fields = []  # 空の説明項目（参考）。
    for name, info in actions.items():
        assert re.fullmatch(r"[a-z]+(-[a-z]+)*", name), f"Action 名が kebab-case ではない: {name}"
        for field, expected in ACTION_FIELDS.items():
            assert field in info, f"{name}.{field} が無い"
            assert isinstance(info[field], expected) and not (expected is not bool and isinstance(info[field], bool)), f"{name}.{field} の型が違う"
        assert info["label"].strip() and info["summary"].strip(), f"{name} の label か summary が空"
        assert info["group"] in help_data["groups"], f"{name} の group が不明: {info['group']}"
        assert len(set(info["options"])) == len(info["options"]), f"{name} の options に重複"
        assert all(option in options for option in info["options"]), f"{name} の options に未定義: {[option for option in info['options'] if option not in options]}"
        assert set(info["required"]) <= set(info["options"]), f"{name} の required が options の部分集合ではない"
        assert set(info["interactive"]) <= {"key", "approval"}, f"{name} の interactive が不正: {info['interactive']}"
        assert all(isinstance(item, str) and item for item in info["src"]), f"{name} の src が不正"
        assert set(info["platformOnly"]) <= set(info["options"]), f"{name} の platformOnly に options に無いもの: {sorted(set(info['platformOnly']) - set(info['options']))}"
        assert set(info["platformOnly"].values()) <= {"ubuntu", "windows"}, f"{name} の platformOnly の値が不正: {info['platformOnly']}"
        empty_fields.extend(f"{name}.{field}" for field in ("when", "requires", "effect", "next", "caution") if not info[field].strip())
        extra = set(info) - set(ACTION_FIELDS)
        if extra:
            notes.append(f"{name} の追加フィールド: {sorted(extra)}")
    for name, info in options.items():
        for field, expected in OPTION_FIELDS.items():
            assert field in info, f"options.{name}.{field} が無い"
            assert isinstance(info[field], expected) and not (expected is not bool and isinstance(info[field], bool)), f"options.{name}.{field} の型が違う"
        assert info["label"].strip() and info["summary"].strip(), f"options.{name} の label か summary が空"
        assert info["kind"] in {"text", "path", "flag", "number"}, f"options.{name} の kind が不正: {info['kind']}"
    dangerous = {name for name, info in options.items() if info["dangerous"] is True}
    assert dangerous == EXPECTED_DANGEROUS, f"dangerous の集合が違う: {sorted(dangerous)}"
    approval = {name for name, info in actions.items() if "approval" in info["interactive"]}
    key = {name for name, info in actions.items() if "key" in info["interactive"]}
    foreground = {name for name, info in actions.items() if info["foreground"]}
    assert approval == EXPECTED_APPROVAL, f"承認が要る Action が想定と違う: {sorted(approval)}"
    assert key == EXPECTED_KEY, f"キーが要る Action が想定と違う: {sorted(key)}"
    assert foreground == EXPECTED_FOREGROUND, f"foreground の Action が想定と違う: {sorted(foreground)}"
    unused = sorted(set(options) - {option for info in actions.values() for option in info["options"]})
    notes.append(f"Action 26 個・オプション {len(options)} 個。どの Action も使わないオプション: {unused or 'なし'}")
    platforms = {name: info["platformOnly"] for name, info in actions.items() if info["platformOnly"]}
    notes.append(f"platformOnly: {json.dumps(platforms, ensure_ascii=False)}")
    notes.append(f"空の説明項目（参考。空なら表示しない）: {', '.join(empty_fields) or 'なし'}")
    return notes


# ---------------------------------------------------------------------------
# 2. CLI との突き合わせ
# ---------------------------------------------------------------------------


# PowerShell の名前（ProjectRoot など）を kebab-case（project-root）にする。
def powershell_to_kebab(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name).lower()


# project-bridge.ps1 の先頭の param ブロックを取り出す。
def powershell_param_block(text: str) -> str:
    match = re.search(r"\[CmdletBinding\(\)\]\s*param\(", text)
    assert match, "project-bridge.ps1 に [CmdletBinding()] param( が無い"
    depth = 1  # 括弧の深さ。
    index = match.end()  # 読んでいる位置。
    while depth and index < len(text):
        depth += {"(": 1, ")": -1}.get(text[index], 0)
        index += 1
    assert depth == 0, "param ブロックの括弧が閉じていない"
    return text[match.end():index - 1]


# build_parser()・normalize_action・PowerShell の param と、説明データを突き合わせる。
def check_cli_match(gui, help_data: dict) -> list[str]:
    notes = []  # 補足。
    cli = load_module("project_bridge_cli_for_selftest", CLI_FILE)
    parser = cli.build_parser()
    cli_options = {text[2:] for definition in parser._actions for text in definition.option_strings if text.startswith("--")} - {"action", "help"}
    json_options = set(help_data["options"])
    assert not (cli_options - json_options), f"CLI にあって説明データに無いオプション: {sorted(cli_options - json_options)}"
    notes.append(f"CLI の長いオプション {len(cli_options)} 個。説明データにだけあるもの: {sorted(json_options - cli_options) or 'なし'}")
    assert gui.load_cli_option_names(CLI_FILE) == frozenset(cli_options), "画面が読む CLI のオプション一覧が、build_parser() と一致しない"
    for action in help_data["actions"]:
        assert cli.normalize_action(action) == action, f"normalize_action が {action} を通さない"
    positional = [definition for definition in parser._actions if not definition.option_strings and definition.dest == "action"]
    assert positional, "CLI の action 引数が見つからない"
    listed = {item.strip() for item in positional[0].help.split("/")}
    assert listed == set(help_data["actions"]), f"CLI の Action 一覧と説明データが違う: {sorted(listed ^ set(help_data['actions']))}"
    block = powershell_param_block(PS1_FILE.read_text(encoding="utf-8-sig"))
    ps1_options = {powershell_to_kebab(name) for name in re.findall(r"\$([A-Za-z][A-Za-z0-9]*)", block)} - {"action"}
    validate = re.search(r"ValidateSet\(([^)]*)\)", block)
    assert validate, "param の Action に ValidateSet が無い"
    ps1_actions = {powershell_to_kebab(name) for name in re.findall(r"'([A-Za-z]+)'", validate.group(1))}
    ps1_only = sorted(ps1_options - json_options)
    json_only = sorted(json_options - ps1_options)
    notes.append(f"PowerShell の param {len(ps1_options)} 個。PowerShell にだけあるもの: {ps1_only or 'なし'}。説明データにあって PowerShell に無いもの: {json_only or 'なし'}")
    assert not ps1_only, f"PowerShell にあって説明データに無いオプション: {ps1_only}"
    assert set(json_only) <= {"no-enable"}, f"PowerShell に無いオプション（no-enable 以外）: {json_only}"
    assert ps1_actions == set(help_data["actions"]), f"PowerShell の ValidateSet と説明データの Action が違う: {sorted(ps1_actions ^ set(help_data['actions']))}"
    # platformOnly: Ubuntu 専用は build_parser() が受け付け、Windows 専用は PowerShell にあって Ubuntu の画面には出ない。
    gui_options = gui.load_cli_option_names(CLI_FILE)
    checked = []  # 確かめた (Action, オプション, OS)。
    for action, info in help_data["actions"].items():
        visible = gui.visible_options(help_data, action, gui_options)
        for option, platform in info["platformOnly"].items():
            if platform == "ubuntu":
                assert option in cli_options, f"{action} の Ubuntu 専用 {option} を build_parser() が受け付けない"
                assert option in visible, f"{action} の Ubuntu 専用 {option} が画面に出ない"
            else:
                assert option in ps1_options, f"{action} の Windows 専用 {option} が PowerShell の param に無い"
                assert option not in visible, f"{action} の Windows 専用 {option} が Ubuntu の画面に出る"
            checked.append(f"{action}:{option}={platform}")
    notes.append(f"platformOnly の確認: {', '.join(checked)}")
    return notes


# ---------------------------------------------------------------------------
# 3. 引数配列の組み立て
# ---------------------------------------------------------------------------


# 試験用の入力値を、オプションごとに別の値で作る（同じ値が 2 か所に出ないように）。
def sample_value(help_data: dict, option: str) -> str:
    kind = help_data["options"][option]["kind"]
    if kind == "number":
        return "18080"
    if kind == "path":
        return f"/tmp/{TRICKY}/{option}"
    return f"{TRICKY} {option}"


# 表駆動で、引数配列が期待どおりかを確かめる。
def check_arguments(gui, help_data: dict, cli_options: frozenset[str]) -> list[str]:
    prefix = [sys.executable, "-u", str(CLI_FILE)]  # CLI の呼び出しの先頭。
    root = f"/tmp/{TRICKY}"  # 試験用のプロジェクトのフォルダー。
    name = f"名前 {TRICKY}"  # 試験用のプロジェクト名。
    client = "/opt/tunnel client/tunnel-client"  # 試験用の Tunnel Client の場所。
    output = "/tmp/出力 先/bridge.tar.gz"  # 試験用の出力先。
    signing = "/tmp/ssh dir/id_ed25519"  # 試験用の署名鍵の場所。
    every_hub_add = {"project-root": root, "project-name": name, "hub-name": "Hub_1", "tunnel-id": TUNNEL_ID, "tunnel-client-path": client}
    every_add_project = {"project-root": root, "project-name": name, "profile": "p-1", "tunnel-id": TUNNEL_ID, "tunnel-client-path": client}
    cases = [
        ("init", {"project-root": root}, set(), ["init", "--project-root", root]),
        ("init", {"project-root": root, "project-name": name}, {"force"}, ["init", "--project-root", root, "--project-name", name, "--force"]),
        ("init", {"project-root": root, "project-name": "-dash"}, set(), ["init", "--project-root", root, "--project-name=-dash"]),
        ("configure-tunnel", {"project-root": root, "tunnel-id": TUNNEL_ID, "health-port": ""}, set(), ["configure-tunnel", "--project-root", root, "--tunnel-id", TUNNEL_ID]),
        ("configure-tunnel", {"project-root": root, "profile": "p-1", "tunnel-id": TUNNEL_ID, "tunnel-client-path": client, "health-port": "18080"}, {"force"},
         ["configure-tunnel", "--project-root", root, "--profile", "p-1", "--tunnel-id", TUNNEL_ID, "--tunnel-client-path", client, "--health-port", "18080", "--force"]),
        ("save-key", {"project-root": root}, set(), ["save-key", "--project-root", root]),
        ("save-key", {"project-root": root, "profile": "p-1"}, {"replace-key"}, ["save-key", "--project-root", root, "--profile", "p-1", "--replace-key"]),
        ("start", {"project-root": root, "profile": "  "}, set(), ["start", "--project-root", root]),
        ("add-project", {"project-root": root, "tunnel-id": TUNNEL_ID}, set(), ["add-project", "--project-root", root, "--tunnel-id", TUNNEL_ID, "--no-start"]),
        ("add-project", every_add_project, {"no-browser", "force-reconfigure", "replace-key"},
         ["add-project", "--project-root", root, "--project-name", name, "--profile", "p-1", "--tunnel-id", TUNNEL_ID, "--tunnel-client-path", client, "--no-browser", "--no-start", "--force-reconfigure", "--replace-key"]),
        ("approve", {"project-root": root, "exposure-sha256": SHA_A}, {"exposure-sha256", "verified"}, ["approve", "--project-root", root]),
        ("hub-add", {"project-root": root}, set(), ["hub-add", "--project-root", root, "--no-start"]),
        ("hub-add", every_hub_add, {"no-browser", "force-reconfigure", "replace-key"},
         ["hub-add", "--project-root", root, "--project-name", name, "--hub-name", "Hub_1", "--tunnel-id", TUNNEL_ID, "--tunnel-client-path", client, "--no-browser", "--no-start", "--force-reconfigure", "--replace-key"]),
        ("hub-remove", {"hub-name": "Hub_1"}, set(), ["hub-remove", "--hub-name", "Hub_1"]),
        ("hub-list", {}, set(), ["hub-list"]),
        ("hub-start", {}, set(), ["hub-start", "--service"]),
        ("hub-restart", {"tunnel-client-path": client}, set(), ["hub-restart", "--tunnel-client-path", client, "--service"]),
        ("hub-stop", {}, set(), ["hub-stop"]),
        ("hub-stop", {"tunnel-client-path": client}, set(), ["hub-stop", "--tunnel-client-path", client]),
        ("hub-service-install", {}, set(), ["hub-service-install"]),
        ("hub-service-install", {}, {"no-start", "no-enable"}, ["hub-service-install", "--no-enable"]),
        ("hub-service-install", {"tunnel-client-path": client}, {"no-start", "no-enable"}, ["hub-service-install", "--no-enable", "--tunnel-client-path", client]),
        ("hub-service-uninstall", {}, {"no-enable"}, ["hub-service-uninstall", "--no-enable"]),
        ("export-skill", {"output-path": output}, {"force"}, ["export-skill", "--output-path", output, "--force"]),
        ("export-bundle", {"output-path": output, "signing-key": signing}, {"force"}, ["export-bundle", "--output-path", output, "--force", "--signing-key", signing]),
        ("update-lock", {"tunnel-client-version": "v1.2.3", "node-version": "v22.11.0", "gh-path": "/usr/bin/gh"}, set(),
         ["update-lock", "--tunnel-client-version", "v1.2.3", "--node-version", "v22.11.0", "--gh-path", "/usr/bin/gh"]),
        ("hub-permissions", {}, set(), ["hub-permissions"]),
        ("set-permission", {"project-root": root}, set(), ["set-permission", "--project-root", root]),
        ("set-permission", {"project-root": root, "profile": "p-1", "source-read": "on", "claude-code": "off", "allowed-command": "node scripts/*-selftest.mjs"}, set(),
         ["set-permission", "--project-root", root, "--profile", "p-1", "--source-read", "on", "--claude-code", "off", "--allowed-command", "node scripts/*-selftest.mjs"]),
    ]  # (Action, 入力値, オンのフラグ, 期待する CLI 以降の引数)。
    for action, values, flags, expected in cases:
        actual = gui.build_cli_arguments(help_data, action, values, flags, cli_options)
        assert actual == prefix + expected, f"{action} の引数配列が違う: {actual[3:]}"

    # 承認ダイアログの結果（ApprovalGrant）があるときだけ、指紋が付く。
    grant = gui.ApprovalGrant(root, None, SHA_A)
    assert gui.build_cli_arguments(help_data, "approve", {"project-root": root}, set(), cli_options, grant) == prefix + ["approve", "--project-root", root, "--exposure-sha256", SHA_A]
    assert gui.build_cli_arguments(help_data, "hub-add", {"project-root": root}, set(), cli_options, grant) == prefix + ["hub-add", "--project-root", root, "--no-start", "--exposure-sha256", SHA_A]
    profiled = gui.ApprovalGrant(root, "p-1", SHA_A)
    assert gui.build_cli_arguments(help_data, "start", {"project-root": root, "profile": "p-1"}, set(), cli_options, profiled) == prefix + ["start", "--project-root", root, "--profile", "p-1", "--exposure-sha256", SHA_A]
    # set-permission（2.8.0）は interactive に approval が無いが、exposure-sha256 を持つので指紋を渡せる。
    assert gui.build_cli_arguments(help_data, "set-permission", {"project-root": root, "profile": "p-1", "source-read": "on"}, set(), cli_options, profiled) == \
        prefix + ["set-permission", "--project-root", root, "--profile", "p-1", "--source-read", "on", "--exposure-sha256", SHA_A]
    rejected = [
        ("init", {"project-root": root}, grant),
        ("approve", {"project-root": root + "-other"}, grant),
        ("approve", {"project-root": root, "profile": "p-2"}, grant),
        ("approve", {"project-root": root}, gui.ApprovalGrant(root, None, "A" * 64)),
        ("set-permission", {"project-root": root, "profile": "p-2", "source-read": "on"}, profiled),
    ]  # 指紋を渡してはいけない組み合わせ。
    for action, values, bad_grant in rejected:
        try:
            gui.build_cli_arguments(help_data, action, values, set(), cli_options, bad_grant)
        except ValueError:
            continue
        raise AssertionError(f"{action} {values} で指紋の付与を拒否しなかった")
    assert gui.build_approve_arguments(root, "p-1", profiled) == prefix + ["approve", "--project-root", root, "--profile", "p-1", "--exposure-sha256", SHA_A]
    for bad_root, bad_profile in ((root + "x", "p-1"), (root, None)):
        try:
            gui.build_approve_arguments(bad_root, bad_profile, profiled)
        except ValueError:
            continue
        raise AssertionError("build_approve_arguments が別のプロジェクトへの指紋を拒否しなかった")
    assert gui.build_show_exposure_arguments(root, None) == prefix + ["show-exposure", "--project-root", root]
    assert gui.build_show_exposure_arguments(root, "p-1") == prefix + ["show-exposure", "--project-root", root, "--profile", "p-1"]
    assert gui.build_init_arguments(root, name) == prefix + ["init", "--project-root", root, "--project-name", name]
    # 停止ボタンからの hub-stop は、「ハブを停止」のカードと同じ引数配列になる。
    for value in ("", None, client):
        card = gui.build_cli_arguments(help_data, "hub-stop", {"tunnel-client-path": value or ""}, set(), cli_options)
        assert gui.build_hub_stop_arguments(help_data, cli_options, value) == card, f"停止ボタンとカードの hub-stop が違う: {value!r}"
    assert gui.build_hub_stop_arguments(help_data, cli_options, client) == prefix + ["hub-stop", "--tunnel-client-path", client]

    # 全 Action について、必須だけ・全部入りの両方で、禁止事項と値の 1 要素性を確かめる。
    for action, info in help_data["actions"].items():
        visible = gui.visible_options(help_data, action, cli_options)
        assert "exposure-sha256" not in visible, f"{action} に指紋の入力欄が出る"
        assert not {option for option, platform in info["platformOnly"].items() if platform != "ubuntu"} & set(visible), f"{action} に Windows 専用のオプションが出る"
        assert all(option in cli_options for option in visible), f"{action} に CLI が持たないオプションが出る"
        assert {option for option in visible if "key" in option} <= {"signing-key", "replace-key"}, f"{action} にキーの入力欄らしいものがある"
        required_only = {option: sample_value(help_data, option) for option in info["required"]}
        everything = {option: sample_value(help_data, option) for option in visible if help_data["options"][option]["kind"] != "flag"}
        everything.update({"exposure-sha256": SHA_A, "verified": "yes", "runtime-api-key": FAKE_KEY, "CONTROL_PLANE_API_KEY": FAKE_KEY})
        all_flags = {option for option in visible if help_data["options"][option]["kind"] == "flag"} | {"verified", "exposure-sha256", "no-start"}
        for values, flags in ((required_only, set()), (everything, all_flags)):
            arguments = gui.build_cli_arguments(help_data, action, values, flags, cli_options)
            assert arguments[:4] == prefix + [action], f"{action} の先頭が違う: {arguments[:4]}"
            assert not any(item.startswith("--verified") for item in arguments), f"{action} に --verified が出た"
            assert "--exposure-sha256" not in arguments, f"{action} で承認前に --exposure-sha256 が出た"
            assert not any("CONTROL_PLANE_API_KEY" in item or "sk-test" in item for item in arguments), f"{action} の引数にキーらしい値が入った"
            if not flags:
                assert not {"--force", "--force-reconfigure", "--replace-key"} & set(arguments), f"{action} で既定なのに上書き系が出た"
            if action in ("add-project", "hub-add"):
                assert "--no-start" in arguments, f"{action} に --no-start が無い"
            if action == "hub-service-install":
                assert "--no-start" not in arguments, "hub-service-install に --no-start が出た"
            for option, value in values.items():
                if option in visible and help_data["options"][option]["kind"] != "flag":
                    position = arguments.index(f"--{option}")
                    assert arguments[position + 1] == value and arguments.count(value) == 1, f"{action} の {option} の値が 1 要素のまま渡っていない"

    # 子プロセスの環境は PYTHONIOENCODING だけを足す。元の環境は変えない。
    base = {"PATH": "/usr/bin:/bin", "HOME": "/tmp/home", "LANG": "ja_JP.UTF-8"}
    copied = dict(base)
    environment = gui.child_environment(base)
    assert base == copied, "child_environment が元の環境を書き換えた"
    assert set(environment) - set(base) == {"PYTHONIOENCODING"} and environment["PYTHONIOENCODING"] == "utf-8"
    assert all(environment[key_name] == value for key_name, value in base.items())
    assert not any("sk-test" in value for value in environment.values())
    return [f"表駆動 {len(cases)} 件と、全 26 Action の必須だけ・全部入りの組み立てを確かめた"]


# ---------------------------------------------------------------------------
# 4. 承認 JSON の解釈
# ---------------------------------------------------------------------------


# 試験用の公開範囲。
def sample_exposure() -> dict:
    return {
        "schemaVersion": 1,
        "projectRoot": "/tmp/プロジェクト A",
        "contextFile": "CHATGPT_PROJECT_CONTEXT.md",
        "statusFile": "CHATGPT_PROJECT_STATUS.md",
        "allowFiles": ["CHATGPT_PROJECT_CONTEXT.md", "CHATGPT_PROJECT_STATUS.md", "README.md"],
        "allowDirectories": [{"path": "docs", "recursive": True}, {"path": "notes", "recursive": False}],
        "denyDirectories": [".git", "node_modules"],
        "maxDocumentBytes": 524288,
        "gitExposure": {"paths": True, "commitSubjects": False},
    }


# 試験用の show-exposure の結果を作る。
def sample_report(state: str, approved: str | None, changes: list[str] | None = None, root: str = "/tmp/プロジェクト A", sha256: str = SHA_A) -> dict:
    return {
        "schemaVersion": 1,
        "projectRoot": root,
        "profile": "chatgpt-sample-12345678",
        "exposureSha256": sha256,
        "approvalState": state,
        "approvedSha256": approved,
        "exposure": {**sample_exposure(), "projectRoot": root},
        "changes": changes or [],
    }


# 3 通りの承認状態と、壊れた入力の扱いを確かめる。
def check_approval_json(gui, help_data: dict) -> list[str]:
    root = "/tmp/プロジェクト A"  # 試験用のフォルダー。
    approved = sample_report("approved", SHA_A)
    unapproved = sample_report("unapproved", None)
    change_line = 'gitExposure: {"commitSubjects": false, "paths": false} -> {"commitSubjects": false, "paths": true}'
    changed = sample_report("changed", SHA_B, [change_line])
    for report in (approved, unapproved, changed):
        parsed, error = gui.parse_exposure_report(json.dumps(report, ensure_ascii=False))
        assert error is None and parsed == report, f"正しい JSON を読めない: {error}"
    assert gui.approval_needed(approved) is False
    assert gui.approval_needed(unapproved) is True and gui.approval_needed(changed) is True
    assert gui.approval_needed({**approved, "approvedSha256": SHA_B}) is True, "指紋が食い違う承認済みを、確認なしで通した"
    # 指紋を渡すのは、承認が必要で、利用者が承認したときだけ。
    assert gui.grant_from_confirmation(approved, root, None, True) is None
    assert gui.grant_from_confirmation(unapproved, root, None, False) is None
    assert gui.grant_from_confirmation(unapproved, root, None, "yes") is None
    assert gui.grant_from_confirmation(unapproved, root, None, True) == gui.ApprovalGrant(root, None, SHA_A)
    assert gui.grant_from_confirmation(changed, root, "  ", True) == gui.ApprovalGrant(root, None, SHA_A)
    # ダイアログの内容: 全項目（1 項目 1 行・番号・S2 の引用）・要約・指紋・状態ごとの文・差分・ハブの警告。
    # （仕様変更: 拒否ディレクトリはカンマで 1 行に並べず 1 項目 1 行にし、値は二重引用符で囲む。D-2・S2）
    hub_warning = gui.hub_warning_text(help_data)
    assert "ハブ方式では、このアプリを使うどのチャットからも、承認済みの全プロジェクトを読めます" in hub_warning, hub_warning
    assert hub_warning.split("。")[0] in help_data["actions"]["hub-add"]["caution"], "ハブの警告が hub-add の注意書きから取られていない"
    text = gui.approval_dialog_text(unapproved)
    for expected in ("このプロジェクトはまだ承認されていません", f'プロジェクトルート: "{root}"', '"chatgpt-sample-12345678"', '概要文書（contextFile）: "CHATGPT_PROJECT_CONTEXT.md"',
                     '状態文書（statusFile）: "CHATGPT_PROJECT_STATUS.md"', '  3. "README.md"', '  1. "docs"（配下すべて）', '  2. "notes"（直下だけ）',
                     "拒否ディレクトリ（2 件）:\n  1. \".git\"\n  2. \"node_modules\"", "公開ファイル 3 件 / 公開ディレクトリ 2 件（うち配下すべて 1 件） / 拒否ディレクトリ 2 件",
                     "Git のファイル名: 公開", "Git のコミット件名: 非公開", "文書 1 件の上限: 524288 バイト", f"{gui.SUMMARY_SHA_HEADING}\n{SHA_A}"):
        assert expected in text, f"未承認の本文に「{expected}」が無い"
    assert "前回の承認から変わった項目" not in text and "警告:" not in text
    assert any(line.strip() == SHA_A for line in text.splitlines()), "指紋が 1 行に単独で出ていない"
    changed_text = gui.approval_dialog_text(changed, hub_warning)
    translated = '  1. Git の公開設定（gitExposure）: {"commitSubjects": false, "paths": false} → {"commitSubjects": false, "paths": true}'
    for expected in ("公開範囲が前回の承認から変わっています", "前回の承認から変わった項目（1 件）:", translated, f"警告: {hub_warning}", SHA_A):
        assert expected in changed_text, f"変更ありの本文に「{expected}」が無い"
    assert changed_text.index("前回の承認から変わった項目") < changed_text.index("公開ファイル（3 件）"), "変わった項目が全項目より後にある"
    assert "まだ承認されていません" not in changed_text
    # 差分の行の項目名を日本語にする（元の識別子も残す）。値は変えない。読めない行・未知の項目名はそのまま。
    translations = {
        'allowFiles: [] -> ["README.md"]': '公開ファイル（allowFiles）: [] → ["README.md"]',
        'allowFiles: ["a -> b.md"] -> ["c.md"]': '公開ファイル（allowFiles）: ["a -> b.md"] → ["c.md"]',
        'projectRoot: (なし) -> "/tmp/x"': 'プロジェクトルート（projectRoot）: (なし) → "/tmp/x"',
        'contextFile: "A.md" -> "B.md"': '概要文書（contextFile）: "A.md" → "B.md"',
        'statusFile: "A.md" -> "B.md"': '状態文書（statusFile）: "A.md" → "B.md"',
        'allowDirectories: [] -> [{"path": "docs", "recursive": true}]': '公開ディレクトリ（allowDirectories）: [] → [{"path": "docs", "recursive": true}]',
        'denyDirectories: [".git"] -> []': '拒否ディレクトリ（denyDirectories）: [".git"] → []',
        "maxDocumentBytes: 1024 -> 2048": "文書 1 件の上限（maxDocumentBytes）: 1024 → 2048",
        "futureField: 1 -> 2": "futureField: 1 → 2",
        "allowFiles: 壊れた値": "公開ファイル（allowFiles）: 壊れた値",
        "形式の違う行": "形式の違う行",
        "": "",
    }  # CLI の差分の行と、期待する表示。
    for source, expected in translations.items():
        assert gui.translate_change_line(source) == expected, f"差分の行の表示が違う: {gui.translate_change_line(source)!r}"
    # 壊れた入力・欄の欠落は、例外を出さずに (None, 理由) で中止へ倒れる。
    broken = ["", "not json", "[]", "null", "{}", "ERROR: 公開範囲を取得できません", None, b"{}", json.dumps({**unapproved, "schemaVersion": 2}),
              json.dumps({**unapproved, "schemaVersion": True}), json.dumps({**unapproved, "schemaVersion": "1"}), json.dumps({**unapproved, "exposure": []}),
              json.dumps({**unapproved, "changes": "x"}), json.dumps({**unapproved, "changes": [1]}), json.dumps({**unapproved, "approvedSha256": 5}),
              json.dumps({**unapproved, "approvedSha256": "x"}), json.dumps({**unapproved, "exposureSha256": "A" * 64}), json.dumps({**unapproved, "exposureSha256": "a" * 63}),
              json.dumps({**unapproved, "approvalState": "maybe"})]
    broken.extend(json.dumps({key: value for key, value in unapproved.items() if key != missing}) for missing in unapproved)
    for item in broken:
        parsed, error = gui.parse_exposure_report(item)
        assert parsed is None and isinstance(error, str) and error, f"壊れた入力を受け付けた: {str(item)[:60]}"
    # 公開範囲の中身が崩れていても、本文の組み立ては落ちない。崩れた形は承認できない状態にする（件数を構造から数えられないため）。
    odd = {**unapproved, "exposure": {"allowFiles": "single", "allowDirectories": "x", "denyDirectories": None, "gitExposure": [], "maxDocumentBytes": None, "extra": {"a": 1}}}
    assert "その他の項目" in gui.approval_dialog_text(odd) and isinstance(gui.approval_dialog_text({}), str)
    assert any(blocker.startswith(gui.SHAPE_MESSAGE) for blocker in gui.approval_blockers(odd)), "形の崩れた公開範囲を承認できる状態にした"
    assert gui.grant_from_confirmation(odd, root, None, True) is None, "形の崩れた公開範囲に指紋を渡そうとした"
    # detailExposure（2.5.0）: 専用の行になり「その他の項目」には出ない。崩れた形は承認できない状態にする（2.8.0 で KNOWN_EXPOSURE_FIELDS・exposure_shape_problems に追加）。
    detail_text = gui.approval_dialog_text(with_exposure(unapproved, detailExposure={"branchNames": True, "diffExcerpts": False, "sourceText": True}))
    for expected in ("詳細取得ツールの公開設定:", "ブランチ名（branchNames）: 公開", "差分の抜粋（diffExcerpts）: 非公開", "ファイル本文（設定・ソース・記録）（sourceText）: 公開"):
        assert expected in detail_text, f"detailExposure の専用の行に「{expected}」が無い"
    assert "その他の項目" not in detail_text, "detailExposure が「その他の項目」に生の JSON で出た"
    detail_odd = with_exposure(unapproved, detailExposure={"branchNames": True})
    assert any(blocker.startswith(gui.SHAPE_MESSAGE) and "detailExposure" in blocker for blocker in gui.approval_blockers(detail_odd)), "崩れた detailExposure を承認できる状態にした"
    assert gui.grant_from_confirmation(detail_odd, root, None, True) is None, "崩れた detailExposure に指紋を渡そうとした"
    assert "detailExposure" not in gui.approval_dialog_text(unapproved), "detailExposure が無いのに専用の行が出た"
    return [f"承認状態 3 通り、壊れた入力 {len(broken)} 通り、差分の行の日本語化 {len(translations)} 通り、detailExposure の専用の行を確かめた"]


# hub.json を読むだけで、ファイルもディレクトリも作らないこと。形が崩れていても落ちないこと。
def check_hub_reading(gui, temporary: Path) -> list[str]:
    home = temporary / "hub-reading-home"  # まだ作らない HOME。
    environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config")}
    listing = gui.read_hub_projects(environment)
    assert listing.exists is False and listing.error is None and listing.projects == (), listing
    assert not home.exists(), "hub.json を読んだだけでディレクトリが作られた"
    assert gui.read_hub_projects({"HOME": str(home), "XDG_CONFIG_HOME": "relative/path"}).error, "相対パスの XDG_CONFIG_HOME を受け付けた"
    defaulted = gui.read_hub_projects({"HOME": str(home)})
    assert defaulted.path == str(home / ".config" / "chatgpt-project-bridge" / "hub.json") and not home.exists()
    hub_file = home / ".config" / "chatgpt-project-bridge" / "hub.json"
    hub_file.parent.mkdir(parents=True)
    for broken in ("", "[]", "{\"projects\": 1}", "\u0000"):
        hub_file.write_text(broken, encoding="utf-8")
        listing = gui.read_hub_projects(environment)
        assert listing.error and listing.projects == (), f"壊れた hub.json を受け付けた: {broken!r}"
    approvals = hub_file.parent / "approvals"  # CLI が承認ファイルを置く所定の場所（作らない）。
    record = {"schemaVersion": 1, "projects": [
        {"name": "A", "root": "/tmp/a", "approvalFile": str(approvals / "chatgpt-a-12345678.json")},
        {"name": "B", "root": "/tmp/b", "approvalFile": str(approvals / "Bad Name.json")},
        "not an object",
    ]}  # 一部が崩れた登録内容（仕様変更: approvalFile は所定の場所のものだけを確かめられる。A-10）。
    hub_file.write_text(json.dumps(record), encoding="utf-8")
    before = hub_file.read_bytes()
    listing = gui.read_hub_projects(environment)
    assert listing.error is None and [project.name for project in listing.projects] == ["A", "B"]
    assert listing.projects[0].profile == "chatgpt-a-12345678" and listing.projects[1].profile is None
    assert hub_file.read_bytes() == before, "読み取りで hub.json が変わった"
    link = home / "link-config"
    link.mkdir()
    (link / "chatgpt-project-bridge").mkdir()
    (link / "chatgpt-project-bridge" / "hub.json").symlink_to(hub_file)
    assert "シンボリックリンク" in (gui.read_hub_projects({"HOME": str(home), "XDG_CONFIG_HOME": str(link)}).error or "")
    return ["無い hub.json を作らない・壊れた形は理由付きで返す・シンボリックリンクは読まない、を確かめた"]


# ---------------------------------------------------------------------------
# 4c〜4e. 表示用の引用・承認ダイアログの内容（敵対的な入力）・hub.json の堅牢化（純粋関数）
# ---------------------------------------------------------------------------


# 共通仕様 S2 の試験ベクトルと、S1 の禁止文字の判定を確かめる。
def check_display_quote(gui) -> list[str]:
    for source, expected in S2_VECTORS:
        actual = gui.quote_for_display(source)
        assert actual == expected, f"quote_for_display({source!r}) が {actual!r}（期待 {expected!r}）"
    for character in FORBIDDEN_SAMPLES:
        assert gui.has_forbidden_character(f"a{character}b"), f"禁止文字 U+{ord(character):04X} を見逃した"
        assert not gui.has_forbidden_character(gui.quote_for_display(f"a{character}b")), f"引用した結果に U+{ord(character):04X} が生のまま残った"
    for character in ALLOWED_SAMPLES:
        assert not gui.has_forbidden_character(f"a{character}b"), f"U+{ord(character):04X} を禁止文字とした（拒否しすぎ）"
    assert gui.quote_for_display("\ud800x") == '"\\ud800x"', "対にならないサロゲートが \\uXXXX にならない"
    assert gui.quote_for_display("a\u00a0b") == '"a\\u00a0b"', "U+0020 以外の空白が \\uXXXX にならない"
    return [f"S2 の試験ベクトル {len(S2_VECTORS)} 件（表の U+2028・U+202E・U+3000 の行は規則の文に従い \\uXXXX）・禁止文字 {len(FORBIDDEN_SAMPLES)} 種・許す文字 {len(ALLOWED_SAMPLES)} 種"]


# ログ欄の 1 行の整え方（NUL・ESC・DEL・C1 を \xNN、そのほかの禁止文字を \uXXXX、長い行の切り詰めと印）を確かめる。
def check_log_sanitize(gui) -> list[str]:
    cases = {
        "a\x00b\x1b[31mc": "a\\x00b\\x1b[31mc",
        "tab\tok\r": "tab\tok\\x0d",
        "\x7f\x85\x9b": "\\x7f\\x85\\x9b",
        "a\u2028b\u202ec\u200bd": "a\\u2028b\\u202ec\\u200bd",
        "日本語 😀 a\u3000b": "日本語 😀 a\u3000b",
        "z" * 20000: "z" * 20000,
    }  # 入力と、ログ欄に出す形。
    for source, expected in cases.items():
        assert gui.sanitize_log_line(source) == expected, f"ログ欄の行の整え方が違う: {source[:40]!r} → {gui.sanitize_log_line(source)[:60]!r}"
    shown = gui.sanitize_log_line("y" * 50000)
    assert shown == "y" * 20000 + gui.LOG_TRUNCATED_MARK, "20,000 文字を超える行が、切り詰めと印付きにならない"
    return ["NUL・ESC・CR・DEL・C1 は \\xNN、行区切り・双方向制御・ゼロ幅は \\uXXXX、TAB と日本語・絵文字はそのまま、20,000 文字で切り詰め"]


# 試験用の show-exposure の結果の公開範囲を、指定した欄だけ差し替えた写しを返す。
def with_exposure(report: dict, **fields) -> dict:
    changed = copy.deepcopy(report)
    changed["exposure"].update(fields)
    return changed


# 承認ダイアログの内容を作り、表示する全文字列に生の改行・禁止文字が無いことを確かめて (内容, 行の並び) を返す。
def checked_view(gui, report: dict, hub_warning: str | None = None):
    view = gui.approval_view(report, hub_warning)
    lines = gui.approval_view_lines(view)
    for line in lines:
        assert "\n" not in line and "\r" not in line, f"表示の文字列に生の改行がある: {line[:80]!r}"
        assert not gui.has_forbidden_character(line), f"表示の文字列に禁止文字が生のまま残っている: {line[:80]!r}"
    return view, lines


# 承認できない状態（承認ボタンが常に押せず、指紋も渡さない）であることを確かめ、(内容, 行の並び) を返す。
def assert_blocked(gui, report: dict, label: str):
    view, lines = checked_view(gui, report)
    assert view.blockers and view.blockers[0].startswith(gui.FORBIDDEN_MESSAGE), f"{label}: 「承認できません」の状態にならない"
    assert "該当項目:" in view.blockers[0], f"{label}: 該当項目が示されない"
    assert gui.grant_from_confirmation(report, str(report["projectRoot"]), None, True, override_acknowledged=True) is None, f"{label}: 承認（指紋）を返した"
    return view, lines


# 改行入りの allowFiles 名（本物の指紋の偽物・偽の「拒否ディレクトリ」行・空行 60 行）で、承認できない状態になること。
def check_attack_newline_name(gui) -> list[str]:
    fake = "README.md\n\n公開範囲の指紋（SHA-256）:\n  " + SHA_B + "\n拒否ディレクトリ: .git, node_modules, docs/private" + "\n" * 60  # 画面を偽装する名前。
    report = with_exposure(sample_report("unapproved", None), allowFiles=["README.md", fake])
    view, lines = assert_blocked(gui, report, "改行入りの allowFiles 名")
    assert "公開ファイル（allowFiles）の 2 番目" in view.blockers[0], view.blockers[0][:200]
    assert SHA_B not in [line.strip() for line in lines], "偽の指紋が 1 行として表示される"
    assert [line.strip() for line in lines].count(SHA_A) == 1, "本物の指紋が 1 行に 1 回だけ出ていない"
    assert not any(line.startswith("拒否ディレクトリ:") for line in lines), "偽の「拒否ディレクトリ」行が行として表示される"
    assert view.summary.files == 2, f"要約の件数が構造から数えられていない: {view.summary.files}"
    return [f"承認できない理由: {view.blockers[0][:90]}…"]


# 行区切り・段落区切り・双方向制御・ゼロ幅・ESC・C1 を含む値と、プロジェクトルート・プロファイルの禁止文字で、承認できない状態になること。
def check_attack_invisible(gui) -> list[str]:
    root = "/tmp/プロジェクト\u2029偽の行"  # 段落区切りを含むフォルダー名。
    cases = {
        "changes の U+2028・U+2029": sample_report("changed", SHA_B, ['allowFiles: [] -> ["a\u2028公開範囲の指紋（SHA-256）: ' + SHA_B + '"]', 'denyDirectories: [".git"] -> []\u2029']),
        "名前の U+202E・U+200B": with_exposure(sample_report("unapproved", None), allowFiles=["evil\u202edm.exe", "zero\u200bwidth.md"]),
        "名前の ESC・C1": with_exposure(sample_report("unapproved", None), denyDirectories=["esc\x1b[2Jname", "c1\x9bname"]),
        "フォルダー名の U+2029": sample_report("unapproved", None, root=root),
        "プロファイルの U+202E": {**sample_report("unapproved", None), "profile": "chatgpt-sample\u202e-1"},
        "公開ディレクトリの U+FEFF": with_exposure(sample_report("unapproved", None), allowDirectories=[{"path": "docs\ufeff", "recursive": True}]),
        "項目名（キー）の U+2066": with_exposure(sample_report("unapproved", None), **{"extra\u2066": 1}),
    }  # 名前と、禁止文字を含む show-exposure の結果。
    for label, report in cases.items():
        assert_blocked(gui, report, label)
    view, _lines = checked_view(gui, cases["フォルダー名の U+2029"])
    assert "\\u2029" in view.root_text, f"フォルダー名の段落区切りが見える形になっていない: {view.root_text}"
    return [f"{len(cases)} 通りすべて「承認できません」: {', '.join(cases)}"]


# 拒否ディレクトリの 1 項目に「docs/private, .claude, .git, …」があっても、1 項目 1 行で表示し、要約の件数が 1 になること。
def check_attack_comma_item(gui) -> list[str]:
    item = "docs/private, .claude, .git, node_modules, …"  # カンマで複数に見せかけた 1 項目。
    report = with_exposure(sample_report("unapproved", None), denyDirectories=[item])
    view, lines = checked_view(gui, report)
    assert not view.blockers, f"正常な名前を拒否した: {view.blockers}"
    assert view.summary.denied == 1 and "拒否ディレクトリ 1 件" in gui.summary_count_text(view.summary), gui.summary_count_text(view.summary)
    position = lines.index("拒否ディレクトリ（1 件）:")
    assert lines[position + 1] == f"  1. {gui.quote_for_display(item)}", lines[position + 1]
    assert not any(line.startswith("  2. ") for line in lines[position + 1:]), "1 項目が複数行に分かれた"
    assert gui.grant_from_confirmation(report, report["projectRoot"], None, True) is not None, "正常な内容を承認できない"
    return [f"表示: {lines[position + 1]}"]


# 日本語・絵文字・U+0020・U+3000 を含む正常な名前は承認できること（拒否しすぎない）。
def check_benign_names(gui) -> list[str]:
    names = ["日本語 の 文書.md", "絵文字😀.md", "a b.md", "全角\u3000空白.md", "docs/ドキュメント/メモ.md", "über-straße.md"]  # 正常な名前。
    report = with_exposure(sample_report("unapproved", None), allowFiles=names, denyDirectories=["秘密 フォルダー"])
    view, lines = checked_view(gui, report)
    assert not view.blockers, f"正常な名前を拒否した: {view.blockers}"
    assert '  4. "全角\\u3000空白.md"' in lines and '  2. "絵文字😀.md"' in lines, "U+3000 が \\u3000 に、絵文字がそのままにならない"
    assert not any(line.warning for line in view.details), "正常な名前に「混在した文字種」の印が付いた"
    assert gui.grant_from_confirmation(report, report["projectRoot"], None, True) == gui.ApprovalGrant(report["projectRoot"], None, SHA_A)
    return [f"正常な名前 {len(names) + 1} 件を承認できる"]


# 項目 200 件・5,000 件で、要約の件数が正しく、詳細に全件（番号付き）があること。
def check_large_exposure(gui) -> list[str]:
    notes = []  # 補足。
    for count in (200, 5000):
        files = [f"docs/file-{index:05d}.md" for index in range(1, count + 1)]  # 公開ファイル。
        directories = [{"path": f"dir-{index:05d}", "recursive": index % 3 == 0} for index in range(1, count + 1)]  # 公開ディレクトリ。
        denied = [f"deny-{index:05d}" for index in range(1, count + 1)]  # 拒否ディレクトリ。
        report = with_exposure(sample_report("unapproved", None), allowFiles=files, allowDirectories=directories, denyDirectories=denied)
        started = time.monotonic()
        view, lines = checked_view(gui, report)
        elapsed = time.monotonic() - started
        summary = view.summary
        assert (summary.files, summary.directories, summary.recursive_directories, summary.denied) == (count, count, count // 3, count), summary
        texts = set(lines)  # 表示する行。
        for index in range(1, count + 1):
            scope = "（配下すべて）" if index % 3 == 0 else "（直下だけ）"
            for expected in (f'  {index}. "docs/file-{index:05d}.md"', f'  {index}. "dir-{index:05d}"{scope}', f'  {index}. "deny-{index:05d}"'):
                assert expected in texts, f"{count} 件のうち「{expected}」が詳細に無い"
        assert not view.blockers
        notes.append(f"{count} 件: 要約「{gui.summary_count_text(summary)}」、詳細 {len(view.details)} 行、組み立て {elapsed:.2f} 秒")
    return notes


# approvedProjectRoot が別のフォルダーのときだけ、上書きの警告と追加の確認が要ること（共通仕様 S4）。
def check_override_warning(gui) -> list[str]:
    other = "/tmp/別のフォルダー"  # 前回の承認のフォルダー。
    changed = {**sample_report("changed", SHA_B, ['projectRoot: "/tmp/別のフォルダー" -> "/tmp/プロジェクト A"']), "approvedProjectRoot": other}
    view, _lines = checked_view(gui, changed)
    assert view.override_warning and gui.quote_for_display(other) in view.override_warning and not view.blockers, view.override_warning
    root = changed["projectRoot"]
    assert gui.grant_from_confirmation(changed, root, None, True) is None, "上書きの確認なしで指紋を渡した"
    assert gui.grant_from_confirmation(changed, root, None, True, override_acknowledged=True) == gui.ApprovalGrant(root, None, SHA_A)
    same = {**changed, "approvedProjectRoot": root}
    missing = {key: value for key, value in changed.items() if key != "approvedProjectRoot"}
    for label, report in (("同じフォルダー", same), ("null", {**changed, "approvedProjectRoot": None}), ("欄なし（古い CLI）", missing),
                          ("未承認", {**changed, "approvalState": "unapproved"})):
        assert gui.override_warning_text(report) is None, f"{label} で上書きの警告が出た"
        assert gui.grant_from_confirmation(report, root, None, True) is not None, f"{label} で承認できない"
    odd_root = {**changed, "approvedProjectRoot": "/tmp/x\u2029y"}
    assert "\\u2029" in (gui.override_warning_text(odd_root) or ""), "前回のフォルダー名の制御文字が見える形にならない"
    parsed, error = gui.parse_exposure_report(json.dumps({**changed, "approvedProjectRoot": 5}))
    assert parsed is None and error, "approvedProjectRoot の型の崩れを受け付けた"
    return [f"警告: {view.override_warning}"]


# ファイル名の 1 区切りの中でラテン文字とキリル文字・ギリシャ文字が混ざるときだけ「⚠ 混在した文字種」の印を付けること（承認は止めない）。
def check_mixed_scripts(gui) -> list[str]:
    marked = ["p" + chr(0x0430) + "ypal.md", "docs/" + chr(0x03A1) + "ython/readme.md", "dir/" + chr(0x0441) + "ontext.md", chr(0x0430) + chr(0x0431) + chr(0x0432) + ".txt"]  # 1 区切りの中で混ざった名前（キリル文字 U+0430・ギリシャ文字 U+03A1・キリル文字 U+0441。拡張子のラテン文字も混在に数える）。
    plain = [chr(0x0430) + chr(0x0431) + chr(0x0432) + "/readme.md", chr(0x03B1) + chr(0x03B2) + chr(0x03B3) + "/notes", "日本語.md", "readme.md", chr(0x0440) + chr(0x0430) + "/ypal.md"]  # 混ざっていない名前（区切りごとに 1 文字種）。
    report = with_exposure(sample_report("unapproved", None), allowFiles=marked + plain[:3], allowDirectories=[{"path": plain[3], "recursive": False}], denyDirectories=[plain[4]])
    view, _lines = checked_view(gui, report)
    warned = [line.text for line in view.details if line.warning]  # 印の付いた行。
    assert len(warned) == len(marked) and all(gui.MIXED_SCRIPT_MARK in line.warning for line in view.details if line.warning), warned
    assert not view.blockers and gui.grant_from_confirmation(report, report["projectRoot"], None, True) is not None, "文字種の混在で承認を止めた"
    return [f"印の付いた行: {warned}"]


# 偽の JSON の深い入れ子で、parse_exposure_report が例外を漏らさないこと。読めた場合も、内容の組み立てが落ちないこと。
def check_deep_json(gui) -> list[str]:
    notes = []  # 補足。
    for depth in (100, 900, 5000, 100000):
        nested = "[" * depth + "]" * depth  # 深い入れ子の配列。
        for text in (nested, '{"a":' * depth + "1" + "}" * depth, json.dumps(sample_report("unapproved", None))[:-1] + ', "deep": ' + nested + "}"):
            parsed, error = gui.parse_exposure_report(text)
            assert parsed is None or error is None
            if parsed is not None:
                gui.approval_view_lines(gui.approval_view(parsed))
        notes.append(f"JSON の入れ子 {depth}: 例外なし")
    report = with_exposure(sample_report("unapproved", None))
    deep: list = []  # JSON にできないほど深い入れ子（その他の項目）。
    for _level in range(20000):
        deep = [deep]
    report["exposure"]["deep"] = deep
    view = gui.approval_view(report)
    gui.approval_view_lines(view)
    assert any(blocker.startswith(gui.UNDISPLAYABLE_MESSAGE) for blocker in view.blockers), "表示できない項目があるのに承認できる状態にした"
    assert gui.grant_from_confirmation(report, report["projectRoot"], None, True) is None
    notes.append("表示できないほど深いその他の項目（入れ子 20,000）: 承認できない状態")
    return notes


# hub.json が FIFO・1 MiB 超・深い入れ子・他人のファイルのとき、固まらずに理由付きで読み飛ばすこと。
def check_hub_hardening(gui, temporary: Path) -> list[str]:
    home = temporary / "hub-hardening-home"  # 試験用の HOME。
    environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config")}
    hub_file = home / ".config" / "chatgpt-project-bridge" / "hub.json"
    hub_file.parent.mkdir(parents=True)
    notes = []  # 補足。

    # 別スレッドで読み、期限内に終わらなければ固まったとみなす。
    def read_with_timeout(seconds: float = 5.0):
        result = {}  # 読み取り結果。
        worker = threading.Thread(target=lambda: result.update(listing=gui.read_hub_projects(environment)), daemon=True)
        worker.start()
        worker.join(seconds)
        return result.get("listing"), worker

    os.mkfifo(hub_file)
    listing, worker = read_with_timeout()
    if worker.is_alive():
        try:
            descriptor = os.open(hub_file, os.O_WRONLY | os.O_NONBLOCK)  # 固まった読み手を解放する。
            os.close(descriptor)
        except OSError:
            pass
        worker.join(5)
        raise AssertionError("hub.json が FIFO のとき、読み取りが固まった")
    assert listing.error and "通常のファイルではない" in listing.error, listing
    notes.append(f"FIFO: {listing.error}")
    hub_file.unlink()
    hub_file.write_bytes(b'{"projects": [], "pad": "' + b"x" * (1024 * 1024) + b'"}')
    listing, _worker = read_with_timeout()
    assert listing.error and "大きすぎる" in listing.error and listing.projects == (), listing
    notes.append(f"1 MiB 超: {listing.error}")
    hub_file.write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
    listing, _worker = read_with_timeout()
    assert listing.error and "入れ子" in listing.error, listing
    notes.append(f"深い入れ子: {listing.error}")
    hub_file.write_text('{"projects": []}', encoding="utf-8")
    real_getuid = os.getuid  # 所有者の確認を試すため、一時的に別の利用者のふりをする。
    os.getuid = lambda: real_getuid() + 1
    try:
        listing = gui.read_hub_projects(environment)
    finally:
        os.getuid = real_getuid
    assert listing.error and "所有者" in listing.error, listing
    notes.append(f"他人のファイル（getuid を差し替えて模擬）: {listing.error}")
    approvals = hub_file.parent / "approvals"  # 所定の場所。
    record = {"projects": [
        {"name": "所定", "root": "/tmp/a", "approvalFile": str(approvals / "chatgpt-a-11111111.json")},
        {"name": "別の場所", "root": "/tmp/b", "approvalFile": "/x/approvals/chatgpt-b-22222222.json"},
        {"name": "相対", "root": "/tmp/c", "approvalFile": "approvals/chatgpt-c-33333333.json"},
        {"name": "正規化されていない", "root": "/tmp/d", "approvalFile": str(approvals) + "/../approvals/chatgpt-d-44444444.json"},
        {"name": "型違い", "root": "/tmp/e", "approvalFile": 5},
    ]}  # 承認ファイルの場所だけが違う登録。
    hub_file.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    listing = gui.read_hub_projects(environment)
    assert listing.error is None and [project.profile for project in listing.projects] == ["chatgpt-a-11111111", None, None, None, None], [project.profile for project in listing.projects]
    assert listing.projects[0].approval_problem is None and all(project.approval_problem for project in listing.projects[1:]), [project.approval_problem for project in listing.projects]
    notes.append(f"approvalFile が所定の場所でない登録 4 件は「確かめられません」: {listing.projects[1].approval_problem}")
    return notes


# ---------------------------------------------------------------------------
# 4f. ハブの稼働の判定と、分かっている値の探索（純粋関数。一時フォルダーだけを使う）
# ---------------------------------------------------------------------------


HUB_STATE_TOOLTIP_TEXT = (
    "この PC のハブ（Tunnel Client）のプロセスが動いているかを、3 秒ごとに調べて表示します。調べるのは、Tunnel Client が書く PID ファイルと、その PID のプロセスだけです"
    "（読み取りだけで、通信はしません。ハブ設定も読むだけです）。この画面の外（別の端末や自動起動）で起動したハブも表示します。"
    "「実行中」が示すのは、5 段階のうち 3 の「Tunnel Client の稼働」だけです。OpenAI とつながっているかは「ハブの稼働状態」で、ChatGPT から読めるかは ChatGPT の画面で確かめます。"
    "起動したときと「一覧を更新」のときには、分かっている値（「プロジェクトを追加」の Tunnel ID と、Tunnel Client の場所）を空の入力欄に入れます。入力済みの値は書き換えません。"
)  # 稼働表示の帯の説明（Windows 版と同じ文。画面の定数とは別に書いて突き合わせる）。
STAGE_TITLE_TOOLTIP_TEXT = (
    "ChatGPT から読めるまでの確認は 5 段階に分かれます。1 つの成功表示で、全部が済んだことにはなりません。"
    "画面の上の「ハブ」の表示が示すのは、3 の Tunnel Client のプロセスの有無だけです。"
)  # 「確認の 5 段階」の枠の説明（末尾の 1 文が、稼働表示の帯の注記）。
HUB_PROFILE = "chatgpt-hub-00000000"  # 試験用のハブのプロファイル名（実在しない）。
HUB_UNSET_DETAIL_TEXT = "Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。"  # 未設定の詳細（Windows 版と同じ文）。


# 稼働表示の詳細（実行中・停止中に共通の部分）の期待値を作る。
def hub_detail_text(tunnel_id: str, profile: str, count: int) -> str:
    return f"Tunnel ID: {tunnel_id} / プロファイル: {profile} / 登録 {count} 件"


# 一時フォルダーに、名前だけの実行ファイル（中身は空。起動はしない）を作って返す。
def fake_executable(path: Path, mode: int = 0o755) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    path.chmod(mode)
    return path


# /proc の代わりの一時フォルダーに、PID の cmdline（引数を NUL で区切って並べたもの）を書く。
def fake_process(process_directory: Path, pid: int, arguments: list[str]) -> None:
    directory = process_directory / str(pid)  # その PID のフォルダー。
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cmdline").write_bytes(b"".join(item.encode("utf-8") + b"\x00" for item in arguments))


# 試験用の hub.json を書く（画面は書かない。試験の準備として書く）。
def write_hub_file(hub_file: Path, **fields) -> None:
    hub_file.parent.mkdir(parents=True, exist_ok=True)
    hub_file.write_text(json.dumps({"schemaVersion": 1, "projects": [], **fields}, ensure_ascii=False), encoding="utf-8")


# 関数を別スレッドで呼び、期限内に終われば結果を返す。終わらなければ（固まったら）AssertionError。
def call_with_timeout(function, label: str, seconds: float = 5.0):
    result = {}  # 関数の結果。
    worker = threading.Thread(target=lambda: result.update(value=function()), daemon=True)
    worker.start()
    worker.join(seconds)
    assert not worker.is_alive(), f"{label}: 読み取りが固まった"
    assert "value" in result, f"{label}: 例外で終わった"
    return result["value"]


# PID ファイルの解釈・cmdline の照合・状態の文言 4 種・Tunnel Client の探索・自動入力の条件を、一時フォルダーだけで確かめる。
def check_hub_state(gui, temporary: Path) -> list[str]:
    notes = []  # 補足。
    home = temporary / "hub-state-home"  # 試験用の HOME（まだ作らない）。
    state_home = home / ".local" / "state"  # 試験用の XDG_STATE_HOME。
    empty_bin = temporary / "hub-state-empty-bin"  # tunnel-client の無い PATH の要素（作らない）。
    environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "XDG_STATE_HOME": str(state_home), "PATH": str(empty_bin)}
    process_directory = temporary / "hub-state-proc"  # /proc の代わりの一時フォルダー。
    other_profile = "chatgpt-hub-ffffffff"  # 別のプロファイル名。

    # PID ファイルの解釈: 半角の数字だけ（前後の空白と改行は除く）で、1 以上・上限以下のときだけ PID とみなす。
    pid_cases = {
        "1234": 1234, "1234\n": 1234, " 42 \r\n": 42, "0001234": 1234, str(gui.PID_LIMIT): gui.PID_LIMIT,
        "": None, "\n": None, "0": None, "12a4": None, "pid 12": None, "12 34": None, "-5": None, "+5": None, "1.5": None, "1_000": None, "0x10": None,
        "１２３": None, str(gui.PID_LIMIT + 1): None, "12345678": None, "9" * 30: None,
    }  # PID ファイルの中身と、期待する PID（PID とみなさないものは None）。
    for text, expected in pid_cases.items():
        assert gui.parse_pid_text(text) == expected, f"PID ファイルの解釈が違う: {text!r} → {gui.parse_pid_text(text)!r}（期待 {expected!r}）"
    notes.append(f"PID ファイルの解釈 {len(pid_cases)} 通り（数字だけ・空・文字入り・符号・全角・上限 {gui.PID_LIMIT} 超）")

    # PID ファイルの場所は CLI と同じ（XDG_STATE_HOME、無ければ ~/.local/state の下の tunnel-client）。読むだけで、作らない。
    assert gui.state_directory(environment) == state_home / "tunnel-client"
    assert gui.state_directory({"HOME": str(home)}) == home / ".local" / "state" / "tunnel-client"
    try:
        gui.state_directory({"HOME": str(home), "XDG_STATE_HOME": "relative/state"})
    except ValueError:
        pass
    else:
        raise AssertionError("相対パスの XDG_STATE_HOME を受け付けた")
    assert gui.read_pid_file(HUB_PROFILE, environment) is None and not home.exists(), "PID ファイルを読んだだけでディレクトリが作られた"
    assert gui.read_pid_file(HUB_PROFILE, {"HOME": str(home), "XDG_STATE_HOME": "relative/state"}) is None
    pid_file = state_home / "tunnel-client" / f"{HUB_PROFILE}.pid"  # Tunnel Client が書く PID ファイル（試験の準備として書く）。
    pid_file.parent.mkdir(parents=True)
    for text, expected in (("4321\n", 4321), ("4321", 4321), ("", None), ("12x\n", None), ("9" * 30, None), ("1" * 200, None)):
        pid_file.write_text(text, encoding="utf-8")
        assert gui.read_pid_file(HUB_PROFILE, environment) == expected, f"PID ファイルの読み取りが違う: {text[:20]!r}"
    pid_file.write_bytes(b"\xff\xfe12\n")
    assert gui.read_pid_file(HUB_PROFILE, environment) is None, "ASCII でない PID ファイルを受け付けた"
    for unsafe in ("../" + HUB_PROFILE, "Bad Name", "", HUB_PROFILE + "/x"):
        assert gui.read_pid_file(unsafe, environment) is None, f"プロファイル名の形式でない名前で PID ファイルを読んだ: {unsafe!r}"
    pid_file.unlink()
    real_pid_file = pid_file.parent / "real.pid"  # シンボリックリンクの先。
    real_pid_file.write_text("4321\n", encoding="utf-8")
    pid_file.symlink_to(real_pid_file)
    assert gui.read_pid_file(HUB_PROFILE, environment) is None, "シンボリックリンクの PID ファイルを読んだ"
    pid_file.unlink()
    os.mkfifo(pid_file)
    assert call_with_timeout(lambda: gui.read_pid_file(HUB_PROFILE, environment), "FIFO の PID ファイル") is None, "FIFO の PID ファイルを読んだ"
    pid_file.unlink()
    notes.append("PID ファイル: 無い・空・文字入り・大きすぎる・ASCII でない・シンボリックリンク・FIFO（固まらない）は PID なし")

    # cmdline の照合: 先頭の引数のファイル名が tunnel-client で、--profile のすぐ次がプロファイル名のときだけ合う（/proc の代わりに一時フォルダー）。
    client = "/home/user/.local/bin/tunnel-client"  # 試験用の Tunnel Client の場所（実在しない）。
    processes = {
        100: ([client, "run", "--profile-dir", "/x/profiles", "--profile", HUB_PROFILE, "--pid.file", "/x/hub.pid"], True, "合う"),
        101: ([client, "run", "--profile-dir", "/x/profiles", "--profile", other_profile], False, "プロファイル違い"),
        102: (["/usr/bin/python3", "/x/tunnel-client", "--profile", HUB_PROFILE], False, "別のプログラム"),
        103: ([client, "run", "--profile-dir", HUB_PROFILE, "--profile"], False, "--profile の次が無い"),
        104: ([client, "run", "--name", HUB_PROFILE, "--profile", other_profile], False, "プロファイル名が --profile の次ではない"),
        105: ([], False, "空の cmdline（終わったプロセス）"),
        106: (["tunnel-client", "--profile", HUB_PROFILE], True, "名前だけで起動した Tunnel Client"),
        107: ([client + "-old", "--profile", HUB_PROFILE], False, "名前の違う実行ファイル"),
        108: ([client, f"--profile={HUB_PROFILE}"], False, "= でつないだ形（CLI も実行中とみなさない）"),
    }  # PID から、(引数の並び, 合うか, 説明) への対応。
    for pid, (arguments, expected, label) in processes.items():
        fake_process(process_directory, pid, arguments)
        assert gui.matching_tunnel_process(pid, HUB_PROFILE, str(process_directory)) is expected, f"cmdline の照合が違う（{label}）"
        assert gui.is_tunnel_client_command(arguments, HUB_PROFILE) is expected, f"引数の並びの照合が違う（{label}）"
    assert gui.matching_tunnel_process(999, HUB_PROFILE, str(process_directory)) is False, "無い PID を実行中とみなした"
    (process_directory / "200").mkdir()
    (process_directory / "200" / "cmdline").symlink_to(process_directory / "100" / "cmdline")
    assert gui.matching_tunnel_process(200, HUB_PROFILE, str(process_directory)) is False, "シンボリックリンクの cmdline を読んだ"
    fake_process(process_directory, 201, [client, "--profile", HUB_PROFILE, "x" * (gui.COMMAND_LINE_LIMIT_BYTES + 1)])
    assert gui.matching_tunnel_process(201, HUB_PROFILE, str(process_directory)) is False, "上限を超える cmdline を読んだ"
    assert gui.split_command_line(b"a\x00\x00b\xff\x00") == ["a", "b�"]
    notes.append(f"cmdline の照合 {len(processes) + 3} 通り: " + "・".join(label for _arguments, _expected, label in processes.values()) + "・無い PID・シンボリックリンク・上限超")

    # 状態の文言 4 種（未設定・停止中・実行中・確認できません）と詳細。新しく使う記号は ●（U+25CF）と ○（U+25CB）だけ。
    hub_file = home / ".config" / "chatgpt-project-bridge" / "hub.json"  # 試験用の hub.json。

    # いまの hub.json・PID ファイル・/proc の代わりのフォルダーから、(読み取り結果, 稼働表示) を返す。
    def current_state():
        listing = gui.read_hub_projects(environment)
        return listing, gui.hub_state(listing, environment, str(process_directory))

    listing, state = current_state()
    assert listing.exists is False and (state.kind, state.text, state.detail, state.pid) == ("unset", "ハブ: 未設定", HUB_UNSET_DETAIL_TEXT, None), state
    assert not hub_file.parent.exists(), "稼働の判定で、hub.json のディレクトリが作られた"
    bad_tunnels = (None, "", "tunnel_" + "0" * 31, "tunnel_" + "0" * 33, "tunnel_" + "A" * 32, "TUNNEL_" + "0" * 32, TUNNEL_ID + "\n", " " + TUNNEL_ID, 5, [TUNNEL_ID])  # 形式に合わない tunnelId。
    for bad in bad_tunnels:
        write_hub_file(hub_file, profileName=HUB_PROFILE, tunnelId=bad)
        listing, state = current_state()
        assert listing.error is None and listing.tunnel_id is None and listing.profile_name == HUB_PROFILE, f"形式に合わない tunnelId を受け付けた: {bad!r}"
        assert (state.kind, state.text, state.detail) == ("unset", "ハブ: 未設定", HUB_UNSET_DETAIL_TEXT), f"形式に合わない tunnelId で未設定にならない: {bad!r}"
    write_hub_file(hub_file, profileName=HUB_PROFILE)
    assert current_state()[1].kind == "unset", "tunnelId の欄が無いのに未設定にならない"
    registered = [{"name": name, "root": f"/tmp/{name}", "approvalFile": "x"} for name in ("A", "B", "C")]  # 登録プロジェクト 3 件。
    write_hub_file(hub_file, profileName=HUB_PROFILE, tunnelId=TUNNEL_ID, projects=registered)
    listing, state = current_state()
    assert listing.tunnel_id == TUNNEL_ID and listing.profile_name == HUB_PROFILE and len(listing.projects) == 3
    stopped_detail = hub_detail_text(TUNNEL_ID, HUB_PROFILE, 3) + "。「ハブを起動」で起動します。"  # 停止中の詳細。
    assert (state.kind, state.text, state.detail, state.pid) == ("stopped", "ハブ: ○ 停止中", stopped_detail, None), state
    pid_file.write_text("100\n", encoding="utf-8")
    _listing, state = current_state()
    assert (state.kind, state.text, state.detail, state.pid) == ("running", "ハブ: ● 実行中（PID 100）", hub_detail_text(TUNNEL_ID, HUB_PROFILE, 3), 100), state
    assert gui.running_hub_pid(HUB_PROFILE, environment, str(process_directory)) == 100
    for text in ("101\n", "102\n", "999\n", "abc\n", ""):
        pid_file.write_text(text, encoding="utf-8")
        _listing, state = current_state()
        assert (state.kind, state.text, state.detail) == ("stopped", "ハブ: ○ 停止中", stopped_detail), f"PID ファイル {text!r} で停止中にならない: {state}"
    pid_file.write_text("100\n", encoding="utf-8")
    for bad in (None, "", "Bad Name", "../" + HUB_PROFILE, HUB_PROFILE + "\n", "a" * 64, 7):
        write_hub_file(hub_file, profileName=bad, tunnelId=TUNNEL_ID)
        listing, state = current_state()
        assert listing.profile_name is None and listing.tunnel_id == TUNNEL_ID, f"形式に合わない profileName を受け付けた: {bad!r}"
        assert (state.kind, state.text, state.detail) == ("unknown", "ハブ: 確認できません", gui.HUB_DETAIL_NO_PROFILE), f"プロファイル名を使えないのに確認できた: {bad!r}"
    for broken in ("{", "[]", '{"projects": 1}'):
        hub_file.write_text(broken, encoding="utf-8")
        listing, state = current_state()
        assert listing.error and (state.kind, state.text, state.detail, state.pid) == ("unknown", "ハブ: 確認できません", gui.escape_for_display(listing.error), None), state
    unknown_detail = state.detail  # 確認できないときの詳細（hub.json を読めなかった理由）。
    relative_listing = gui.read_hub_projects({"HOME": str(home), "XDG_CONFIG_HOME": "relative/path"})  # hub.json の場所が決まらない読み取り結果。
    relative_state = gui.hub_state(relative_listing, environment, str(process_directory))
    assert relative_listing.error and (relative_state.kind, relative_state.detail) == ("unknown", gui.escape_for_display(relative_listing.error)), relative_state
    hidden = gui.hub_state(gui.HubListing("", True, (), "理由‮偽装\n2 行目"), environment, str(process_directory))  # 制御文字を含む理由。
    assert hidden.kind == "unknown" and not gui.has_forbidden_character(hidden.detail) and "\\u202e" in hidden.detail, hidden.detail
    symbols = {character for text in (gui.HUB_STATE_RUNNING, gui.HUB_STATE_STOPPED, gui.HUB_STATE_UNSET, gui.HUB_STATE_UNKNOWN) for character in text if ord(character) > 0x7F and not character.isalnum() and character not in "（）"}  # 状態の文言の記号。
    assert symbols == {chr(0x25CF), chr(0x25CB)}, f"状態の文言に ● と ○ 以外の記号がある: {sorted(symbols)}"
    assert gui.HUB_STATE_TOOLTIP == HUB_STATE_TOOLTIP_TEXT, "稼働表示の帯の説明が、決めた文と違う"
    assert gui.STAGE_TITLE_TOOLTIP + gui.STAGE_HUB_NOTE == STAGE_TITLE_TOOLTIP_TEXT, "5 段階の枠の説明が、決めた文と違う"
    notes.append(f"状態の文言 4 種: ハブ: 未設定 / ハブ: ○ 停止中 / ハブ: ● 実行中（PID 100） / ハブ: 確認できません（{unknown_detail}）")
    hub_file.unlink()
    pid_file.unlink()

    # Tunnel Client の探索: CLI と同じ順（PATH、~/.local/bin、~/bin）。空・相対の PATH 要素と、実行できないファイルは使わない。
    path_client = temporary / "hub-state-bin" / "tunnel-client"  # PATH の中の Tunnel Client。
    local_client = home / ".local" / "bin" / "tunnel-client"  # ~/.local/bin の Tunnel Client。
    home_client = home / "bin" / "tunnel-client"  # ~/bin の Tunnel Client。
    assert gui.find_tunnel_client(environment) is None, "どこにも無いのに Tunnel Client を見つけた"
    fake_executable(home_client)
    assert gui.find_tunnel_client(environment) == str(home_client), "~/bin の Tunnel Client を見つけない"
    fake_executable(local_client, 0o644)
    assert gui.find_tunnel_client(environment) == str(home_client), "実行できない ~/.local/bin のファイルを選んだ"
    local_client.chmod(0o755)
    assert gui.find_tunnel_client(environment) == str(local_client), "~/.local/bin が ~/bin より先にならない"
    fake_executable(path_client)
    with_path = {**environment, "PATH": f"{empty_bin}{os.pathsep}{path_client.parent}"}  # PATH に Tunnel Client がある環境。
    assert gui.find_tunnel_client(with_path) == str(path_client), "PATH が ~/.local/bin より先にならない"
    assert gui.find_tunnel_client({**environment, "PATH": os.pathsep + os.path.relpath(path_client.parent) + os.pathsep}) == str(local_client), "空・相対パスの PATH 要素から Tunnel Client を拾った"
    path_client.chmod(0o644)
    assert gui.find_tunnel_client(with_path) == str(local_client), "PATH の中の実行できないファイルを選んだ"
    path_client.chmod(0o755)
    assert gui.find_tunnel_client({"PATH": str(path_client.parent), "HOME": str(temporary / "hub-state-no-home")}) == str(path_client)
    assert gui.find_tunnel_client({"PATH": "", "HOME": str(temporary / "hub-state-no-home")}) is None
    notes.append("Tunnel Client の探索: PATH → ~/.local/bin → ~/bin の順。無ければ None。空・相対の PATH 要素と実行できないファイルは使わない")

    # 自動で入れる値は 2 つだけ（hub-add の Tunnel ID・Tunnel Client の場所）。入れてよいのは、空か、前回入れた値のままの欄だけ。
    write_hub_file(hub_file, profileName=HUB_PROFILE, tunnelId=TUNNEL_ID, projects=registered)
    assert gui.known_values(gui.read_hub_projects(environment), with_path) == {gui.HUB_TUNNEL_BUFFER: TUNNEL_ID, "tunnel-client-path": str(path_client)}
    assert gui.known_values(gui.HubListing("", False, (), None), {"PATH": "", "HOME": str(temporary / "hub-state-no-home")}) == {}, "分からない値を入れようとした"
    assert gui.known_values(gui.HubListing("", True, (), "読めません"), {"PATH": "", "HOME": str(temporary / "hub-state-no-home")}) == {}
    odd_client = fake_executable(temporary / "hub-state-bin‮odd" / "tunnel-client")  # 双方向制御文字を含む場所の Tunnel Client。
    assert gui.find_tunnel_client({**environment, "PATH": str(odd_client.parent)}) == str(odd_client)
    assert "tunnel-client-path" not in gui.known_values(gui.HubListing("", False, (), None), {**environment, "PATH": str(odd_client.parent)}), "表示を偽装できる文字を含むパスを入れようとした"
    for current, previous, expected in (("", None, True), ("  ", None, True), ("", "old", True), ("old", "old", True), ("typed", None, False), ("typed", "old", False), ("old ", "old", False)):
        assert gui.autofill_allowed(current, previous) is expected, f"自動入力の条件が違う: 欄 {current!r}・前回 {previous!r}"
    assert gui.buffer_key("hub-add", "tunnel-id") == gui.HUB_TUNNEL_BUFFER != "tunnel-id", "hub-add の Tunnel ID 欄が共有のままになっている"
    assert gui.buffer_key("add-project", "tunnel-id") == gui.buffer_key("configure-tunnel", "tunnel-id") == "tunnel-id", "従来方式の Tunnel ID 欄が互いに共有されない"
    assert gui.buffer_key("hub-add", "tunnel-client-path") == gui.buffer_key("hub-start", "tunnel-client-path") == "tunnel-client-path"
    assert set(gui.SEPARATE_BUFFERS) == {("hub-add", "tunnel-id")}, f"共有から外す欄が想定と違う: {sorted(gui.SEPARATE_BUFFERS)}"
    notes.append("自動で入れる値は hub-add の Tunnel ID と Tunnel Client の場所だけ。入れるのは空の欄か、前回入れた値のままの欄だけ")
    return notes


# ---------------------------------------------------------------------------
# 4g. 権限の確認・切り替え（2.8.0）の純粋関数
# ---------------------------------------------------------------------------


# hub-permissions の解釈・set-permission の結果が渡したプロジェクトと一致するかの判定・切り替え先の値・一覧の 3 列の表示文を確かめる。
def check_permission_helpers(gui) -> list[str]:
    valid = {"schemaVersion": 1, "projects": [
        {"name": "A", "root": "/tmp/a", "profile": "p-a", "approvalState": "approved", "sourceRead": "on", "claudeCode": "on", "allowedCommandCount": 2, "error": None},
        {"name": "B", "root": "/tmp/b", "profile": "p-b", "approvalState": "unavailable", "sourceRead": None, "claudeCode": None, "allowedCommandCount": 0, "error": "設定ファイルがありません。"},
    ]}  # 正しい hub-permissions の結果（1 件は確認できた、1 件は確認できなかった）。
    projects, error = gui.parse_hub_permissions_report(json.dumps(valid, ensure_ascii=False))
    assert error is None and projects == valid["projects"], f"正しい hub-permissions の JSON を読めない: {error}"
    broken = [
        "", "not json", "[]", "null", None, b"{}",
        json.dumps({**valid, "schemaVersion": 2}), json.dumps({**valid, "projects": "x"}),
        json.dumps({"schemaVersion": 1, "projects": [{"name": "A"}]}),  # 欄が欠けている。
        json.dumps({"schemaVersion": 1, "projects": [{**valid["projects"][0], "approvalState": "maybe"}]}),
        json.dumps({"schemaVersion": 1, "projects": [{**valid["projects"][0], "sourceRead": "maybe"}]}),
        json.dumps({"schemaVersion": 1, "projects": [{**valid["projects"][0], "claudeCode": "maybe"}]}),
        json.dumps({"schemaVersion": 1, "projects": [{**valid["projects"][0], "allowedCommandCount": True}]}),
        json.dumps({"schemaVersion": 1, "projects": [{**valid["projects"][0], "name": 1}]}),
    ]  # 壊れた・形の違う入力（例外を出さず (None, 理由) に倒れること）。
    for item in broken:
        parsed, reason = gui.parse_hub_permissions_report(item)
        assert parsed is None and isinstance(reason, str) and reason, f"壊れた hub-permissions の入力を受け付けた: {str(item)[:60]}"

    # set-permission（指紋なし）の結果が、渡したプロジェクトのフォルダー・プロファイルと一致するか（末尾の / の違いは無視する）。
    assert gui.exposure_report_matches({"profile": "p-1", "projectRoot": "/tmp/a/"}, "/tmp/a", "p-1") is True
    assert gui.exposure_report_matches({"profile": "p-1", "projectRoot": "/tmp/a"}, "/tmp/a/", "p-1") is True
    assert gui.exposure_report_matches({"profile": "p-2", "projectRoot": "/tmp/a"}, "/tmp/a", "p-1") is False
    assert gui.exposure_report_matches({"profile": "p-1", "projectRoot": "/tmp/b"}, "/tmp/a", "p-1") is False

    # 切り替え先の値: on だけ反対（off）にし、それ以外（off・partial・unset・未確認）はすべて on にする。
    assert gui.toggled_permission_value("on") == "off"
    for current in ("off", "partial", "unset", None):
        assert gui.toggled_permission_value(current) == "on", f"{current!r} の切り替え先が on ではない"

    # 一覧の 3 列（ソースの読み取り・Claude Code・承認）の表示文。
    assert gui.permission_display_texts(None) == (gui.PERMISSION_UNKNOWN_TEXT,) * 3
    assert gui.permission_display_texts({"error": "設定ファイルがありません。"}) == ("確認できません（設定ファイルがありません。）",) * 3
    assert gui.permission_display_texts({"error": None, "sourceRead": "on", "claudeCode": "on", "allowedCommandCount": 3, "approvalState": "approved"}) == ("On", "On（コマンド 3 件）", "承認済み")
    assert gui.permission_display_texts({"error": None, "sourceRead": "off", "claudeCode": "on", "allowedCommandCount": 0, "approvalState": "changed"}) == ("Off", "On", "変更あり（再承認が必要）")
    assert gui.permission_display_texts({"error": None, "sourceRead": "partial", "claudeCode": "unset", "allowedCommandCount": 0, "approvalState": "unapproved"}) == ("一部のみ（使えません）", "設定なし", "未承認")
    assert gui.permission_display_texts({"error": None, "sourceRead": None, "claudeCode": None, "allowedCommandCount": 0, "approvalState": "unavailable"}) == (gui.PERMISSION_UNKNOWN_TEXT, gui.PERMISSION_UNKNOWN_TEXT, "確認できません")
    return [f"hub-permissions の解釈（正しい値・壊れた入力 {len(broken)} 通り）・set-permission との一致判定・切り替え先の値・一覧の 3 列の表示文を確かめた"]


# ---------------------------------------------------------------------------
# 5. 端末コマンドの組み立て
# ---------------------------------------------------------------------------


# 一時ディレクトリに、端末の名前の空の実行ファイルを作る（起動はしない）。x-terminal-emulator は target へのシンボリックリンクにする。
def fake_terminal_directory(base: Path, target: str = "gnome-terminal.wrapper") -> Path:
    base.mkdir(parents=True, exist_ok=True)
    for name in ("gnome-terminal", "ptyxis", "konsole", "xfce4-terminal", "xterm", target):
        path = base / name
        if not path.exists():
            path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            path.chmod(0o755)
    link = base / "x-terminal-emulator"
    if os.path.lexists(link):
        link.unlink()
    link.symlink_to(base / target)
    return base


# 端末ごとの引数配列と、端末が無いときの案内を確かめる（実際には起動しない）。
# （仕様変更: x-terminal-emulator は実体の名前が既知の端末のときだけ使うため、実在するシンボリックリンクで確かめる。A-14）
def check_terminals(gui, help_data: dict, cli_options: frozenset[str], temporary: Path) -> list[str]:
    root = f"/tmp/{TRICKY}"
    cli_arguments = gui.build_cli_arguments(help_data, "hub-add", {"project-root": root}, set(), cli_options, gui.ApprovalGrant(root, None, SHA_A))
    inner = gui.helper_arguments(cli_arguments)
    assert inner == [sys.executable, "-u", str(GUI_FILE), "--terminal-helper", "--", "hub-add", "--project-root", root, "--no-start", "--exposure-sha256", SHA_A], inner
    expected = {
        "x-terminal-emulator": ["-e"],
        "gnome-terminal": ["--wait", "--"],
        "ptyxis": ["--new-window", "--"],
        "konsole": ["-e"],
        "xfce4-terminal": ["-x"],
        "xterm": ["-e"],
    }  # 端末ごとの「コマンドを実行する」引数。
    assert [name for name, _arguments in gui.TERMINAL_CANDIDATES] == list(expected), "端末を探す順が違う"
    fake_bin = fake_terminal_directory(temporary / "fake-terminal-bin")  # 偽の端末の置き場所。
    for name, prefix in expected.items():
        found = gui.find_terminal(lambda candidate, wanted=name: str(fake_bin / candidate) if candidate == wanted else None)
        assert found == (name, str(fake_bin / name)), f"{name} を見つけられない: {found}"
        assert gui.terminal_command(*found, inner) == [str(fake_bin / name), *prefix, *inner], f"{name} の引数配列が違う"
    assert gui.find_terminal(lambda candidate: str(fake_bin / candidate))[0] == "x-terminal-emulator"
    assert gui.find_terminal(lambda candidate: str(fake_bin / candidate) if candidate in ("xterm", "gnome-terminal") else None)[0] == "gnome-terminal"
    assert gui.find_terminal(lambda candidate: None) is None
    message = gui.terminal_missing_message(cli_arguments)
    assert "端末を開いて貼り付けて実行してください" in message and shlex.split(message.splitlines()[-1]) == cli_arguments, "端末が無いときの案内が違う"
    for bad in (["sh", "-c", "echo"], cli_arguments[:3]):
        try:
            gui.helper_arguments(bad)
        except ValueError:
            continue
        raise AssertionError(f"helper_arguments が {bad} を受け付けた")
    installed = [name for name, _arguments in gui.TERMINAL_CANDIDATES if shutil.which(name)]
    return [f"この PC で見つかった端末: {installed or 'なし'}（起動はしていない）"]


# 端末窓のヘルパーを、キーを入力しない経路だけで実際に動かす（PyGObject を読まないことも確かめる）。
def check_terminal_helper(temporary: Path) -> list[str]:
    fake_root = temporary / "fake-gi"  # import されたら印を残す偽の gi。
    (fake_root / "gi").mkdir(parents=True)
    marker = temporary / "gi-imported"  # 偽の gi が読まれた印。
    (fake_root / "gi" / "__init__.py").write_text("import os\nopen(os.environ['GI_IMPORT_MARKER'], 'a').close()\nraise ImportError('gi must not be imported')\n", encoding="utf-8")
    environment = dict(os.environ)
    environment.update({"PYTHONPATH": str(fake_root), "GI_IMPORT_MARKER": str(marker)})
    project = temporary / "helper-project"  # 足場の無いフォルダー（save-key はキーを聞く前に失敗する）。
    project.mkdir()

    # ヘルパーを 1 回実行する。
    def run_helper(arguments: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-u", str(GUI_FILE), *arguments], input="\n", text=True, capture_output=True, env=environment, timeout=120, start_new_session=True, check=False)

    failed = run_helper(["--terminal-helper", "--", "save-key", "--project-root", str(project)])
    assert failed.returncode == 1, f"終了コードが 1 ではない: {failed.returncode} {failed.stderr}"
    assert "終了コード 1。Enter キーで閉じます" in failed.stdout and "ERROR:" in failed.stderr, failed.stdout + failed.stderr
    refused = run_helper(["--terminal-helper", "--", "hub-start"])
    assert refused.returncode == 2 and "ERROR:" in refused.stderr and "実行するコマンド" not in refused.stdout, refused.stdout + refused.stderr
    usage = run_helper(["--help"])
    assert usage.returncode == 0 and "使い方" in usage.stdout
    assert not marker.exists(), "ヘルパーか --help が PyGObject を読み込んだ"
    no_gi = run_helper([])
    assert no_gi.returncode == 1 and "python3-gi と gir1.2-gtk-3.0 が必要です: sudo apt install python3-gi gir1.2-gtk-3.0" in no_gi.stderr, no_gi.stderr
    headless = dict(os.environ)
    for name in ("DISPLAY", "WAYLAND_DISPLAY"):
        headless.pop(name, None)
    headless["GDK_BACKEND"] = "x11"
    no_display = subprocess.run([sys.executable, "-u", str(GUI_FILE)], text=True, capture_output=True, env=headless, timeout=120, start_new_session=True, check=False)
    assert no_display.returncode == 1 and "DISPLAY または WAYLAND_DISPLAY" in no_display.stderr, no_display.stderr
    return ["save-key（足場なし）で終了コード 1 と Enter 待ちの表示、キー以外の Action の拒否、PyGObject 無し・表示先無しの案内を確かめた"]


# PATH に空要素・相対要素があり、カレントディレクトリに x-terminal-emulator という実行ファイルがあっても、相対パスを採用しないこと。
# x-terminal-emulator は、実体の名前が既知の端末のときだけ使うこと。
def check_terminal_search(gui, temporary: Path) -> list[str]:
    trap = temporary / "terminal-trap"  # 罠の実行ファイルを置くカレントディレクトリ。
    (trap / "relative-bin").mkdir(parents=True)
    for path in (trap / "x-terminal-emulator", trap / "relative-bin" / "gnome-terminal"):
        path.write_text("#!/bin/sh\necho trap\n", encoding="utf-8")
        path.chmod(0o755)
    previous_directory = os.getcwd()  # 元のカレントディレクトリ。
    previous_path = os.environ.get("PATH", "")  # 元の PATH。
    found = {}  # PATH ごとの結果。
    try:
        os.chdir(trap)
        for search in (":relative-bin", "relative-bin::", ".:relative-bin", "/nonexistent-試験::relative-bin"):
            os.environ["PATH"] = search
            found[search] = gui.find_terminal()
    finally:
        os.environ["PATH"] = previous_path
        os.chdir(previous_directory)
    for search, result in found.items():
        assert result is None or os.path.isabs(result[1]), f"PATH={search!r} で相対パスの端末を採用した: {result}"
        assert result is None, f"PATH={search!r} で端末を見つけた（罠しか無いはず）: {result}"
    assert gui.find_terminal(lambda name: "x-terminal-emulator" if name == "x-terminal-emulator" else None) is None, "which が返した相対パスを採用した"
    unknown = fake_terminal_directory(temporary / "unknown-terminal-bin", target="evil-term")  # x-terminal-emulator が未知の端末を指す場所。
    (unknown / "gnome-terminal").unlink()
    result = gui.find_terminal(environment={"PATH": str(unknown)})
    assert result is not None and result[0] == "ptyxis", f"未知の端末を指す x-terminal-emulator を使った、または次の候補へ進まない: {result}"
    for name in ("ptyxis", "konsole", "xfce4-terminal", "xterm"):
        (unknown / name).unlink()
    assert gui.find_terminal(environment={"PATH": str(unknown)}) is None, "未知の端末しか無いのに端末を見つけた（コピー用の案内に回らない）"
    chain = temporary / "alternatives"  # /etc/alternatives を模した 2 段のリンク。
    known = fake_terminal_directory(temporary / "known-terminal-bin", target="konsole")
    chain.mkdir()
    (chain / "x-terminal-emulator").symlink_to(known / "konsole")
    (known / "x-terminal-emulator").unlink()
    (known / "x-terminal-emulator").symlink_to(chain / "x-terminal-emulator")
    result = gui.find_terminal(environment={"PATH": str(known)})
    assert result == ("x-terminal-emulator", str(known / "x-terminal-emulator")), f"既知の端末を指す x-terminal-emulator を使わない: {result}"
    return [f"PATH の空要素・相対要素 {len(found)} 通りで相対パスを採用しない。x-terminal-emulator → evil-term は使わず、→ konsole（2 段のリンク）は使う"]


# 端末窓のヘルパーが、Action とその Action で許すオプション（--name か --name=値）以外を拒否すること（純粋関数と実際の起動の両方）。
def check_helper_arguments(gui, help_data: dict, temporary: Path) -> list[str]:
    root = str(temporary / "helper-arguments")  # 試験用のフォルダー（足場は作らない）。
    accepted = [
        ["save-key", "--project-root", root],
        ["save-key", f"--project-root={root}", "--profile", "p-1", "--replace-key"],
        ["save-key", "--project-root=-dash"],
        ["hub-add", "--project-root", root, "--project-name", "名前 空白", "--no-start", "--exposure-sha256", SHA_A],
        ["add-project", "--project-root", root, "--tunnel-id", TUNNEL_ID, "--no-start", f"--exposure-sha256={SHA_A}"],
    ]  # 受け付ける引数（この画面が組むもの）。
    rejected = [
        [], ["hub-start"], ["--action", "save-key"], ["-Action", "save-key"],
        ["save-key", "--action", "hub-start"], ["save-key", "--action=hub-start"], ["save-key", "-Action", "hub-start"],
        ["save-key", "--project", root], ["save-key", "--project-r", root], ["save-key", "-ProjectRoot", root],
        ["save-key", "--project-root", root, "--verified"], ["save-key", "--project-root", root, "--help"], ["save-key", "--unknown-option"],
        ["save-key", "--project-root", "-x"], ["save-key", "--project-root"], ["save-key", root],
        ["save-key", "--project-root", root, "--project-root", root], ["save-key", "--replace-key=yes"],
        ["save-key", "--project-root", root, "--", "--force"], ["hub-add", "--exposure-sha256", "A" * 64], ["hub-add", "--tunnel-client-path", "-evil"],
    ]  # 拒否する引数。
    for arguments in accepted:
        assert gui.helper_argument_problem(help_data, arguments) is None, f"正しい引数を拒否した: {arguments}: {gui.helper_argument_problem(help_data, arguments)}"
    for arguments in rejected:
        assert gui.helper_argument_problem(help_data, arguments), f"拒否すべき引数を受け付けた: {arguments}"
    for arguments in (["--", "save-key", "--action", "hub-start"], ["--", "save-key", "--project-root", root, "--verified"], ["--", "save-key", "-Action", "hub-start"]):
        result = subprocess.run([sys.executable, "-u", str(GUI_FILE), "--terminal-helper", *arguments], input="\n", text=True, capture_output=True, env=dict(os.environ), timeout=120, start_new_session=True, check=False)
        assert result.returncode == 2 and "ERROR:" in result.stderr and "実行するコマンド" not in result.stdout, f"ヘルパーが {arguments} を実行した: {result.returncode} {result.stdout} {result.stderr}"
    return [f"受け付ける {len(accepted)} 通り・拒否する {len(rejected)} 通り（純粋関数）と、実際の起動で 3 通りを終了コード 2 で拒否"]


# 端末窓のヘルパーの Enter 待ちが、先行入力を捨て（tcflush）、待ち受けの間は入力を表示しないことを、疑似端末（pty）で確かめる。
def check_helper_enter_wait(temporary: Path) -> list[str]:
    project = temporary / "helper-pty-project"  # 足場の無いフォルダー（save-key はキーを聞く前に失敗する）。
    project.mkdir()
    master, slave = pty.openpty()
    process = subprocess.Popen([sys.executable, "-u", str(GUI_FILE), "--terminal-helper", "--", "save-key", "--project-root", str(project)],
                               stdin=slave, stdout=slave, stderr=slave, env=dict(os.environ), start_new_session=True, close_fds=True)
    os.close(slave)
    output = bytearray()  # 疑似端末に出た内容。

    # 疑似端末の出力を、期限まで（until が出たらそこまで）読む。
    def read_for(seconds: float, until: bytes | None = None) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _writable, _failed = select.select([master], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            if until is not None and until in output:
                return True
        return until is None or until in output

    try:
        os.write(master, b"early-junk\n")  # ヘルパーが Enter を待つ前に入った入力（貼り付けたキーの残りの代わり）。
        assert read_for(120, "Enter キーで閉じます".encode()), "Enter 待ちの表示が出ない: " + output.decode("utf-8", "replace")[-300:]
        mark = len(output)  # Enter 待ちの表示までの長さ。
        read_for(1.0)
        assert process.poll() is None, "先行入力で Enter 待ちが終わった（先行入力を捨てていない）"
        os.write(master, b"typed-secret\n")
        process.wait(timeout=30)
        read_for(0.5)
        later = bytes(output[mark:])  # Enter 待ちのあとに出た内容。
        assert b"typed-secret" not in later, "Enter 待ちの間に入力が表示された"
        assert process.returncode == 1, f"終了コードが 1 ではない: {process.returncode}"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
    return ["先行入力（early-junk）は捨てられ、Enter 待ちで入力した文字（typed-secret）は表示されない"]


# ---------------------------------------------------------------------------
# 6. 画面の構造（OffscreenWindow）と操作の流れ（子プロセスはスタブ）
# ---------------------------------------------------------------------------


class FakeChild:
    """子プロセスの代わり。結果は Recorder の respond で決め、None なら終わらない子として振る舞う。"""

    # 起動の引数と受け取り先を覚える。
    def __init__(self, recorder, arguments, environment, on_line, on_exit, capture):
        self.recorder = recorder  # 記録先。
        self.arguments = list(arguments)  # 起動した引数配列。
        self.environment = dict(environment)  # 渡された環境。
        self.on_line = on_line  # 1 行ごとの受け取り先。
        self.on_exit = on_exit  # 終了の受け取り先。
        self.capture = capture  # 標準出力をまとめて返すか。
        self.alive = False  # 終わらない子として動いているか。

    # 記録し、決めた結果をすぐ返す（None なら動き続ける）。
    def start(self):
        self.recorder.started.append(self.arguments)
        self.recorder.environments.append(self.environment)
        result = self.recorder.respond(self.arguments)
        if result is None:
            self.alive = True
            self.recorder.alive.append(self)
            return
        code, output, lines = result
        for line in lines:
            self.on_line(line)
        self.on_exit(code, output if self.capture else "")

    # 動き続けているかを返す。
    def running(self):
        return self.alive

    # シグナルを記録し、動いていれば終了したことにする。
    def terminate(self, signal_number=signal.SIGTERM):
        self.recorder.signals.append(signal_number)
        if self.alive:
            self.alive = False
            self.on_exit(-int(signal_number), "")

    # 終わっていれば True。
    def wait(self, timeout):
        return not self.alive


class FakePopen:
    """端末の起動の代わり。引数だけ記録する。"""

    # 引数を記録する。
    def __init__(self, recorder, command, **options):
        recorder.terminals.append((list(command), options))

    # すぐ終わったことにする。
    def wait(self, timeout=None):
        return 0


class Recorder:
    """スタブが受けた呼び出しの記録。"""

    # 記録を空にする。
    def __init__(self):
        self.started = []  # 起動した子プロセスの引数配列。
        self.environments = []  # 子プロセスへ渡した環境。
        self.signals = []  # 送ったシグナル。
        self.alive = []  # 動き続けている偽の子プロセス。
        self.terminals = []  # 起動した端末。
        self.messages = []  # お知らせの本文。
        self.copyable = []  # 端末が無いときの案内。
        self.approvals = []  # 承認ダイアログに渡された内容。
        self.respond = lambda arguments: (0, "", [])  # 子プロセスの結果を決める関数。

    # 子プロセスの代わりを作る。
    def factory(self, arguments, environment, on_line, on_exit, capture):
        return FakeChild(self, arguments, environment, on_line, on_exit, capture)

    # 端末の起動の代わり。
    def popen(self, command, **options):
        return FakePopen(self, command, **options)

    # 記録を消す（respond はそのまま）。
    def clear(self):
        for name in ("started", "environments", "signals", "alive", "terminals", "messages", "copyable", "approvals"):
            getattr(self, name).clear()


# GTK のイベントを処理しきる。
def pump(gtk, rounds: int = 20) -> None:
    for _round in range(rounds):
        while gtk.events_pending():
            gtk.main_iteration_do(False)
        time.sleep(0.005)


# ウィジェットを再帰的にたどる（Frame の見出し・Notebook のタブ見出しも含める。TreeView の内部は除く）。
def walk_widgets(gtk, widget, found: list, seen: set) -> list:
    if id(widget) in seen:
        return found
    seen.add(id(widget))
    found.append(widget)
    if isinstance(widget, gtk.TreeView):
        return found
    children = []  # たどる子。
    if isinstance(widget, gtk.Frame) and widget.get_label_widget() is not None:
        children.append(widget.get_label_widget())
    if isinstance(widget, gtk.Notebook):
        for index in range(widget.get_n_pages()):
            page = widget.get_nth_page(index)
            children.extend([page, widget.get_tab_label(page)])
    if isinstance(widget, gtk.Container):
        children.extend(widget.get_children())
    for child in children:
        walk_widgets(gtk, child, found, seen)
    return found


# OffscreenWindow の中身を PNG に保存する。直前の操作が描画に反映されるよう、先にイベントを処理しきる。
def save_png(gtk, offscreen, path: Path) -> None:
    offscreen.queue_draw()
    pump(gtk, 10)
    for _attempt in range(200):
        pump(gtk, 2)
        pixbuf = offscreen.get_pixbuf()
        if pixbuf is not None and pixbuf.get_width() > 1:
            pixbuf.savev(str(path), "png", [], [])
            return
    raise AssertionError(f"画面を画像にできませんでした: {path}")


# 名前でウィジェットを引く表を作る。
def by_name(widgets: list) -> dict:
    table = {}  # 名前からウィジェットへの対応。
    for widget in widgets:
        table.setdefault(widget.get_name(), widget)
    return table


# ログ欄の全文を返す。
def log_text(app) -> str:
    return app.text_of(app.log_view)


# PyGObject（GTK 3）を読み込み、表示先と初期化を確かめて Gtk を返す。使えなければ SkipTest。
def require_gtk(gui):
    try:
        gui.import_gtk()
    except (ImportError, ValueError) as error:
        raise SkipTest(f"PyGObject（Gtk 3.0）を読めません: {error}")
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise SkipTest("表示先（DISPLAY / WAYLAND_DISPLAY）がありません")
    if not gui.Gtk.init_check(None)[0]:
        raise SkipTest("GTK を初期化できません")
    gui.Gtk.Settings.get_default().set_property("gtk-enable-animations", False)  # 画像に切り替えの途中の状態が写らないようにする（この試験のプロセスだけ）。
    return gui.Gtk


# 承認パネルを作って OffscreenWindow に入れて描画し、(パネル, ウィンドウ, 応答の記録) を返す（ダイアログは開かない）。
def show_panel(gtk, gui, report: dict, hub_warning: str | None = None, size: tuple[int, int] = (860, 700)):
    responses = []  # パネルの応答。
    panel = gui.ApprovalPanel(report, hub_warning, responses.append)
    window = gtk.OffscreenWindow()
    window.set_size_request(*size)  # 本番のダイアログの既定の大きさ（860×700）に合わせる。
    window.add(panel.box)
    window.show_all()
    pump(gtk, 40)
    return panel, window, responses


# ウィジェットが表示されていて、ウィンドウの見える範囲に全部入っているかを返す。
def widget_inside(widget, window) -> bool:
    if not widget.get_mapped():
        return False
    position = widget.translate_coordinates(window, 0, 0)
    if position is None:
        return False
    x, y = position[-2:]
    allocation = widget.get_allocation()
    return x >= 0 and y >= 0 and x + allocation.width <= window.get_allocated_width() and y + allocation.height <= window.get_allocated_height()


# ラベルの文字が全部（省略・はみ出しなしで）見えるかと、表示の行数を返す。
def label_fully_visible(gtk, label, window) -> tuple[bool, int]:
    layout = label.get_layout()
    _ink, logical = layout.get_pixel_extents()
    allocation = label.get_allocation()
    fits = logical.width <= allocation.width and logical.height <= allocation.height  # 文字の範囲がラベルの中に収まるか。
    return widget_inside(label, window) and fits and label.get_ellipsize() == 0, layout.get_line_count()


# 詳細を末尾までスクロールし、描画とアイドルの処理を済ませる。
def scroll_details_to_end(gtk, panel) -> None:
    adjustment = panel.scrolled.get_vadjustment()
    for _attempt in range(20):
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
        pump(gtk, 5)
        if panel.read_reached:
            return


# 画面の構造・ツールチップ・既定値を確かめ、タブごとの PNG を保存し、操作の流れをスタブで確かめる。
def check_screen(gui, help_data: dict, cli_options: frozenset[str], temporary: Path, screenshot_directory: Path) -> list[str]:
    try:
        gui.import_gtk()
    except (ImportError, ValueError) as error:
        raise SkipTest(f"PyGObject（Gtk 3.0）を読めません: {error}")
    gtk = gui.Gtk
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise SkipTest("表示先（DISPLAY / WAYLAND_DISPLAY）がありません")
    if not gtk.init_check(None)[0]:
        raise SkipTest("GTK を初期化できません")
    import gi

    gi.require_version("Pango", "1.0")
    from gi.repository import Pango

    notes = []  # 補足。
    projects = {name: temporary / f"screen-{name}" for name in ("Alpha", "Beta", "Gamma", "Delta")}  # 試験用の登録プロジェクト。
    for path in projects.values():
        path.mkdir()
    approvals = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "approvals"  # 試験用 hub.json が指す承認の場所（作らない）。
    hub_projects = [
        {"name": "Alpha", "root": str(projects["Alpha"]), "approvalFile": str(approvals / "chatgpt-alpha-11111111.json")},
        {"name": "Beta", "root": str(projects["Beta"]), "approvalFile": str(approvals / "chatgpt-beta-22222222.json")},
        {"name": "Gamma", "root": str(projects["Gamma"]), "approvalFile": str(approvals / "chatgpt-gamma-33333333.json")},
        {"name": "Delta", "root": str(projects["Delta"]), "approvalFile": "broken"},
    ]  # 試験用 hub.json の登録内容。
    hub_file = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "hub.json"  # 一時 HOME の中の hub.json。
    hub_file.parent.mkdir(parents=True, exist_ok=True)
    hub_file.write_text(json.dumps({"schemaVersion": 1, "profileName": HUB_PROFILE, "tunnelId": TUNNEL_ID, "projects": hub_projects}, ensure_ascii=False), encoding="utf-8")
    hub_before = hub_file.read_bytes()
    detected_client = str(fake_executable(temporary / "screen-bin" / "tunnel-client"))  # 自動で入るはずの Tunnel Client の場所（空の実行ファイル。起動はしない）。
    screen_environment = {**os.environ, "PATH": str(temporary / "screen-bin")}  # 画面に渡す環境。PATH をここだけにして、実機の PATH にある tunnel-client に左右されないようにする。

    recorder = Recorder()
    app = gui.BridgeApp(help_data, cli_options, screen_environment, child_factory=recorder.factory, which=lambda name: None, terminal_popen=recorder.popen)

    # 試験中に本物のダイアログが開かないよう、全部スタブへ差し替える（呼ばれたら記録する）。
    def unexpected(kind):
        # 想定外のダイアログ呼び出しを失敗にする。
        def fail(*_values):
            raise AssertionError(f"想定外のダイアログ: {kind}")
        return fail

    app.confirm_dangerous = unexpected("上書き系の確認")
    app.ask_approval = unexpected("承認")
    app.show_message = recorder.messages.append
    app.show_copyable_command = lambda message, command: recorder.copyable.append((message, command))
    app.ask_close = unexpected("閉じる確認")
    app.call_later = lambda milliseconds, function: function()

    offscreen = gtk.OffscreenWindow()
    offscreen.set_size_request(1100, 860)  # 本番のウィンドウの既定の大きさに合わせる（OffscreenWindow は既定の大きさを使わない）。
    offscreen.add(app.root_widget)
    offscreen.show_all()
    pump(gtk)
    widgets = walk_widgets(gtk, app.root_widget, [], set())
    named = by_name(widgets)

    # 操作できるウィジェットと、名前を付けたラベルに、空でない説明（正しい markup）があること。
    operable = (gtk.Button, gtk.Entry, gtk.TextView, gtk.TreeView)
    lacking = []  # 説明の無いウィジェット。
    checked = 0  # 説明を確かめた数。
    for widget in widgets:
        needs = isinstance(widget, operable) or (isinstance(widget, gtk.Label) and not widget.get_name().startswith("Gtk"))
        if not needs:
            continue
        markup = widget.get_tooltip_markup() or ""
        if not markup.strip():
            lacking.append(f"{type(widget).__name__}:{widget.get_name()}:{getattr(widget, 'get_label', lambda: '')() or ''}")
            continue
        Pango.parse_markup(markup, -1, "\0")
        checked += 1
    assert not lacking, f"説明の無いウィジェット: {lacking[:10]}"
    notes.append(f"説明を確かめたウィジェット: {checked} 個（ボタン・入力欄・チェック・テキスト欄・一覧・名前付きラベル）")

    # カードは Action ごとに 1 つずつ（26 個）。
    cards = [widget.get_name()[len("card:"):] for widget in widgets if widget.get_name().startswith("card:")]
    assert len(cards) == 26 and set(cards) == set(help_data["actions"]), f"カードの数か種類が違う: {len(cards)}"
    tabs = [app.notebook.get_tab_label(app.notebook.get_nth_page(index)).get_text() for index in range(app.notebook.get_n_pages())]
    assert tabs == [help_data["groups"][group] for group in EXPECTED_GROUPS], f"タブの並びが違う: {tabs}"
    for index, group in enumerate(EXPECTED_GROUPS):
        page_cards = [name for name in cards if help_data["actions"][name]["group"] == group]
        page_widgets = walk_widgets(gtk, app.notebook.get_nth_page(index), [], set())
        assert [widget.get_name()[5:] for widget in page_widgets if widget.get_name().startswith("card:")] == page_cards, f"{group} タブのカードの並びが違う"
    maintainer_page = walk_widgets(gtk, app.notebook.get_nth_page(3), [], set())
    first_label = next(widget for widget in maintainer_page if isinstance(widget, gtk.Label) and not widget.get_name().startswith("Gtk"))
    assert first_label.get_name() == "maintainer-warning" and first_label.get_text() == gui.MAINTAINER_WARNING, "保守者向けタブの先頭に警告が無い"
    assert not any(":exposure-sha256" in widget.get_name() for widget in widgets), "指紋の入力欄がある"
    for action, info in help_data["actions"].items():
        assert f"run:{action}" in named, f"{action} の実行ボタンが無い"
        for option in gui.visible_options(help_data, action, cli_options):
            kind = help_data["options"][option]["kind"]
            if kind == "flag":
                check = named.get(f"option-check:{action}:{option}")
                assert check is not None, f"{action} の {option} のチェックが無い"
                if help_data["options"][option]["dangerous"]:
                    assert not check.get_active(), f"{action} の {option} が既定でオン"
                continue
            label = named.get(f"option-label:{action}:{option}")
            assert label is not None and f"option-input:{action}:{option}" in named, f"{action} の {option} の欄が無い"
            assert label.get_text().endswith("＊") == (option in info["required"]), f"{action} の {option} の必須の印が違う: {label.get_text()}"
            if kind == "path":
                assert f"option-choose:{action}:{option}" in named, f"{action} の {option} に「選択…」が無い"
    assert "option-check:hub-service-install:no-start" not in named and "option-check:hub-service-install:no-enable" in named
    for action in ("hub-stop", "hub-service-install"):
        assert f"option-input:{action}:tunnel-client-path" in named and f"option-choose:{action}:tunnel-client-path" in named, f"{action} に Tunnel Client の場所の欄が無い"
    for action, option in (("add-project", "no-start"), ("hub-add", "no-start"), ("hub-start", "service"), ("hub-restart", "service")):
        forced = named[f"option-check:{action}:{option}"]
        assert forced.get_active() and not forced.get_sensitive(), f"{action} の {option} が常にオン（変更不可）になっていない"
    for action in ("start", "hub-start", "hub-restart"):
        assert f"stop:{action}" in named and not named[f"stop:{action}"].get_visible(), f"{action} の停止ボタンが無いか、最初から見えている"
    for index in range(1, 6):
        assert f"stage:{index}" in named, f"確認の段階 {index} が無い"
    assert "前の 3 つ" in named["stage:note"].get_text() and "ChatGPT 側" in named["stage:note"].get_text()
    assert app.hub_store.iter_n_children(None) == 4 and "登録 4 件" in named["hub-list-status"].get_text(), named["hub-list-status"].get_text()
    # 一覧の列（2.8.0）: 既存の 0〜2 列目（名前・フォルダー・承認ファイル）はそのまま、3〜5 列目（ソースの読み取り・Claude Code・承認）は、権限を確認するまで「（未確認）」。
    hub_rows = [tuple(row) for row in app.hub_store]
    assert len(hub_rows) == 4 and all(len(row) == 6 for row in hub_rows), f"一覧の列数が違う: {[len(row) for row in hub_rows]}"
    assert [row[3:] for row in hub_rows] == [(gui.PERMISSION_UNKNOWN_TEXT, gui.PERMISSION_UNKNOWN_TEXT, gui.PERMISSION_UNKNOWN_TEXT)] * 4, "権限を確認する前の列が「（未確認）」ではない"
    for name in ("hub-permission-check", "hub-permission-toggle-source-read", "hub-permission-toggle-claude-code"):
        assert name in named, f"権限のボタン {name} が無い"
    assert named["hub-permission-check"].get_sensitive() and named["hub-permission-toggle-source-read"].get_sensitive() and named["hub-permission-toggle-claude-code"].get_sensitive()
    assert named["hub-permission-check"].get_tooltip_markup() == gui.plain_tooltip(gui.PERMISSION_CHECK_TOOLTIP), "「権限を確認」の説明が決めた文と違う"
    assert named["hub-permission-toggle-source-read"].get_tooltip_markup() == gui.plain_tooltip(gui.PERMISSION_TOGGLE_TOOLTIPS["source-read"])
    assert named["hub-permission-toggle-claude-code"].get_tooltip_markup() == gui.plain_tooltip(gui.PERMISSION_TOGGLE_TOOLTIPS["claude-code"])
    run_tooltip = named["run:hub-add"].get_tooltip_markup()
    for heading in ("【いつ使う】", "【事前に必要】", "【実行すると】", "【次にすること】", "【注意】", "【この画面では】"):
        assert heading in run_tooltip, f"hub-add の説明に {heading} が無い"
    root_tooltip = named["option-input:hub-add:project-root"].get_tooltip_markup()
    assert "【入力例】" in root_tooltip and "【既定】" in root_tooltip and "【注意】" in root_tooltip

    # ハブの稼働表示の帯: タブの外に 2 つのラベルがあり、決めた説明が付き、どのタブを開いていても見える。画面全体は縦の Paned のまま。
    # 試験の hub.json（Tunnel ID あり・PID ファイルなし）では「停止中」。画面を作っただけでは、繰り返しタイマーは始まっていない。
    assert app.hub_timer is None, "画面を作っただけで、稼働表示の繰り返しタイマーが始まった"
    assert isinstance(app.root_widget, gtk.Paned) and app.root_widget.get_orientation() == gtk.Orientation.VERTICAL, "画面全体が縦の Paned ではない"
    band_state, band_detail = named.get("hub-state"), named.get("hub-state-detail")
    assert isinstance(band_state, gtk.Label) and isinstance(band_detail, gtk.Label), "稼働表示の帯の 2 つのラベルが無い"
    assert not any(widget is band_state or widget is band_detail for widget in walk_widgets(gtk, app.notebook, [], set())), "稼働表示の帯がタブの中にある"
    for label in (band_state, band_detail):
        assert label.get_tooltip_markup() == gui.plain_tooltip(HUB_STATE_TOOLTIP_TEXT), f"{label.get_name()} の説明が、決めた文と違う"
    stopped_detail = hub_detail_text(TUNNEL_ID, HUB_PROFILE, 4) + "。「ハブを起動」で起動します。"  # 停止中の詳細。
    assert band_state.get_text() == "ハブ: ○ 停止中" and band_detail.get_text() == stopped_detail, f"{band_state.get_text()} / {band_detail.get_text()}"
    assert gui.HUB_RUNNING_COLOR not in band_state.get_label(), "停止中なのに「実行中」の色が付いている"
    for index in range(app.notebook.get_n_pages()):
        app.notebook.set_current_page(index)
        pump(gtk, 2)
        assert widget_inside(band_state, offscreen) and widget_inside(band_detail, offscreen), f"{index + 1} 番目のタブで、稼働表示の帯が見える範囲に無い"
        assert band_state.translate_coordinates(offscreen, 0, 0)[-1] < app.notebook.translate_coordinates(offscreen, 0, 0)[-1], "稼働表示の帯がタブより上に無い"
    app.notebook.set_current_page(0)
    assert named["stage-title"].get_tooltip_markup() == gui.plain_tooltip(STAGE_TITLE_TOOLTIP_TEXT), "5 段階の枠の説明に、稼働表示の帯の注記が無い"
    # PID ファイルと、その PID のプロセス（/proc の代わりの一時フォルダー）がそろうと「実行中」（緑）。繰り返しタイマーの処理で切り替わる。
    app.process_directory = str(temporary / "screen-proc")
    fake_process(temporary / "screen-proc", 4321, ["/opt/tunnel-client", "run", "--profile-dir", "/x/profiles", "--profile", HUB_PROFILE])
    pid_file = Path(os.environ["XDG_STATE_HOME"]) / "tunnel-client" / f"{HUB_PROFILE}.pid"  # Tunnel Client が書く PID ファイル（試験の準備として書く）。
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text("4321\n", encoding="utf-8")
    assert app.on_hub_timer() is True, "繰り返しタイマーの処理が、繰り返し（True）を返さない"
    assert band_state.get_text() == "ハブ: ● 実行中（PID 4321）" and band_detail.get_text() == hub_detail_text(TUNNEL_ID, HUB_PROFILE, 4), f"{band_state.get_text()} / {band_detail.get_text()}"
    assert f'foreground="{gui.HUB_RUNNING_COLOR}"' in band_state.get_label(), "「実行中」が緑になっていない"
    running_png = screenshot_directory / "00-hub-running.png"  # 「実行中」の帯が写った画像。
    save_png(gtk, offscreen, running_png)
    pid_file.write_text("4322\n", encoding="utf-8")
    assert app.on_hub_timer() is True and band_state.get_text() == "ハブ: ○ 停止中", "PID のプロセスが無いのに停止中にならない"
    pid_file.unlink()
    assert app.on_hub_timer() is True and band_state.get_text() == "ハブ: ○ 停止中" and band_detail.get_text() == stopped_detail
    assert app.hub_timer is None and hub_file.read_bytes() == hub_before, "稼働の判定で、タイマーが始まったか、hub.json が変わった"

    # 分かっている値の自動入力: hub-add の Tunnel ID 欄（専用）と、Tunnel Client の場所（10 枚のカードで共有）にだけ入る。
    # 従来方式（add-project・configure-tunnel）の Tunnel ID 欄は空のままで、その 2 つは互いに共有する。
    hub_tunnel = named["option-input:hub-add:tunnel-id"]  # 「プロジェクトを追加」の Tunnel ID 欄。
    legacy_tunnels = [named[f"option-input:{action}:tunnel-id"] for action in ("add-project", "configure-tunnel")]  # 従来方式の Tunnel ID 欄。
    client_inputs = [widget for widget in widgets if widget.get_name().startswith("option-input:") and widget.get_name().endswith(":tunnel-client-path")]  # Tunnel Client の場所の欄。
    assert hub_tunnel.get_text() == TUNNEL_ID, f"hub-add の Tunnel ID 欄に、ハブの Tunnel ID が入っていない: {hub_tunnel.get_text()!r}"
    assert [entry.get_text() for entry in legacy_tunnels] == ["", ""], "ハブの Tunnel ID が、従来方式の Tunnel ID 欄に入った"
    assert len(client_inputs) == 10 and {entry.get_text() for entry in client_inputs} == {detected_client}, f"Tunnel Client の場所が入っていない: { {entry.get_text() for entry in client_inputs} }"
    filled = {widget.get_name() for widget in widgets if isinstance(widget, gtk.Entry) and not isinstance(widget, gtk.SpinButton) and widget.get_text()}  # 値の入っている入力欄。
    assert filled == {hub_tunnel.get_name(), *(entry.get_name() for entry in client_inputs)}, f"決めた 2 種類の欄以外に値が入っている: {sorted(filled)}"
    legacy_tunnel = "tunnel_" + "f" * 32  # 従来方式の欄に入れる別の Tunnel ID。
    legacy_tunnels[0].set_text(legacy_tunnel)
    assert legacy_tunnels[1].get_text() == legacy_tunnel and hub_tunnel.get_text() == TUNNEL_ID, "従来方式の Tunnel ID 欄が互いに共有されないか、hub-add の欄と共有されている"
    assert app.collect_values("hub-add")["tunnel-id"] == TUNNEL_ID and app.collect_values("add-project")["tunnel-id"] == legacy_tunnel == app.collect_values("configure-tunnel")["tunnel-id"]
    legacy_tunnels[0].set_text("")
    # 利用者が入れた値は、refresh_hub_list()（「一覧を更新」）で書き換わらない。
    typed_tunnel = "tunnel_" + "9" * 32  # 利用者が入れた Tunnel ID。
    typed_client = "/opt/利用者 の/tunnel-client"  # 利用者が入れた Tunnel Client の場所。
    hub_tunnel.set_text(typed_tunnel)
    app.entry_buffers["tunnel-client-path"].set_text(typed_client, -1)
    app.refresh_hub_list()
    named["hub-list-refresh"].clicked()
    assert hub_tunnel.get_text() == typed_tunnel and {entry.get_text() for entry in client_inputs} == {typed_client}, "利用者が入れた値を書き換えた"
    # 空に戻した欄には、繰り返しタイマーでは入れず、「一覧を更新」で入れ直す。
    hub_tunnel.set_text("")
    app.entry_buffers["tunnel-client-path"].set_text("", -1)
    assert app.on_hub_timer() is True and hub_tunnel.get_text() == "" and {entry.get_text() for entry in client_inputs} == {""}, "繰り返しタイマーが入力欄に値を入れた"
    named["hub-list-refresh"].clicked()
    assert hub_tunnel.get_text() == TUNNEL_ID and {entry.get_text() for entry in client_inputs} == {detected_client}, "空の欄に、分かっている値が入り直さない"
    # 自動で入れた値のままの欄は、hub.json の Tunnel ID が変われば入れ直す（従来方式の欄には入れない）。試験の準備として hub.json を書き換え、元に戻す。
    other_tunnel = "tunnel_" + "fedcba9876543210" * 2  # 別の Tunnel ID。
    hub_file.write_text(json.dumps({"schemaVersion": 1, "profileName": HUB_PROFILE, "tunnelId": other_tunnel, "projects": hub_projects}, ensure_ascii=False), encoding="utf-8")
    app.refresh_hub_list()
    assert hub_tunnel.get_text() == other_tunnel and band_detail.get_text().startswith(hub_detail_text(other_tunnel, HUB_PROFILE, 4)), "自動で入れた値のままの欄が、新しい値に入れ直されない"
    hub_file.write_bytes(hub_before)
    app.refresh_hub_list()
    assert hub_tunnel.get_text() == TUNNEL_ID and [entry.get_text() for entry in legacy_tunnels] == ["", ""] and band_detail.get_text() == stopped_detail
    notes.append(f"稼働表示の帯: {band_state.get_text()} / {band_detail.get_text()}（実行中の画像: {running_png}）")
    notes.append(f"自動入力: hub-add の Tunnel ID と、Tunnel Client の場所（{len(client_inputs)} 枚。{detected_client}）だけ。従来方式の Tunnel ID 欄は空のまま")

    # 同じオプションの値は全カードで共有し、フラグはカードごと。
    app.entry_buffers["project-root"].set_text("/tmp/共有の値", -1)
    pump(gtk)
    shared = [widget.get_text() for widget in widgets if widget.get_name().startswith("option-input:") and widget.get_name().endswith(":project-root")]
    assert len(shared) > 3 and set(shared) == {"/tmp/共有の値"}, f"project-root が共有されていない: {set(shared)}"
    named["option-check:hub-add:no-browser"].set_active(True)
    assert not named["option-check:add-project:no-browser"].get_active(), "フラグがカード間で共有されている"
    named["option-check:hub-add:no-browser"].set_active(False)

    # 上書き系: オンにするたび確認し、キャンセルなら戻す。オフにするときは聞かない。
    asked = []  # 確認に渡されたオプション。
    app.confirm_dangerous = lambda option: asked.append(option) or False
    force = named["option-check:init:force"]
    force.set_active(True)
    pump(gtk)
    assert not force.get_active() and asked == ["force"], "キャンセルしたのに上書き系がオンのまま"
    app.confirm_dangerous = lambda option: asked.append(option) or True
    force.set_active(True)
    force.set_active(False)
    assert asked == ["force", "force"], f"確認の回数が違う: {asked}"
    for option in ("force-reconfigure", "replace-key"):
        check = named[f"option-check:hub-add:{option}"]
        app.confirm_dangerous = lambda option_name: asked.append(option_name) or False
        check.set_active(True)
        assert not check.get_active() and asked[-1] == option
    app.confirm_dangerous = unexpected("上書き系の確認")

    # 必須欄が空なら、どの欄かを示して中止する（CLI を呼ばない）。
    app.entry_buffers["project-root"].set_text("", -1)
    named["run:init"].clicked()
    assert recorder.started == [] and recorder.messages and "プロジェクトのフォルダー" in recorder.messages[-1], recorder.messages
    named["run:hub-remove"].clicked()
    assert recorder.started == [] and "ハブ内の名前" in recorder.messages[-1]
    named["run:add-project"].clicked()
    assert recorder.started == [] and "Tunnel ID" in recorder.messages[-1] and "プロジェクトのフォルダー" in recorder.messages[-1]

    # 承認の要らない操作: 引数配列どおりに 1 回呼び、終了コードを出す。
    prefix = [sys.executable, "-u", str(CLI_FILE)]
    recorder.clear()
    named["run:hub-list"].clicked()
    assert recorder.started == [prefix + ["hub-list"]] and app.job is None
    assert set(recorder.environments[0]) - set(os.environ) == {"PYTHONIOENCODING"} or set(recorder.environments[0]) - set(os.environ) == set()
    assert "終了コード 0" in log_text(app) and gui.SUCCESS_MESSAGE in log_text(app)
    recorder.respond = lambda arguments: (3, "", ["ERROR: 模擬の失敗"])
    named["run:hub-status"].clicked()
    assert "終了コード 3" in log_text(app).splitlines()[-2] and log_text(app).splitlines()[-1] == gui.FAILURE_MESSAGE

    # 承認（approve）: 未承認 → キャンセルなら何も実行しない。
    project = temporary / "screen-approve"
    project.mkdir()
    app.entry_buffers["project-root"].set_text(str(project), -1)
    unapproved = sample_report("unapproved", None, root=str(project))
    recorder.clear()
    recorder.respond = lambda arguments: (0, json.dumps(unapproved, ensure_ascii=False), []) if arguments[3] == "show-exposure" else (0, "", ["承認を保存しました"])
    app.ask_approval = lambda report, warning, root, profile: recorder.approvals.append((report, warning, root, profile))
    named["run:approve"].clicked()
    assert recorder.started == [prefix + ["show-exposure", "--project-root", str(project)]], recorder.started
    assert recorder.approvals and recorder.approvals[0][1] is None and "承認されなかった" in log_text(app) and app.job is None
    # 承認したら、その指紋だけを --exposure-sha256 で渡す。
    recorder.clear()
    app.ask_approval = lambda report, warning, root, profile: gui.grant_from_confirmation(report, root, profile, True)
    named["run:approve"].clicked()
    assert recorder.started[-1] == prefix + ["approve", "--project-root", str(project), "--exposure-sha256", SHA_A], recorder.started
    # 承認済みならダイアログを出さず、指紋も付けない。
    recorder.clear()
    approved = sample_report("approved", SHA_A, root=str(project))
    recorder.respond = lambda arguments: (0, json.dumps(approved), []) if arguments[3] == "show-exposure" else (0, "", [])
    app.ask_approval = unexpected("承認（承認済みなのに）")
    named["run:approve"].clicked()
    assert recorder.started[-1] == prefix + ["approve", "--project-root", str(project)], recorder.started
    # 読めない確認結果は、生の出力をログに出して中止する。
    recorder.clear()
    recorder.respond = lambda arguments: (0, "壊れた出力", [])
    named["run:approve"].clicked()
    assert len(recorder.started) == 1 and "壊れた出力" in log_text(app) and "中止しました" in log_text(app)

    # hub-add: 足場が無くプロジェクト名も空なら中止する。
    recorder.clear()
    named["run:hub-add"].clicked()
    assert recorder.started == [] and "プロジェクト名" in recorder.messages[-1]
    # 足場が無ければ init → show-exposure → 承認 → 端末窓（--no-start と指紋付き）。
    # 自動で入った値（ハブの Tunnel ID と、見つかった Tunnel Client の場所）も、入力欄の値として CLI へ渡る。
    app.entry_buffers["project-name"].set_text("GUI 試験 プロジェクト", -1)
    recorder.clear()
    recorder.respond = lambda arguments: (0, json.dumps(unapproved, ensure_ascii=False), []) if arguments[3] == "show-exposure" else (0, "", ["足場を作りました"])
    app.ask_approval = lambda report, warning, root, profile: (recorder.approvals.append((report, warning, root, profile)), gui.grant_from_confirmation(report, root, profile, True))[1]
    app.which = lambda name: "/fake/bin/gnome-terminal" if name == "gnome-terminal" else None
    named["run:hub-add"].clicked()
    assert recorder.started == [
        prefix + ["init", "--project-root", str(project), "--project-name", "GUI 試験 プロジェクト"],
        prefix + ["show-exposure", "--project-root", str(project)],
    ], recorder.started
    assert recorder.approvals[-1][1] and "ハブ方式では" in recorder.approvals[-1][1], "hub-add の承認にハブの警告が無い"
    command, options = recorder.terminals[-1]
    assert command == ["/fake/bin/gnome-terminal", "--wait", "--", sys.executable, "-u", str(GUI_FILE), "--terminal-helper", "--", "hub-add", "--project-root", str(project),
                       "--project-name", "GUI 試験 プロジェクト", "--tunnel-id", TUNNEL_ID, "--tunnel-client-path", detected_client, "--no-start", "--exposure-sha256", SHA_A], command
    assert gui.helper_argument_problem(help_data, command[command.index("hub-add"):]) is None, "自動で入った値を含む引数を、端末窓のヘルパーが受け付けない"
    assert options.get("stdin") == subprocess.DEVNULL and options.get("start_new_session") is True and options.get("cwd") == os.environ["HOME"], options
    assert set(options["env"]) - set(os.environ) <= {"PYTHONIOENCODING"} and not any("sk-test" in value for value in options["env"].values())
    assert gui.TERMINAL_OPENED_MESSAGE in log_text(app) and app.job is None
    # 端末が無ければ、コピーできるコマンドを案内する（端末は起動しない）。
    recorder.clear()
    app.which = lambda name: None
    named["run:save-key"].clicked()
    assert not recorder.terminals and recorder.copyable and "端末を開いて貼り付けて実行してください" in recorder.copyable[-1][0]
    assert recorder.copyable[-1][1] == shlex.join(prefix + ["save-key", "--project-root", str(project)])

    # hub-start: 登録ごとに確認 → 承認したものだけ approve → --service で起動。停止は hub-stop。
    reports = {
        str(projects["Alpha"]): (0, json.dumps(sample_report("unapproved", None, root=str(projects["Alpha"]))), []),
        str(projects["Beta"]): (0, json.dumps(sample_report("changed", SHA_B, ["allowFiles: [] -> [\"README.md\"]"], root=str(projects["Beta"]))), []),
        str(projects["Gamma"]): (1, "", ["ERROR: 模擬の失敗"]),
    }  # 登録プロジェクトごとの show-exposure の結果。

    # 子プロセスの結果を、Action とプロジェクトで決める。
    def hub_respond(arguments):
        action = arguments[3]
        if action == "show-exposure":
            return reports[arguments[arguments.index("--project-root") + 1]]
        if action in ("hub-start", "hub-restart", "start"):
            return None
        return (0, "", [f"{action} の模擬出力"])

    fake_client = "/opt/試験 用/tunnel-client"  # 共有欄に入れる Tunnel Client の場所（実在しなくてよい）。
    app.entry_buffers["tunnel-client-path"].set_text(fake_client, -1)
    hub_start_arguments = prefix + ["hub-start", "--tunnel-client-path", fake_client, "--service"]  # 期待する起動の引数配列。
    hub_stop_arguments = prefix + ["hub-stop", "--tunnel-client-path", fake_client]  # 期待する停止の引数配列。
    recorder.clear()
    recorder.respond = hub_respond
    decisions = {str(projects["Alpha"]): True, str(projects["Beta"]): False}  # 承認ダイアログでの模擬の操作。
    app.ask_approval = lambda report, warning, root, profile: (recorder.approvals.append((report, warning, root, profile)), gui.grant_from_confirmation(report, root, profile, decisions[root]))[1]
    named["run:hub-start"].clicked()
    assert recorder.started == [
        prefix + ["show-exposure", "--project-root", str(projects["Alpha"]), "--profile", "chatgpt-alpha-11111111"],
        prefix + ["approve", "--project-root", str(projects["Alpha"]), "--profile", "chatgpt-alpha-11111111", "--exposure-sha256", SHA_A],
        prefix + ["show-exposure", "--project-root", str(projects["Beta"]), "--profile", "chatgpt-beta-22222222"],
        prefix + ["show-exposure", "--project-root", str(projects["Gamma"]), "--profile", "chatgpt-gamma-33333333"],
        hub_start_arguments,
    ], recorder.started
    assert all(warning and "ハブ方式では" in warning for _report, warning, _root, _profile in recorder.approvals)
    text = log_text(app)
    assert "Beta は承認されなかったため、公開されません" in text and "Delta" in text and "承認状態を確かめられません" in text, text[-800:]

    # 起動中は、読み取り専用の補助（status・hub-status・hub-list・hub-permissions）だけ押せる。停止ボタンは使える。
    assert app.job is not None and app.job.final_started
    enabled = {action for action, card in app.cards.items() if card.run_button.get_sensitive()}  # 押せる実行ボタン。
    assert enabled == {"status", "hub-status", "hub-list", "hub-permissions"}, f"起動中に押せる実行ボタンが違う: {sorted(enabled)}"
    assert named["stop:hub-start"].get_visible() and named["stop:hub-start"].get_sensitive() and not named["stop:start"].get_visible()
    assert named["hub-permission-check"].get_sensitive(), "起動中（終わらない操作が最後の段階）に「権限を確認」が押せない"
    assert not named["hub-permission-toggle-source-read"].get_sensitive() and not named["hub-permission-toggle-claude-code"].get_sensitive(), "起動中に権限の切り替えボタンが押せる"
    for action in ("hub-add", "hub-stop", "init", "approve"):
        app.on_run_clicked(None, action)
        assert recorder.started[-1] == hub_start_arguments, f"起動中に {action} が始まった"
    # 補助の hub-status は本体と並行して動き、コマンド・出力・終了コードの行に [hub-status] が付く。
    named["run:hub-status"].clicked()
    assert recorder.started[-1] == prefix + ["hub-status"] and app.aux_job is None and app.job is not None
    lines = log_text(app).splitlines()
    for expected in ("[hub-status] $ " + shlex.join(prefix + ["hub-status"]), "[hub-status] hub-status の模擬出力", "[hub-status] 終了コード 0", f"[hub-status] {gui.SUCCESS_MESSAGE}"):
        assert expected in lines, f"補助の出力の行が無い: {expected}"
    # 補助は同時に 1 つまで。hub-list が動いている間は、ほかの補助も押せない。
    recorder.respond = lambda arguments: None if arguments[3] == "hub-list" else hub_respond(arguments)
    named["run:hub-list"].clicked()
    assert app.aux_job is not None and app.aux_job.action == "hub-list"
    enabled = {action for action, card in app.cards.items() if card.run_button.get_sensitive()}
    assert enabled == set(), f"補助の実行中に押せる実行ボタンがある: {sorted(enabled)}"
    app.on_run_clicked(None, "hub-status")
    assert recorder.started[-1] == prefix + ["hub-list"], "補助が 2 つ同時に始まった"
    # 閉じるときの確認は本体と補助の両方を数え、閉じるなら両方に SIGTERM を送る。
    closing = []  # 閉じる確認の本文。
    app.ask_close = lambda message: closing.append(message) or False
    assert app.on_delete_event() is True and app.job is not None and app.aux_job is not None and recorder.signals == []
    assert closing[-1].startswith(gui.CLOSE_FOREGROUND_MESSAGE) and "2 件" in closing[-1] and "「ハブを起動」" in closing[-1] and "「登録一覧を表示」" in closing[-1], closing[-1]
    app.ask_close = lambda message: closing.append(message) or True
    assert app.on_delete_event() is False
    assert recorder.signals == [signal.SIGTERM, signal.SIGTERM] and app.job is None and app.aux_job is None, recorder.signals
    assert "[hub-list] 終了コード -15（シグナル 15 で終了）" in log_text(app).splitlines()

    # 停止ボタン: 「ハブを停止」のカードと同じ hub-stop を呼び、残った起動の処理には SIGTERM を送る。
    recorder.clear()
    recorder.respond = hub_respond
    named["run:hub-start"].clicked()
    assert recorder.started[-1] == hub_start_arguments
    named["stop:hub-start"].clicked()
    card_stop = gui.build_cli_arguments(help_data, "hub-stop", app.collect_values("hub-stop"), set(), cli_options)  # カードが組む hub-stop。
    assert recorder.started[-1] == hub_stop_arguments == card_stop, recorder.started[-1]
    assert recorder.signals == [signal.SIGTERM] and app.job is None and not named["stop:hub-start"].get_visible()
    assert "停止ボタンによる終了です" in log_text(app) and named["run:hub-list"].get_sensitive()
    named["run:hub-stop"].clicked()
    assert recorder.started[-1] == hub_stop_arguments, "「ハブを停止」のカードと停止ボタンの引数配列が違う"
    # 利用者が入れた Tunnel Client の場所は、操作のたびの読み直しでも書き換わっていない。空に戻すと、次の読み直しで、見つかった場所が入り直す。
    assert app.entry_buffers["tunnel-client-path"].get_text() == fake_client and named["option-input:hub-add:tunnel-id"].get_text() == TUNNEL_ID
    app.entry_buffers["tunnel-client-path"].set_text("", -1)
    app.refresh_hub_list()
    assert app.entry_buffers["tunnel-client-path"].get_text() == detected_client, "空に戻した Tunnel Client の場所が入り直さない"
    # hub.json は読んだだけで、書き換えていない。
    assert hub_file.read_bytes() == hub_before, "画面が hub.json を書き換えた"

    # 従来方式の start: 停止は SIGTERM（プロセスグループ）。起動中も「稼働状態を表示」は押せる。閉じるときは確認する。
    # 従来方式の Tunnel ID 欄は空のまま（ハブの Tunnel ID を入れない）。Tunnel Client の場所は、自動で入った値が渡る。
    assert [named[f"option-input:{action}:tunnel-id"].get_text() for action in ("add-project", "configure-tunnel")] == ["", ""], "操作のあと、従来方式の Tunnel ID 欄に値が入った"
    recorder.clear()
    recorder.respond = lambda arguments: (0, json.dumps(approved), []) if arguments[3] == "show-exposure" else (None if arguments[3] == "start" else (0, "", ["模擬の状態"]))
    named["run:start"].clicked()
    assert recorder.started[-1] == prefix + ["start", "--project-root", str(project), "--tunnel-client-path", detected_client] and app.job is not None
    assert named["run:status"].get_sensitive() and not named["run:test"].get_sensitive()
    named["run:status"].clicked()
    assert recorder.started[-1] == prefix + ["status", "--project-root", str(project)] and "[status] 模擬の状態" in log_text(app).splitlines()
    app.ask_close = lambda message: closing.append(message) or False
    assert app.on_delete_event() is True and closing[-1].startswith(gui.CLOSE_FOREGROUND_MESSAGE) and "1 件" in closing[-1] and app.job is not None
    named["stop:start"].clicked()
    assert recorder.signals == [signal.SIGTERM] and app.job is None
    named["run:start"].clicked()
    app.ask_close = lambda message: closing.append(message) or True
    assert app.on_delete_event() is False and recorder.signals[-1] == signal.SIGTERM and app.job is None
    app.ask_close = unexpected("閉じる確認")
    notes.append("流れ（スタブ）: 必須欄・承認の 3 状態・壊れた出力・init → 承認 → 端末窓・端末なし・hub-start の承認と停止・start の停止・閉じる確認")
    notes.append("並行（スタブ）: 起動中に押せるのは status・hub-status・hub-list だけ・補助の行に [Action 名]・補助は 1 つまで・閉じる確認は 2 件を数えて両方に SIGTERM")

    # タブごとの PNG（実寸）と、全体が入る縦長の PNG を保存する（どれにも、上端に稼働表示の帯が写る）。
    saved = [running_png]  # 保存した画像（先頭は、帯が「実行中」のときの画像）。
    for index, group in enumerate(EXPECTED_GROUPS, start=1):
        app.notebook.set_current_page(index - 1)
        path = screenshot_directory / f"{index:02d}-{group}.png"
        save_png(gtk, offscreen, path)
        saved.append(path)
    offscreen.set_size_request(1100, 2600)
    app.root_widget.set_position(2250)
    for index, group in enumerate(EXPECTED_GROUPS, start=1):
        app.notebook.set_current_page(index - 1)
        path = screenshot_directory / f"{index:02d}-{group}-full.png"
        save_png(gtk, offscreen, path)
        saved.append(path)

    # 承認ダイアログの中身（OffscreenWindow に入れて描画する。ダイアログは開かない）。指紋・要約・3 状態の詳しい確かめは 6b で行う。
    # （仕様変更: 本文は「固定の見出し・スクロールする詳細・固定の要約」に分かれ、指紋は要約の欄に出す。D-1〜D-5）
    panel, panel_window, responses = show_panel(gtk, gui, sample_report("changed", SHA_B, ["allowFiles: [] -> [\"README.md\"]"]), gui.hub_warning_text(help_data))
    assert panel.scrolled.get_policy()[0] == gtk.PolicyType.NEVER, "承認ダイアログの詳細に横スクロールがある"
    shown, rows = label_fully_visible(gtk, panel.sha_label, panel_window)
    assert shown and rows == 1, f"既定の幅で指紋の 64 桁が 1 行に全部見えない（行数 {rows}）"
    panel_widgets = walk_widgets(gtk, panel.box, [], set())
    lacking = [widget.get_name() for widget in panel_widgets if (isinstance(widget, operable) or (isinstance(widget, gtk.Label) and widget.get_name().startswith("approval-"))) and not (widget.get_tooltip_markup() or "").strip()]  # 説明の無い部品。
    assert not lacking, f"承認ダイアログに説明の無い部品がある: {lacking}"
    assert not panel.approve_button.get_sensitive(), "チェック前に承認ボタンが押せる"
    path = screenshot_directory / "05-approval-dialog.png"
    save_png(gtk, panel_window, path)
    saved.append(path)
    scroll_details_to_end(gtk, panel)
    panel.check.set_active(True)
    assert panel.approve_button.get_sensitive()
    panel.approve_button.clicked()
    panel.cancel_button.clicked()
    assert responses == [gtk.ResponseType.ACCEPT, gtk.ResponseType.CANCEL]
    panel_text = app.text_of(panel.details)
    assert "前回の承認から変わった項目" in panel_text and "ハブ方式では" not in panel_text, "詳細に差分が無いか、警告が重複している"
    assert '  1. 公開ファイル（allowFiles）: [] → ["README.md"]' in panel_text, "差分の行の項目名が日本語になっていない"
    warning_label = by_name(panel_widgets).get("approval-hub-warning")
    assert warning_label is not None and "ハブ方式では、このアプリを使うどのチャットからも、承認済みの全プロジェクトを読めます" in warning_label.get_text(), "承認ダイアログにハブの警告が無い"
    plain_panel = gui.ApprovalPanel(sample_report("unapproved", None), None, responses.append)
    plain_named = by_name(walk_widgets(gtk, plain_panel.box, [], set()))  # 従来方式の承認パネルの部品。
    assert "approval-hub-warning" not in plain_named, "従来方式の承認にハブの警告が出た"
    assert "このプロジェクトはまだ承認されていません" in plain_named["approval-state"].get_text()

    # 本番のダイアログは、作るだけで表示しない（run も show も呼ばない）。部品の説明と既定のボタンを確かめる。
    built = []  # 作ったダイアログ。
    dangerous = app.build_dangerous_dialog("force-reconfigure")
    built.append(dangerous)
    assert dangerous.get_property("text") == f"「{help_data['options']['force-reconfigure']['label']}」を有効にしますか?"
    assert help_data["options"]["force-reconfigure"]["caution"] in dangerous.get_property("secondary-text")
    assert dangerous.get_default_widget() is dangerous.get_widget_for_response(gtk.ResponseType.CANCEL), "上書き系の確認の既定がキャンセルではない"
    closing_dialog = app.build_close_dialog(gui.CLOSE_FOREGROUND_MESSAGE)
    built.append(closing_dialog)
    assert closing_dialog.get_default_widget() is closing_dialog.get_widget_for_response(gtk.ResponseType.CANCEL), "閉じる確認の既定がキャンセルではない"
    built.append(app.build_message_dialog("お知らせ"))
    built.append(app.build_copyable_command_dialog(gui.terminal_missing_message(prefix + ["save-key", "--project-root", "/tmp/x"]), "コマンド"))
    approval_dialog, approval_panel = app.build_approval_dialog(sample_report("unapproved", None), gui.hub_warning_text(help_data))
    built.append(approval_dialog)
    assert not approval_panel.approve_button.get_sensitive() and approval_dialog.get_title() == "公開範囲の承認"
    chooser_modes = {("init", "project-root"): gtk.FileChooserAction.SELECT_FOLDER, ("export-skill", "output-path"): gtk.FileChooserAction.SAVE,
                     ("export-bundle", "output-path"): gtk.FileChooserAction.SELECT_FOLDER, ("export-bundle", "signing-key"): gtk.FileChooserAction.OPEN,
                     ("update-lock", "gh-path"): gtk.FileChooserAction.OPEN, ("doctor", "tunnel-client-path"): gtk.FileChooserAction.OPEN}  # 選択画面の種類。
    for (action, option), mode in chooser_modes.items():
        chooser = app.build_file_chooser(action, option)
        built.append(chooser)
        assert chooser.get_action() == mode, f"{action} の {option} の選択画面の種類が違う"
    for dialog in built:
        assert not dialog.get_visible(), "試験でダイアログが表示された"
        responses_found = [dialog.get_widget_for_response(response) for response in (gtk.ResponseType.CANCEL, gtk.ResponseType.ACCEPT, gtk.ResponseType.CLOSE)]
        bare = [widget.get_label() for widget in responses_found if widget is not None and not (widget.get_tooltip_markup() or "").strip()]
        if not isinstance(dialog, gtk.FileChooserDialog):
            content = walk_widgets(gtk, dialog.get_content_area(), [], set())
            bare.extend(type(widget).__name__ for widget in content if isinstance(widget, operable) and not (widget.get_tooltip_markup() or "").strip())
        assert not bare, f"ダイアログの部品に説明が無い: {bare}"
        dialog.destroy()
    notes.append(f"ダイアログ {len(built)} 個を、表示せずに作って確かめた（上書き系・閉じる確認・お知らせ・端末なし・承認・ファイル選択 {len(chooser_modes)} 種）")

    # ツールチップの見え方の見本（GTK のツールチップと同じ最大幅 70 文字・折り返しありのラベル）。
    sample_box = gtk.Box(orientation=gtk.Orientation.VERTICAL, spacing=16, margin=12)
    for widget_name in ("run:hub-add", "option-input:hub-add:project-root", "option-check:hub-add:replace-key", "stage:3"):
        sample = gtk.Label(xalign=0.0)
        sample.set_markup(named[widget_name].get_tooltip_markup())
        sample.set_line_wrap(True)
        sample.set_max_width_chars(70)
        sample_box.pack_start(gtk.Label(label=f"[{widget_name}]", xalign=0.0), False, False, 0)
        sample_box.pack_start(sample, False, False, 0)
    sample_window = gtk.OffscreenWindow()
    sample_window.set_size_request(620, -1)  # ツールチップの最大幅（70 文字）に近い幅で描く。
    sample_window.add(sample_box)
    sample_window.show_all()
    path = screenshot_directory / "06-tooltip-samples.png"
    save_png(gtk, sample_window, path)
    saved.append(path)
    for window in (offscreen, panel_window, sample_window):
        window.destroy()
    pump(gtk)
    notes.extend(f"画像: {path}" for path in saved)
    return notes


# ---------------------------------------------------------------------------
# 6b. 承認ダイアログの画面（OffscreenWindow）
# ---------------------------------------------------------------------------


# 正常な内容（詳細が全部収まる）: 最初から「内容を読みました」を選べ、選ぶまで承認ボタンは押せない。要約と指紋が見える。PNG を保存する。
def check_panel_benign(gui, help_data: dict, screenshot_directory: Path) -> list[str]:
    gtk = require_gtk(gui)
    tiny = with_exposure(sample_report("unapproved", None), allowFiles=["README.md"], allowDirectories=[], denyDirectories=[])  # 既定の大きさ（860×700）に収まる短い内容。
    tiny_panel, tiny_window, _responses = show_panel(gtk, gui, tiny)
    tiny_reached = tiny_panel.read_reached and tiny_panel.check.get_sensitive()  # 短い内容で最初から選べるか。
    tiny_window.destroy()
    assert tiny_reached, "既定の大きさに収まる短い内容なのに、最初から「内容を読みました」を選べない"
    report = with_exposure(sample_report("unapproved", None), gitExposure={"paths": True, "commitSubjects": True})
    panel, window, responses = show_panel(gtk, gui, report, gui.hub_warning_text(help_data), size=(860, 960))
    try:
        named = by_name(walk_widgets(gtk, panel.box, [], set()))
        assert panel.scrolled.get_policy() == (gtk.PolicyType.NEVER, gtk.PolicyType.ALWAYS) and not panel.scrolled.get_overlay_scrolling(), "詳細のスクロールバーが常に表示されない"
        assert panel.read_reached and panel.check.get_sensitive(), "内容が全部見えているのに「内容を読みました」を選べない"
        assert not panel.approve_button.get_sensitive(), "「内容を読みました」の前に承認ボタンが押せる"
        assert "approval-blocked" not in named and "approval-override" not in named
        for name in ("approval-summary", "approval-summary-counts", "approval-summary-git", "approval-sha"):
            assert widget_inside(named[name], window), f"{name} が見える範囲に無い"
        shown, rows = label_fully_visible(gtk, panel.sha_label, window)
        assert shown and panel.sha_label.get_text() == SHA_A, f"指紋の 64 桁が全部見えない（行数 {rows}）"
        git_markup = named["approval-summary-git"].get_label()  # Git の行の markup。
        assert git_markup.count(f'foreground="{gui.DANGER_COLOR}"') == 2 and 'weight="bold"' in git_markup, f"公開の Git が太字・赤で強調されない: {git_markup}"
        assert named["approval-summary-counts"].get_text() == "公開ファイル 3 件 / 公開ディレクトリ 2 件（うち配下すべて 1 件） / 拒否ディレクトリ 2 件"
        default_button = panel.box.get_toplevel().get_default_widget()
        assert default_button is None or default_button is not panel.approve_button, "既定のボタンが「この内容で承認」になっている"
        path = screenshot_directory / "07-approval-benign.png"
        save_png(gtk, window, path)
        panel.check.set_active(True)
        assert panel.approve_button.get_sensitive() and panel.approvable()
        panel.approve_button.clicked()
        assert responses == [gtk.ResponseType.ACCEPT]
        narrow, narrow_window, _responses = show_panel(gtk, gui, report, None, size=(420, 700))
        shown, narrow_rows = label_fully_visible(gtk, narrow.sha_label, narrow_window)
        narrow_window.destroy()
        assert shown and narrow_rows >= 2, f"狭い幅で指紋が折り返されず欠ける（行数 {narrow_rows}）"
    finally:
        window.destroy()
    return [f"画像: {path}", "860×700 に収まる短い内容と、860×960 に収まる標準の内容は、最初から「内容を読みました」を選べる",
            f"指紋: 幅 860 で 1 行、幅 420 で {narrow_rows} 行に折り返して全桁が見える。Git の「公開」は赤・太字"]


# 項目 5,000 件: 固定の要約が見える範囲にあり、末尾までスクロールするまで「内容を読みました」を選べない。
def check_panel_long(gui, screenshot_directory: Path) -> list[str]:
    gtk = require_gtk(gui)
    count = 5000  # 項目の数。
    report = with_exposure(sample_report("unapproved", None), allowFiles=[f"docs/file-{index:05d}.md" for index in range(1, count + 1)])
    started = time.monotonic()
    panel, window, _responses = show_panel(gtk, gui, report)
    elapsed = time.monotonic() - started
    try:
        named = by_name(walk_widgets(gtk, panel.box, [], set()))
        for name in ("approval-summary", "approval-summary-counts", "approval-sha", "approval-read", "approval-accept", "approval-cancel"):
            assert widget_inside(named[name], window), f"5,000 件のとき {name} が見える範囲に無い"
        assert label_fully_visible(gtk, panel.sha_label, window)[0], "5,000 件のとき指紋が全部見えない"
        assert f"公開ファイル {count} 件" in named["approval-summary-counts"].get_text()
        assert not panel.read_reached and not panel.check.get_sensitive(), "末尾まで表示する前に「内容を読みました」を選べる"
        panel.check.set_active(True)
        pump(gtk, 5)
        assert not panel.approve_button.get_sensitive(), "末尾まで表示する前に承認ボタンが押せる"
        panel.check.set_active(False)
        adjustment = panel.scrolled.get_vadjustment()
        adjustment.set_value((adjustment.get_upper() - adjustment.get_page_size()) / 2)
        pump(gtk, 5)
        assert not panel.read_reached, "途中までのスクロールで末尾まで読んだことになった"
        path = screenshot_directory / "10-approval-5000.png"
        save_png(gtk, window, path)
        scroll_details_to_end(gtk, panel)
        assert panel.read_reached and panel.check.get_sensitive() and not panel.approve_button.get_sensitive()
        panel.check.set_active(True)
        assert panel.approve_button.get_sensitive()
        details = panel.details.get_buffer()
        text = details.get_text(details.get_start_iter(), details.get_end_iter(), True)
        assert all(f'  {index}. "docs/file-{index:05d}.md"' in text for index in (1, 2500, count)), "詳細に全件が無い"
    finally:
        window.destroy()
    return [f"画像: {path}", f"5,000 件の描画まで {elapsed:.2f} 秒。末尾までのスクロールで「内容を読みました」が有効になる"]


# 禁止文字あり: 承認ボタンは常に押せず（チェックしても）、赤字の理由が見える。
def check_panel_blocked(gui, screenshot_directory: Path) -> list[str]:
    gtk = require_gtk(gui)
    fake = "README.md\n\n公開範囲の指紋（SHA-256）:\n  " + SHA_B + "\n" * 60  # 画面を偽装する名前。
    report = with_exposure(sample_report("unapproved", None), allowFiles=["README.md", fake, "evil\u202edm.exe"])
    panel, window, responses = show_panel(gtk, gui, report)
    try:
        named = by_name(walk_widgets(gtk, panel.box, [], set()))
        blocked = named.get("approval-blocked")
        assert blocked is not None and widget_inside(blocked, window), "承認できない理由が見える範囲に無い"
        assert gui.FORBIDDEN_MESSAGE in blocked.get_text() and gui.DANGER_COLOR in blocked.get_label(), "承認できない理由が赤字で出ない"
        assert "\n\n" not in panel.details.get_buffer().get_text(panel.details.get_buffer().get_start_iter(), panel.details.get_buffer().get_end_iter(), True).split("公開ファイル")[1].split("公開ディレクトリ")[0].strip("\n"), "名前の改行が詳細に生のまま出た"
        path = screenshot_directory / "08-approval-blocked.png"
        save_png(gtk, window, path)
        scroll_details_to_end(gtk, panel)
        panel.check.set_active(True)
        pump(gtk, 5)
        assert not panel.check.get_sensitive() and not panel.approve_button.get_sensitive() and not panel.approvable(), "禁止文字があるのに承認ボタンが押せる"
        assert panel.cancel_button.get_sensitive()
        panel.approve_button.clicked()
        assert responses == [], "押せないはずの承認ボタンが応答した"
    finally:
        window.destroy()
    return [f"画像: {path}", f"理由: {blocked.get_text()[:80]}…"]


# 別のフォルダーの承認の上書き: 赤字の警告と、追加のチェックが要る。
def check_panel_override(gui, screenshot_directory: Path) -> list[str]:
    gtk = require_gtk(gui)
    report = {**sample_report("changed", SHA_B, ['projectRoot: "/tmp/別のフォルダー" -> "/tmp/プロジェクト A"']), "approvedProjectRoot": "/tmp/別のフォルダー"}
    panel, window, _responses = show_panel(gtk, gui, report)
    try:
        named = by_name(walk_widgets(gtk, panel.box, [], set()))
        warning = named.get("approval-override-warning")
        assert warning is not None and widget_inside(warning, window) and '"/tmp/別のフォルダー"' in warning.get_text() and gui.DANGER_COLOR in warning.get_label(), "上書きの警告が赤字で出ない"
        assert panel.override_check is not None and named["approval-override"].get_label() == "別のフォルダーの承認を上書きしてよいことを理解しました"
        scroll_details_to_end(gtk, panel)
        panel.check.set_active(True)
        assert not panel.approve_button.get_sensitive(), "上書きの確認なしで承認ボタンが押せる"
        panel.override_check.set_active(True)
        assert panel.approve_button.get_sensitive() and panel.override_acknowledged()
        path = screenshot_directory / "09-approval-override.png"
        save_png(gtk, window, path)
        panel.override_check.set_active(False)
        assert not panel.approve_button.get_sensitive()
    finally:
        window.destroy()
    return [f"画像: {path}"]


# ---------------------------------------------------------------------------
# 6c. 操作の流れの堅牢化（子プロセスはスタブ）
# ---------------------------------------------------------------------------


# 試験用の管理画面を作り、ダイアログをスタブにして OffscreenWindow に入れる。(画面, 記録, 名前の表, ウィンドウ) を返す。
def flow_app(gui, help_data: dict, cli_options: frozenset[str]):
    gtk = require_gtk(gui)
    recorder = Recorder()
    app = gui.BridgeApp(help_data, cli_options, dict(os.environ), child_factory=recorder.factory, which=lambda name: None, terminal_popen=recorder.popen)

    # 想定外のダイアログ呼び出しを失敗にする。
    def unexpected(*_values):
        raise AssertionError("想定外のダイアログ")

    app.confirm_dangerous = unexpected
    app.ask_approval = unexpected
    app.show_message = recorder.messages.append
    app.show_copyable_command = lambda message, command: recorder.copyable.append((message, command))
    app.ask_close = unexpected
    app.call_later = lambda milliseconds, function: function()
    window = gtk.OffscreenWindow()
    window.add(app.root_widget)
    window.show_all()
    pump(gtk)
    return app, recorder, by_name(walk_widgets(gtk, app.root_widget, [], set())), window


# project-root の相対パスと ~ を、実行前に絶対パスへそろえ、実行されるコマンドの表示にも絶対パスを出すこと。
def check_flow_absolute_root(gui, help_data: dict, cli_options: frozenset[str]) -> list[str]:
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    prefix = [sys.executable, "-u", str(CLI_FILE)]  # CLI の呼び出しの先頭。
    try:
        for typed, expected in (("relative/プロジェクト 1", os.path.abspath("relative/プロジェクト 1")), ("~/プロジェクト 2", os.path.join(os.environ["HOME"], "プロジェクト 2")),
                                ("/tmp/a/../b/", "/tmp/b")):
            app.entry_buffers["project-root"].set_text(typed, -1)
            named["run:update"].clicked()
            assert recorder.started[-1] == prefix + ["update", "--project-root", expected], f"{typed} が絶対パスにならない: {recorder.started[-1]}"
            assert expected in app.text_of(app.command_view), "実行されるコマンドの表示が絶対パスではない"
    finally:
        window.destroy()
    return [f"相対・~・.. を含む入力を {os.path.abspath('relative/プロジェクト 1')} などの絶対パスにした"]


# 上書き系のチェックは、実行（成功・失敗とも）が始まるたびにオフへ戻ること。
def check_flow_dangerous_reset(gui, help_data: dict, cli_options: frozenset[str], temporary: Path) -> list[str]:
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    try:
        app.confirm_dangerous = lambda option: True
        app.entry_buffers["project-root"].set_text(str(temporary), -1)
        force = named["option-check:init:force"]
        for code in (1, 0):
            force.set_active(True)
            assert force.get_active()
            recorder.respond = lambda arguments, result=code: (result, "", [f"模擬の終了コード {result}"])
            named["run:init"].clicked()
            assert "--force" in recorder.started[-1], "オンにした上書き系が、その実行に付かない"
            assert not force.get_active(), f"終了コード {code} の実行のあとも上書き系のチェックがオンのまま"
            named["run:init"].clicked()
            assert "--force" not in recorder.started[-1], "上書き系が次の実行に持ち越された"
        assert "この実行にだけ付けます" in log_text(app)
    finally:
        window.destroy()
    return ["成功・失敗のどちらの実行でも、始まった時点で force がオフに戻り、次の実行には付かない"]


# hub.json の approvalFile が所定の場所でない登録は、承認状態を「確かめられません」と出し、確認も承認もしないこと。
def check_flow_hub_approval_file(gui, help_data: dict, cli_options: frozenset[str], temporary: Path) -> list[str]:
    hub_file = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "hub.json"  # 一時 HOME の中の hub.json。
    approvals = hub_file.parent / "approvals"  # 所定の場所（作らない）。
    roots = {name: temporary / f"flow-{name}" for name in ("Good", "Elsewhere")}  # 登録プロジェクトのフォルダー。
    for path in roots.values():
        path.mkdir(exist_ok=True)
    previous = hub_file.read_bytes() if hub_file.exists() else None  # 試験前の hub.json（他の項目の分）。
    hub_file.parent.mkdir(parents=True, exist_ok=True)
    hub_file.write_text(json.dumps({"projects": [
        {"name": "Good", "root": str(roots["Good"]), "approvalFile": str(approvals / "chatgpt-good-11111111.json")},
        {"name": "Elsewhere", "root": str(roots["Elsewhere"]), "approvalFile": str(temporary / "elsewhere" / "approvals" / "chatgpt-else-22222222.json")},
    ]}, ensure_ascii=False), encoding="utf-8")
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    prefix = [sys.executable, "-u", str(CLI_FILE)]  # CLI の呼び出しの先頭。
    try:
        rows = [tuple(row) for row in app.hub_store]  # 登録一覧の行。
        assert rows[1][2].startswith("確かめられません") and rows[0][2] == "所定の場所", rows
        approved = sample_report("approved", SHA_A, root=str(roots["Good"]))
        recorder.respond = lambda arguments: (0, json.dumps(approved, ensure_ascii=False), []) if arguments[3] == "show-exposure" else (None if arguments[3] == "hub-start" else (0, "", []))
        named["run:hub-start"].clicked()
        shown = [arguments for arguments in recorder.started if arguments[3] == "show-exposure"]  # 公開範囲を確認したプロジェクト。
        assert shown == [prefix + ["show-exposure", "--project-root", str(roots["Good"]), "--profile", "chatgpt-good-11111111"]], shown
        assert "承認状態を確かめられません" in log_text(app) and "承認状態を確かめられなかった登録 1 件: Elsewhere" in log_text(app), log_text(app)[-600:]
        assert not any(arguments[3] == "approve" for arguments in recorder.started), "確かめられない登録を承認した"
        app.terminate_children()
    finally:
        window.destroy()
        if previous is None:
            hub_file.unlink()
        else:
            hub_file.write_bytes(previous)
    return [f"一覧の表示: {rows[1][2]}"]


# CLI の出力の NUL・ESC は \xNN で、20,000 文字を超える行は切り詰めて印を付けてログ欄に出すこと。読めない出力は 200 行までにすること。
def check_flow_log_lines(gui, help_data: dict, cli_options: frozenset[str]) -> list[str]:
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    try:
        recorder.respond = lambda arguments: (0, "", ["a\x00b\x1b[31mc\x9b", "y" * 50000, "日本語\tタブ"])
        named["run:hub-list"].clicked()
        text = log_text(app)
        assert "a\\x00b\\x1b[31mc\\x9b" in text and "\x00" not in text and "\x1b" not in text and "\x9b" not in text, "制御文字がログ欄に生のまま出た"
        assert ("y" * 20000 + gui.LOG_TRUNCATED_MARK) in text and "y" * 20001 not in text, "長い行が切り詰められない"
        assert "日本語\tタブ" in text
        app.entry_buffers["project-root"].set_text("/tmp/ログ試験", -1)
        recorder.respond = lambda arguments: (0, "壊れた出力\n" * 1000, [])
        named["run:approve"].clicked()
        text = log_text(app)
        assert "（以下 800 行を省略しました）" in text and text.count("壊れた出力") == 200, "読めない出力を 200 行までにしていない"
    finally:
        window.destroy()
    return ["NUL・ESC・C1 は \\xNN、50,000 文字の行は 20,000 文字と印、読めない出力 1,000 行は 200 行と省略の印"]


# 承認の後処理で例外が起きても、深い入れ子の確認結果でも、操作が終わって実行ボタンが押せる状態に戻ること。
def check_flow_always_finishes(gui, help_data: dict, cli_options: frozenset[str]) -> list[str]:
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    try:
        app.entry_buffers["project-root"].set_text("/tmp/後処理 試験", -1)
        unapproved = sample_report("unapproved", None, root="/tmp/後処理 試験")
        recorder.respond = lambda arguments: (0, json.dumps(unapproved, ensure_ascii=False), [])

        # 承認ダイアログの代わりに、画面の部品の不具合を模した例外を出す。
        def broken_dialog(*_values):
            raise RuntimeError("模擬の不具合")

        app.ask_approval = broken_dialog
        named["run:approve"].clicked()
        assert app.job is None and "内部エラーのため中止しました" in log_text(app), "後処理の例外で操作が終わらない"
        assert all(card.run_button.get_sensitive() for card in app.cards.values()), "後処理の例外のあと、実行ボタンが押せないまま"
        recorder.respond = lambda arguments: (0, "[" * 100000 + "]" * 100000, [])
        named["run:approve"].clicked()
        assert app.job is None and "入れ子が深すぎる" in log_text(app), "深い入れ子の確認結果で操作が終わらない"
        app.which = lambda name: None
        app.terminal_popen = recorder.popen
        recorder.clear()

        # 端末の引数の組み立てで例外が起きても、操作が終わることを確かめる。
        def broken_helper(*_values):
            raise RuntimeError("模擬の不具合（端末）")

        original = gui.helper_arguments  # 元の関数（あとで戻す）。
        app.which = lambda name: "/fake/bin/gnome-terminal" if name == "gnome-terminal" else None
        gui.helper_arguments = broken_helper
        try:
            named["run:save-key"].clicked()
        finally:
            gui.helper_arguments = original
        assert app.job is None and named["run:save-key"].get_sensitive(), "端末の組み立ての例外で操作が終わらない"
        assert "模擬の不具合（端末）" in log_text(app), "端末の組み立ての例外がログに出ない"
    finally:
        window.destroy()
    return ["承認ダイアログの例外・深い入れ子の出力・端末の組み立ての例外のどれでも、操作が終わり実行ボタンが押せる"]


# 選択が無ければ中止し、未確認なら先に権限を確認してから、set-permission（確認）→ 承認ダイアログ（注記あり）→ キャンセルは何もせず、
# 承認すれば指紋付きで書き込み、終了後に権限を確認し直すこと。すでに同じ内容なら承認ダイアログを出さないこと。
def check_flow_permission_toggle(gui, help_data: dict, cli_options: frozenset[str], temporary: Path) -> list[str]:
    hub_file = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "hub.json"  # 一時 HOME の中の hub.json。
    approvals = hub_file.parent / "approvals"  # 所定の場所（作らない）。
    project_root = temporary / "flow-permission"
    project_root.mkdir(exist_ok=True)
    previous = hub_file.read_bytes() if hub_file.exists() else None  # 試験前の hub.json（他の項目の分）。
    hub_file.parent.mkdir(parents=True, exist_ok=True)
    hub_file.write_text(json.dumps({"projects": [
        {"name": "Perm", "root": str(project_root), "approvalFile": str(approvals / "chatgpt-perm-11111111.json")},
    ]}, ensure_ascii=False), encoding="utf-8")
    app, recorder, named, window = flow_app(gui, help_data, cli_options)
    prefix = [sys.executable, "-u", str(CLI_FILE)]  # CLI の呼び出しの先頭。

    # 想定外の承認ダイアログの呼び出しを失敗にする。
    def unexpected_approval(*_values, **_keywords):
        raise AssertionError("想定外の承認ダイアログ")

    try:
        tree = named["hub-list-view"]

        # 選択が無ければ、メッセージを出すだけで何も実行しない。
        named["hub-permission-toggle-source-read"].clicked()
        assert recorder.started == [] and recorder.messages and "一覧で選んでください" in recorder.messages[-1], recorder.messages
        recorder.clear()
        tree.get_selection().select_path(gui.Gtk.TreePath.new_from_indices([0]))

        entry = {"name": "Perm", "root": str(project_root), "profile": "chatgpt-perm-11111111", "approvalState": "approved",
                 "sourceRead": "off", "claudeCode": "unset", "allowedCommandCount": 0, "error": None}  # hub-permissions の模擬の結果。
        permissions_json = json.dumps({"schemaVersion": 1, "projects": [entry]}, ensure_ascii=False)
        toggle_report = sample_report("changed", SHA_A, ["detailExposure: (なし) -> {}"], root=str(project_root), sha256=SHA_B)
        toggle_report["profile"] = "chatgpt-perm-11111111"  # 選んだプロジェクトのプロファイルと一致させる。

        # set-permission（指紋なし）の確認には変更後の公開範囲を、指紋付きには書き込みの成功を、hub-permissions には模擬の結果を返す。
        def respond(arguments):
            action = arguments[3]
            if action == "hub-permissions":
                return (0, permissions_json, [])
            if action == "set-permission" and "--exposure-sha256" not in arguments:
                return (0, json.dumps(toggle_report, ensure_ascii=False), [])
            return (0, "", ["設定を変更し、公開範囲の承認を保存しました"])

        recorder.respond = respond
        notes_recorded = []  # 承認ダイアログに渡された extra_note。
        app.ask_approval = lambda report, warning, root, profile, extra_note=None: notes_recorded.append(extra_note) or None  # まずキャンセル。
        named["hub-permission-toggle-source-read"].clicked()
        expected_confirm = prefix + ["set-permission", "--project-root", str(project_root), "--profile", "chatgpt-perm-11111111", "--source-read", "on"]
        assert recorder.started == [prefix + ["hub-permissions"], expected_confirm], recorder.started
        assert notes_recorded == [gui.PERMISSION_TOGGLE_NOTE], f"権限の切り替えの承認ダイアログに注記が渡っていない: {notes_recorded}"
        assert "承認されなかったため、何も変更しませんでした" in log_text(app) and app.job is None

        # 承認すれば、確認した指紋付きで書き込み、終わったら権限を確認し直す。
        recorder.clear()
        app.ask_approval = lambda report, warning, root, profile, extra_note=None: gui.grant_from_confirmation(report, root, profile, True)
        named["hub-permission-toggle-source-read"].clicked()
        assert recorder.started == [expected_confirm, expected_confirm + ["--exposure-sha256", SHA_B], prefix + ["hub-permissions"]], recorder.started
        assert app.job is None
        hub_rows = [tuple(row) for row in app.hub_store]
        assert hub_rows[0][3] == "Off", f"書き込みのあと、権限を確認し直した結果（模擬は固定で Off）が一覧に出ていない: {hub_rows}"

        # すでに同じ内容（approvalState が approved）なら、承認ダイアログを出さずに「変更はありません」で終える。
        # 権限はすでに確認済み（self.permission_entries に残っている）なので、今度は hub-permissions を呼び直さずに set-permission（確認）だけを呼ぶ。
        recorder.clear()
        already_approved = sample_report("approved", SHA_A, root=str(project_root))
        already_approved["profile"] = "chatgpt-perm-11111111"
        recorder.respond = lambda arguments: (0, json.dumps(already_approved, ensure_ascii=False), [])
        app.ask_approval = unexpected_approval
        named["hub-permission-toggle-claude-code"].clicked()
        assert recorder.started == [prefix + ["set-permission", "--project-root", str(project_root), "--profile", "chatgpt-perm-11111111", "--claude-code", "on"]], recorder.started
        assert "すでに同じ内容です。変更はありません" in log_text(app) and app.job is None
    finally:
        window.destroy()
        if previous is None:
            hub_file.unlink()
        else:
            hub_file.write_bytes(previous)
    return ["選択なしは中止・未確認は自動で権限を確認・承認ダイアログに注記・キャンセルは何もしない・承認は指紋付きで書き込んで再確認・変更なしはダイアログを出さない、を確かめた"]


# ---------------------------------------------------------------------------
# 7. 実 CLI との連携（一時 HOME/XDG）
# ---------------------------------------------------------------------------


# 試験に使う Node.js（18 以上）を、隔離した環境で動くものから選ぶ。
def find_test_node(real_home: Path) -> str | None:
    candidates = []  # 試す順の候補。
    if os.environ.get("BRIDGE_TEST_NODE"):
        candidates.append(os.environ["BRIDGE_TEST_NODE"])
    versions = glob.glob(str(real_home / ".volta" / "tools" / "image" / "node" / "*" / "bin" / "node"))  # Volta が入れた実体（シムではない）。
    candidates.extend(sorted(versions, key=lambda path: [int(part) for part in re.findall(r"\d+", Path(path).parent.parent.name)], reverse=True))
    found = shutil.which("node")
    if found:
        candidates.append(found)
    for candidate in candidates:
        try:
            result = subprocess.run([candidate, "--version"], capture_output=True, text=True, env=dict(os.environ), timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        match = re.fullmatch(r"v(\d+)\.\d+\.\d+\s*", result.stdout)
        if result.returncode == 0 and match and int(match.group(1)) >= 18:
            return candidate
    return None


# 画面の ChildProcess で CLI を実行し、終了を待つ。
def run_child(gui, arguments: list[str], environment: dict, capture: bool) -> tuple[int | None, str, list[str]]:
    lines: list[str] = []  # 1 行ずつ受け取った出力。
    result = {}  # 終了コードと標準出力。
    done = threading.Event()  # 終了の合図。

    # 終了を受け取る。
    def on_exit(code, output):
        result.update(code=code, output=output)
        done.set()

    child = gui.ChildProcess(arguments, gui.child_environment(environment), lines.append, on_exit, capture)
    child.start()
    if not done.wait(600):
        child.terminate(signal.SIGKILL)
        raise AssertionError(f"子プロセスが終わらない: {arguments[3:]}")
    return result["code"], result["output"], lines


# 画面の純粋関数が組んだ引数配列で、init → show-exposure → 承認 → approve → show-exposure を通す。
def check_real_cli(gui, help_data: dict, cli_options: frozenset[str], temporary: Path, real_home: Path) -> list[str]:
    node = find_test_node(real_home)
    if node is None:
        raise SkipTest("Node.js 18 以上が見つかりません（BRIDGE_TEST_NODE で指定できます）")
    environment = dict(os.environ)
    environment["PATH"] = str(Path(node).parent) + os.pathsep + environment.get("PATH", "")
    project = temporary / "cli-project 日本語"  # 試験用のプロジェクト（一時ディレクトリの中）。
    project.mkdir()
    (project / "README.md").write_text("# GUI 試験\n", encoding="utf-8")
    approvals = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "approvals"  # 一時 HOME の承認ディレクトリ。
    values = {"project-root": str(project), "project-name": "GUI 試験"}  # 画面の入力値に相当するもの。

    init_arguments = gui.build_cli_arguments(help_data, "init", values, set(), cli_options)
    code, _output, lines = run_child(gui, init_arguments, environment, False)
    assert code == 0, "init が失敗した: " + " / ".join(lines[-5:])
    assert (project / ".chatgpt-project-bridge.json").is_file()
    assert any("PROJECT_BRIDGE_SELFTEST PASS" in line for line in lines), "init の自己試験の PASS が無い"

    show_arguments = gui.build_show_exposure_arguments(str(project), None)
    code, output, lines = run_child(gui, show_arguments, environment, True)
    assert code == 0, "show-exposure が失敗した: " + " / ".join(lines)
    report, error = gui.parse_exposure_report(output)
    assert report is not None, f"show-exposure の出力を読めない: {error}"
    assert report["approvalState"] == "unapproved" and gui.approval_needed(report)
    assert not approvals.exists(), "show-exposure が承認ディレクトリを作った"
    assert gui.grant_from_confirmation(report, str(project), None, False) is None
    unconfirmed = gui.build_cli_arguments(help_data, "approve", {"project-root": str(project)}, set(), cli_options)
    assert "--exposure-sha256" not in unconfirmed

    # 違う指紋を渡すと、CLI が照合して拒否する（承認は保存されない）。
    wrong = gui.ApprovalGrant(str(project), None, "0" * 64)
    code, _output, lines = run_child(gui, gui.build_cli_arguments(help_data, "approve", {"project-root": str(project)}, set(), cli_options, wrong), environment, False)
    approval_file = approvals / f"{report['profile']}.json"  # 承認ファイル。
    assert code == 1 and any("一致しません" in line for line in lines) and not approval_file.exists(), "違う指紋が拒否されなかった"

    grant = gui.grant_from_confirmation(report, str(project), None, True)
    approve_arguments = gui.build_cli_arguments(help_data, "approve", {"project-root": str(project)}, set(), cli_options, grant)
    assert approve_arguments[-2:] == ["--exposure-sha256", report["exposureSha256"]]
    code, _output, lines = run_child(gui, approve_arguments, environment, False)
    assert code == 0 and any("承認を保存しました" in line for line in lines), " / ".join(lines)
    assert approval_file.is_file() and stat.S_IMODE(approval_file.stat().st_mode) == 0o600

    code, output, _lines = run_child(gui, show_arguments, environment, True)
    after, error = gui.parse_exposure_report(output)
    assert code == 0 and after is not None, f"承認後の show-exposure を読めない: {error}"
    assert after["approvalState"] == "approved" and not gui.approval_needed(after)
    assert gui.grant_from_confirmation(after, str(project), None, True) is None, "承認済みなのに指紋を渡そうとした"
    notes = [f"Node.js: {node}", f"init → show-exposure（unapproved）→ 違う指紋は拒否 → approve → show-exposure（approved）を確かめた（{project}）"]
    if "approvedProjectRoot" not in after:
        notes.append("CLI の show-exposure に approvedProjectRoot が無い（古い CLI）。別のフォルダーの承認の上書きは、実 CLI では確かめていない")
        return notes
    approved_root = after["exposure"]["projectRoot"]  # 承認ファイルに記録されたフォルダー（公開範囲の表記）。
    assert after["approvedProjectRoot"] == approved_root and gui.override_warning_text(after) is None, f"同じフォルダーの承認で上書きの警告が出た: {after.get('approvedProjectRoot')}"
    # 別のフォルダーに同じプロファイル名を設定すると、変更あり・approvedProjectRoot が前のフォルダーになり、上書きの警告が出る（共通仕様 S4・D-7）。
    other = temporary / "cli-other 日本語"  # 同じプロファイル名を使う別のフォルダー。
    other.mkdir()
    code, _output, lines = run_child(gui, gui.build_cli_arguments(help_data, "init", {"project-root": str(other), "project-name": "GUI 試験 別"}, set(), cli_options), environment, False)
    assert code == 0, "別のフォルダーの init が失敗した: " + " / ".join(lines[-5:])
    config_path = other / ".chatgpt-project-bridge.json"  # 試験の準備として、別のフォルダーの設定のプロファイル名だけを書き換える（画面は書かない）。
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["profileName"] = report["profile"]
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    code, output, lines = run_child(gui, gui.build_show_exposure_arguments(str(other), None), environment, True)
    collided, error = gui.parse_exposure_report(output)
    assert code == 0 and collided is not None, f"別のフォルダーの show-exposure を読めない: {error} {' / '.join(lines)}"
    assert collided["approvalState"] == "changed" and collided["approvedProjectRoot"] == approved_root, collided.get("approvedProjectRoot")
    warning = gui.override_warning_text(collided)
    assert warning and gui.quote_for_display(approved_root) in warning, "実 CLI の結果で上書きの警告が出ない"
    assert gui.grant_from_confirmation(collided, str(other), None, True) is None and gui.grant_from_confirmation(collided, str(other), None, True, override_acknowledged=True) is not None
    notes.append(f"実 CLI: 同じプロファイル名の別フォルダーで approvedProjectRoot が前のフォルダーになり、上書きの警告と追加の確認が要る: {warning}")

    # 2.8.0: hub-permissions と set-permission（確認 → 承認 → 書き込み → 再確認。一時 HOME・一時 XDG_CONFIG_HOME の中にだけ書く）。
    hub_file = Path(os.environ["XDG_CONFIG_HOME"]) / "chatgpt-project-bridge" / "hub.json"  # 一時 HOME の中の hub.json。
    hub_previous = hub_file.read_bytes() if hub_file.exists() else None  # 他の項目が残した hub.json（元に戻すため）。
    hub_file.parent.mkdir(parents=True, exist_ok=True)
    hub_file.write_text(json.dumps({"schemaVersion": 1, "projects": [{"name": "GUI試験", "root": str(project), "approvalFile": str(approval_file)}]}, ensure_ascii=False), encoding="utf-8")
    permissions_arguments = gui.build_cli_arguments(help_data, "hub-permissions", {}, set(), cli_options)
    code, output, lines = run_child(gui, permissions_arguments, environment, True)
    assert code == 0, "hub-permissions が失敗した: " + " / ".join(lines)
    permission_projects, permission_error = gui.parse_hub_permissions_report(output)
    assert permission_projects is not None, f"hub-permissions の出力を読めない: {permission_error}"
    assert len(permission_projects) == 1 and permission_projects[0]["error"] is None, permission_projects
    assert permission_projects[0]["approvalState"] == "approved" and permission_projects[0]["sourceRead"] == "off" and permission_projects[0]["claudeCode"] == "unset", permission_projects[0]

    # 指紋なしの set-permission は何も書かず、変更後の公開範囲を返す。
    toggle_values = {"project-root": str(project), "profile": report["profile"], "source-read": "on"}
    toggle_arguments = gui.build_cli_arguments(help_data, "set-permission", toggle_values, set(), cli_options)
    config_path = project / ".chatgpt-project-bridge.json"  # プロジェクトの公開設定。
    config_before = config_path.read_bytes()
    code, toggle_output, lines = run_child(gui, toggle_arguments, environment, True)
    assert code == 0, "set-permission（確認）が失敗した: " + " / ".join(lines)
    toggle_report, toggle_error = gui.parse_exposure_report(toggle_output)
    assert toggle_report is not None, f"set-permission の確認結果を読めない: {toggle_error}"
    assert gui.exposure_report_matches(toggle_report, str(project), report["profile"]), "set-permission の確認結果が渡したプロジェクトと一致しない"
    assert config_path.read_bytes() == config_before, "指紋なしの set-permission が設定ファイルを書いた"
    assert toggle_report["exposure"]["detailExposure"]["sourceText"] is True and toggle_report["exposure"]["gitExposure"]["paths"] is True

    # 承認して書き込む。
    toggle_grant = gui.grant_from_confirmation(toggle_report, str(project), report["profile"], True)
    assert toggle_grant is not None, "set-permission の確認結果を承認できなかった"
    write_arguments = gui.build_cli_arguments(help_data, "set-permission", toggle_values, set(), cli_options, toggle_grant)
    assert write_arguments[-2:] == ["--exposure-sha256", toggle_report["exposureSha256"]]
    code, _output, lines = run_child(gui, write_arguments, environment, False)
    assert code == 0 and any("承認を保存しました" in line for line in lines), " / ".join(lines)
    assert config_path.read_bytes() != config_before, "set-permission が設定ファイルを書き換えなかった"

    code, output, lines = run_child(gui, permissions_arguments, environment, True)
    permission_projects, permission_error = gui.parse_hub_permissions_report(output)
    assert permission_projects is not None, f"hub-permissions の出力を読めない: {permission_error}"
    assert permission_projects[0]["sourceRead"] == "on" and permission_projects[0]["approvalState"] == "approved", permission_projects[0]
    notes.append("実 CLI: hub-permissions（1 件・確認できた）と set-permission（確認 → 承認 → 書き込み → 再確認で sourceRead が on）を確かめた")
    if hub_previous is None:
        hub_file.unlink()
    else:
        hub_file.write_bytes(hub_previous)
    return notes


# プロセスが動いているか（終わってゾンビになったものは動いていないとみなす）を返す。
def process_alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state not in ("Z", "X")


# 停止ボタンと同じ ChildProcess.terminate が、孫プロセス（Tunnel Client の代わり）まで止めることを確かめる。
def check_process_group_stop(gui) -> list[str]:
    script = (
        "import subprocess, sys, time\n"
        "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        "print(grandchild.pid, flush=True)\n"
        "time.sleep(120)\n"
    )  # 孫プロセスを作って眠り続ける代わりの子プロセス（CLI や Tunnel Client は使わない）。
    lines: list[str] = []  # 子プロセスの出力。
    finished = threading.Event()  # 終了の合図。
    result = {}  # 終了コード。

    # 終了を受け取る。
    def on_exit(code, _output):
        result["code"] = code
        finished.set()

    child = gui.ChildProcess([sys.executable, "-c", script], gui.child_environment(os.environ), lines.append, on_exit)
    child.start()
    deadline = time.monotonic() + 30  # 孫の PID を待つ期限。
    while not lines and time.monotonic() < deadline:
        time.sleep(0.05)
    assert lines, "子プロセスが孫の PID を出さない"
    grandchild = int(lines[0])
    assert child.running() and process_alive(grandchild)
    assert os.getpgid(child.process.pid) == child.process.pid and os.getpgid(grandchild) == child.process.pid, "子が自分のプロセスグループで動いていない"
    child.terminate(signal.SIGTERM)
    assert finished.wait(30), "SIGTERM で子が終わらない"
    deadline = time.monotonic() + 10
    while process_alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert result["code"] == -signal.SIGTERM, f"終了コードが SIGTERM ではない: {result['code']}"
    assert not process_alive(grandchild), "孫プロセスが残った"
    child.terminate(signal.SIGTERM)  # 終わったあとに呼んでも何もしない。
    return [f"子（{child.process.pid}）と孫（{grandchild}）が SIGTERM で止まり、終了コード {result['code']} を受け取った"]


# プロセスグループに残っているものを SIGKILL で片付ける（試験の後始末。グループが空なら何もしない）。
def kill_group(group: int) -> None:
    try:
        os.killpg(group, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


# CLI（リーダー）が先に終わっても、プロセスグループに孫が残っている間は terminate() が孫まで止めること。空になったら送らないこと。
def check_leader_exited_group(gui) -> list[str]:
    script = (
        "import subprocess, sys\n"
        "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
        "print(grandchild.pid, flush=True)\n"
    )  # 孫を残してすぐ終わる子（Tunnel Client を残して CLI が終わった状態の代わり）。
    lines: list[str] = []  # 子プロセスの出力。
    finished = threading.Event()  # 子の終了の合図。
    child = gui.ChildProcess([sys.executable, "-c", script], gui.child_environment(os.environ), lines.append, lambda _code, _output: finished.set())
    child.start()
    group = child.process.pid  # 子のプロセスグループ。
    try:
        assert finished.wait(30) and lines, "子が終わらない"
        grandchild = int(lines[0])
        assert process_alive(grandchild) and os.getpgid(grandchild) == group, "孫が子のプロセスグループで動いていない"
        assert child.running(), "リーダーが終わったあと、孫が残っているのに動いていないとみなした"
        assert child.terminate(signal.SIGTERM) is True, "孫が残っているのに SIGTERM を送らなかった"
        deadline = time.monotonic() + 10  # 孫の終了を待つ期限。
        while process_alive(grandchild) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not process_alive(grandchild), "リーダーが終わったあとの孫が止まらない"
        assert child.wait(5) and not child.running(), "プロセスグループが空にならない"
        assert child.terminate(signal.SIGTERM) is False, "空になったプロセスグループへ送ろうとした"
    finally:
        kill_group(group)
    return [f"リーダー終了後の孫（{grandchild}）を terminate() で止め、空になったグループには送らない"]


# 画面の代わりのスクリプトが、SIGHUP・SIGQUIT を受けたら子と孫を止めてから終わること（install_signal_handlers と ChildProcess を使う）。
def check_signal_shutdown(gui, temporary: Path) -> list[str]:
    script = temporary / "signal-stub.py"  # 画面の main() と同じ登録をして、メインループで待つスクリプト。
    script.write_text(
        "import importlib.util, os, sys, time\n"
        "sys.dont_write_bytecode = True\n"
        "spec = importlib.util.spec_from_file_location('gui_for_signal', sys.argv[1])\n"
        "gui = importlib.util.module_from_spec(spec)\n"
        "sys.modules['gui_for_signal'] = gui\n"
        "spec.loader.exec_module(gui)\n"
        "gui.import_gtk()\n"
        "loop = gui.GLib.MainLoop()\n"
        "body = 'import subprocess, sys, time\\ngrandchild = subprocess.Popen([sys.executable, \"-c\", \"import time; time.sleep(120)\"])\\nprint(grandchild.pid, flush=True)\\ntime.sleep(120)\\n'\n"
        "lines = []\n"
        "child = gui.ChildProcess([sys.executable, '-c', body], gui.child_environment(os.environ), lines.append, lambda code, output: None)\n"
        "child.start()\n"
        "deadline = time.monotonic() + 30\n"
        "while not lines and time.monotonic() < deadline:\n"
        "    time.sleep(0.05)\n"
        "print('PIDS', child.process.pid, lines[0], flush=True)\n"
        "gui.install_signal_handlers(lambda: gui.stop_process_groups([child]), loop.quit)\n"
        "print('READY', flush=True)\n"
        "loop.run()\n"
        "print('STOPPED', flush=True)\n",
        encoding="utf-8",
    )
    notes = []  # 補足。
    for number in (signal.SIGHUP, signal.SIGQUIT):
        process = subprocess.Popen([sys.executable, "-I", str(script), str(GUI_FILE)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(os.environ), start_new_session=True)
        group = None  # 子のプロセスグループ（後始末用）。
        try:
            seen: list[str] = []  # スクリプトの出力。
            deadline = time.monotonic() + 60  # 準備の期限。
            while time.monotonic() < deadline:
                line = process.stdout.readline()
                if not line:
                    break
                seen.append(line.strip())
                if line.startswith("PIDS "):
                    group = int(line.split()[1])
                if line.strip() == "READY":
                    break
            assert seen and seen[-1] == "READY", f"準備ができない: {seen} {process.stderr.read() if process.poll() is not None else ''}"
            child_pid, grandchild = (int(item) for item in next(line for line in seen if line.startswith("PIDS ")).split()[1:3])
            assert process_alive(child_pid) and process_alive(grandchild)
            os.kill(process.pid, number)
            stdout, stderr = process.communicate(timeout=30)
            deadline = time.monotonic() + 10
            while (process_alive(child_pid) or process_alive(grandchild)) and time.monotonic() < deadline:
                time.sleep(0.05)
            assert "STOPPED" in stdout, f"{signal.Signals(number).name} でメインループが終わらない: {process.returncode} {stderr[-300:]}"
            assert not process_alive(child_pid) and not process_alive(grandchild), f"{signal.Signals(number).name} のあと子か孫が残った"
            notes.append(f"{signal.Signals(number).name}: 子（{child_pid}）と孫（{grandchild}）を止めてから終了（終了コード {process.returncode}）")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            if group is not None:
                kill_group(group)
    return notes


# まとめて読む標準出力は 4 MiB まで（超えたら中止して失敗）、1 行の出力は上限まで、子の作業ディレクトリは HOME であること。
def check_child_output_limits(gui) -> list[str]:
    results = {}  # 終了コードと出力。
    lines: list[str] = []  # 1 行ずつ受け取った出力。
    done = threading.Event()  # 終了の合図。

    # 終了を受け取る。
    def on_exit(code, output):
        results.update(code=code, output=output)
        done.set()

    big = "import sys\nsys.stdout.buffer.write(b'x' * (5 * 1024 * 1024))\nsys.stdout.flush()\n"  # 5 MiB を出す子。
    child = gui.ChildProcess([sys.executable, "-c", big], gui.child_environment(os.environ), lines.append, on_exit, True)
    child.start()
    try:
        assert done.wait(60), "上限を超えた子が終わらない"
    finally:
        kill_group(child.process.pid)
    assert results["output"] == "" and results["code"] != 0, f"4 MiB を超える標準出力を受け取った（{len(results['output'])} 文字、終了コード {results['code']}）"
    assert any("上限" in line for line in lines), "上限を超えたことが出力されない"
    notes = [f"5 MiB の標準出力: 中止して失敗（終了コード {results['code']}）"]
    lines.clear()
    done.clear()
    long_line = "import sys\nprint('y' * 200000)\nprint('次の行')\nsys.stdout.flush()\n"  # 長い 1 行を出す子。
    child = gui.ChildProcess([sys.executable, "-c", long_line], gui.child_environment(os.environ), lines.append, on_exit)
    child.start()
    assert done.wait(60), "長い行の子が終わらない"
    assert lines[-1] == "次の行" and len(lines) == 2 and len(lines[0]) <= gui.LOG_READ_BYTES, f"長い行を上限で切らない（{[len(line) for line in lines]}）"
    notes.append(f"200,000 文字の行: 先頭 {len(lines[0])} 文字だけを渡し、残りは読み捨てて次の行へ進む")
    lines.clear()
    done.clear()
    child = gui.ChildProcess([sys.executable, "-c", "import os; print(os.getcwd())"], gui.child_environment(os.environ), lines.append, on_exit)
    child.start()
    assert done.wait(60) and lines == [os.environ["HOME"]], f"子の作業ディレクトリが HOME ではない: {lines}"
    notes.append(f"子の作業ディレクトリ: {lines[0]}（HOME）")
    return notes


# ---------------------------------------------------------------------------
# 8. 禁止事項の静的検査
# ---------------------------------------------------------------------------


# 画面のソースに、禁止した書き方や語が無いことを数える。
def check_static() -> list[str]:
    source = GUI_FILE.read_text(encoding="utf-8")
    forbidden = {
        "shell=True": r"shell\s*=\s*True",
        "os.system": r"os\.system",
        "--verified": r"--verified",
        "getpass": r"getpass",
        "CONTROL_PLANE_API_KEY": r"CONTROL_PLANE_API_KEY",
        ".key（キーファイル）": r"\.key\b",
        "write_text": r"\.write_text\(",
        "write_bytes": r"\.write_bytes\(",
        "open(…, 書き込み)": r"\bopen\([^)]*,\s*(mode\s*=\s*)?['\"][wax+]",
        "json.dump（ファイルへ）": r"json\.dump\(",
        "os のファイル操作": r"os\.(replace|rename|remove|unlink|mkdir|makedirs|chmod|chown|symlink|link)\(",
        "shutil の書き込み": r"shutil\.(copy|copyfile|copy2|copytree|move|rmtree)\(",
        "Path の書き込み": r"\.(mkdir|unlink|touch|rename|rmdir|symlink_to|hardlink_to|chmod)\(",
        "set_tooltip_text": r"set_tooltip_text\(",
        "文字列の Popen": r"Popen\(\s*[rbf]?['\"]",
        "文字列の subprocess.run": r"subprocess\.run\(\s*[rbf]?['\"]",
    }  # 名前から、数える正規表現への対応。
    found = {name: len(re.findall(pattern, source)) for name, pattern in forbidden.items()}
    assert not any(found.values()), f"禁止事項の出現: { {name: count for name, count in found.items() if count} }"
    top_level_gi = re.findall(r"^(import gi|from gi)", source, re.MULTILINE)
    assert not top_level_gi, "モジュールの先頭で PyGObject を読み込んでいる"
    assert len(re.findall(r'"--exposure-sha256"', source)) == 2, "指紋を付ける箇所が、2 つの組み立て関数以外にもある"
    assert 'title="ChatGPT Project Bridge 管理画面"' in source, "ウィンドウタイトルが違う"
    return [f"検査した語・書き方（正規表現）: {len(forbidden)} 種類（すべて 0 件）。指紋を付ける箇所は build_cli_arguments と build_approve_arguments の 2 か所だけ"]


FORBIDDEN_MODULES = frozenset({
    "socket", "ssl", "urllib", "http", "webbrowser", "getpass", "pickle", "shelve", "marshal", "ftplib", "smtplib", "telnetlib", "xmlrpc", "requests",
})  # 画面が読み込んではいけないモジュール（通信・ブラウザー・キーの入力・任意のコードを復元する直列化）。
FORBIDDEN_CALL_NAMES = frozenset({"eval", "exec", "compile", "__import__", "breakpoint"})  # 画面が呼んではいけない組み込み関数。
FORBIDDEN_DOTTED = frozenset({"os.system", "os.popen", "os.startfile", "os.fork", "os.forkpty", "json.dump", "os.write", "os.pwrite", "os.truncate", "os.ftruncate"})  # 画面が使ってはいけない関数（名前の参照も含む）。
FORBIDDEN_DOTTED_PREFIXES = ("os.exec", "os.spawn", "os.posix_spawn", "GLib.spawn", "Gio.Subprocess", "Gio.SubprocessLauncher", "Gtk.show_uri", "shutil.copy", "shutil.move", "shutil.rmtree")  # 名前の先頭で禁止する関数。
FORBIDDEN_WRITE_ATTRIBUTES = frozenset({
    "write_text", "write_bytes", "mkdir", "makedirs", "touch", "unlink", "rmdir", "symlink_to", "hardlink_to", "chmod", "chown", "removedirs", "symlink", "link", "rename", "renames",
})  # ファイルやディレクトリを書き換える属性（Path・os のどちらでも）。
FORBIDDEN_OPEN_FLAGS = frozenset({"O_CREAT", "O_WRONLY", "O_RDWR", "O_TRUNC", "O_APPEND", "O_TMPFILE"})  # os.open で書き込みや作成になるフラグ。
STATIC_EXCEPTIONS = {
    "os.open": ("read_hub_file_bytes", "hub.json を O_RDONLY・O_NOFOLLOW・O_NONBLOCK で読むため（書き込み・作成のフラグは上の規則で別に禁止）。"),
    "spec.loader.exec_module": ("load_cli_option_names", "CLI の build_parser() からオプション名を読むために CLI を import する（main() は動かない。__pycache__ も作らない）。"),
    "termios.tcsetattr": ("wait_for_enter", "端末窓のヘルパーの Enter 待ちの間だけ入力を表示しない設定にし、終わったら元に戻すため（ファイルは書かない）。"),
    "signal.signal": ("install_signal_handlers", "GLib.unix_signal_add が扱えない SIGQUIT を受けて、子を止めてから終えるため。"),
}  # 禁止の規則とは別に、実行や状態の変更を伴うため「この関数の中だけ」と決めて許すものと、その理由。


# ast のノードから、ドット区切りの名前（os.system など）を返す。途中に呼び出しなどがあれば、その部分は () にする。
def dotted_name(node) -> str:
    parts: list[str] = []  # 後ろから集めた名前。
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    elif isinstance(node, ast.Call):
        parts.append("()")
    else:
        return ""
    return ".".join(reversed(parts))


# 画面のソースを ast で調べ、禁止した呼び出し・読み込み・属性と、指紋を付ける箇所を確かめる。
def check_static_ast() -> list[str]:
    tree = ast.parse(GUI_FILE.read_text(encoding="utf-8"))
    parents: dict = {}  # ノードから親への対応。
    functions: dict = {}  # ノードから、それを含む関数名への対応。

    # 親と、含まれる関数の名前を記録しながらたどる。
    def visit(node, function: str) -> None:
        for child in ast.iter_child_nodes(node):
            parents[child] = node
            inner = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else function  # 子を含む関数。
            functions[child] = inner
            visit(child, inner)

    visit(tree, "")
    problems: list[str] = []  # 見つかった問題。
    excepted: dict[str, int] = {name: 0 for name in STATIC_EXCEPTIONS}  # 例外として許した使用の数。
    for node in ast.walk(tree):
        where = f"{functions.get(node, '') or '（モジュール）'}:{getattr(node, 'lineno', '?')}"  # 場所の表示。
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in FORBIDDEN_MODULES:
                    problems.append(f"{where} import {alias.name}")
                if alias.name.split(".")[0] == "gi" and functions.get(node, "") == "":
                    problems.append(f"{where} モジュールの先頭で import gi")
        elif isinstance(node, ast.ImportFrom):
            module = (node.module or "").split(".")[0]  # 読み込むモジュール。
            if module in FORBIDDEN_MODULES:
                problems.append(f"{where} from {node.module} import …")
            if module == "os" and any(alias.name in {"system", "popen"} or alias.name.startswith(("exec", "spawn", "posix_spawn")) for alias in node.names):
                problems.append(f"{where} from os import（実行系）")
            if module == "gi" and functions.get(node, "") == "":
                problems.append(f"{where} モジュールの先頭で from gi import …")
        elif isinstance(node, ast.Attribute):
            name = dotted_name(node)  # 参照している名前。
            if name in FORBIDDEN_DOTTED or name.startswith(FORBIDDEN_DOTTED_PREFIXES) or name.split(".")[0] in FORBIDDEN_MODULES:
                problems.append(f"{where} {name}")
            if node.attr.startswith("show_uri") or node.attr in {"Subprocess", "SubprocessLauncher"} or (name.startswith("GLib.") and node.attr.startswith("spawn")):
                problems.append(f"{where} {name}")
            if node.attr in FORBIDDEN_WRITE_ATTRIBUTES and isinstance(parents.get(node), ast.Call) and parents[node].func is node:
                problems.append(f"{where} {name}(…)（書き込み）")
            if node.attr == "PASSWORD" and "InputPurpose" in name:
                problems.append(f"{where} {name}（キーの入力欄）")
        elif isinstance(node, ast.Call):
            name = dotted_name(node.func)  # 呼んでいる関数。
            keywords = {keyword.arg: keyword.value for keyword in node.keywords if keyword.arg}  # 名前付きの引数。
            if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALL_NAMES:
                problems.append(f"{where} {node.func.id}(…)")
            if name.startswith("subprocess.") and "shell" in keywords and not (isinstance(keywords["shell"], ast.Constant) and keywords["shell"].value is False):
                problems.append(f"{where} {name}(shell=…)")
            if name in ("open", "io.open", "codecs.open", "builtins.open"):
                mode = node.args[1] if len(node.args) > 1 else keywords.get("mode")  # 開く形。
                if mode is not None and not (isinstance(mode, ast.Constant) and isinstance(mode.value, str) and not set(mode.value) & set("wax+")):
                    problems.append(f"{where} {name}(…, 書き込み・不明な mode)")
            if name == "os.open":
                flags = {item.attr if isinstance(item, ast.Attribute) else getattr(item, "id", "") for argument in node.args[1:2] for item in ast.walk(argument)}  # 指定したフラグ。
                if flags & FORBIDDEN_OPEN_FLAGS:
                    problems.append(f"{where} os.open（{sorted(flags & FORBIDDEN_OPEN_FLAGS)}）")
            if node.func.__class__ is ast.Attribute and node.func.attr == "set_visibility" and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value is False:
                problems.append(f"{where} set_visibility(False)（キーの入力欄）")
            if isinstance(keywords.get("visibility"), ast.Constant) and keywords["visibility"].value is False:
                problems.append(f"{where} visibility=False（キーの入力欄）")
            for allowed, (function, _reason) in STATIC_EXCEPTIONS.items():
                if name == allowed:
                    if functions.get(node, "") == function:
                        excepted[allowed] += 1
                    else:
                        problems.append(f"{where} {allowed} は {function} の中だけで許す")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "exposure-sha256" in node.value:
            parent = parents.get(node)  # 指紋のオプション名を使っている式。
            function = functions.get(node, "")
            if "--exposure-sha256" in node.value:
                if function not in ("build_cli_arguments", "build_approve_arguments") or node.value != "--exposure-sha256":
                    problems.append(f"{where} 指紋のオプション（--exposure-sha256）を 2 つの組み立て関数以外で書いている")
            if isinstance(parent, (ast.BinOp, ast.JoinedStr, ast.FormattedValue)) or (isinstance(parent, ast.Call) and dotted_name(parent.func).split(".")[-1] in {"option_pair", "format", "join"}):
                problems.append(f"{where} 指紋のオプション名を連結・option_pair で組み立てている")
    builders = [functions.get(node) for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value == "--exposure-sha256"]  # 指紋を付ける関数。
    if sorted(builders) != ["build_approve_arguments", "build_cli_arguments"]:
        problems.append(f"指紋を付ける関数が build_cli_arguments と build_approve_arguments の 2 つ（各 1 か所）ではない: {builders}")
    for allowed, count in excepted.items():
        if count == 0:
            problems.append(f"例外として決めた {allowed} が {STATIC_EXCEPTIONS[allowed][0]} に無い（検査の表を直す）")
    # 稼働表示の繰り返しタイマーは、open_window で始め、ウィンドウの destroy で止める（__init__ や call_later では始めない）。
    timer_users = sorted({functions.get(node, "") for node in ast.walk(tree) if isinstance(node, ast.Attribute) and node.attr == "on_hub_timer"})  # 繰り返しタイマーの処理を参照している関数。
    if timer_users != ["open_window"]:
        problems.append(f"稼働表示の繰り返しタイマー（on_hub_timer）を参照するのが open_window だけではない: {timer_users}")
    starters = sorted({functions.get(node, "") for node in ast.walk(tree) if isinstance(node, ast.Call) and dotted_name(node.func) == "GLib.timeout_add_seconds"})  # 繰り返しタイマーを始めている関数。
    if starters != ["open_window"]:
        problems.append(f"繰り返しタイマー（GLib.timeout_add_seconds）を始めるのが open_window だけではない: {starters}")
    removers = sorted({functions.get(node, "") for node in ast.walk(tree) if isinstance(node, ast.Call) and dotted_name(node.func) == "GLib.source_remove"})  # タイマーを止めている関数。
    if removers != ["stop_hub_timer"]:
        problems.append(f"繰り返しタイマーを止める（GLib.source_remove）のが stop_hub_timer だけではない: {removers}")
    destroy = next((node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "on_window_destroy"), None)  # ウィンドウの destroy の処理。
    if destroy is None or not any(isinstance(node, ast.Attribute) and node.attr == "stop_hub_timer" for node in ast.walk(destroy)):
        problems.append("ウィンドウの destroy（on_window_destroy）が、繰り返しタイマーを止めていない（stop_hub_timer を呼んでいない）")
    opener = next((node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "open_window"), None)  # 本番のウィンドウを作る処理。
    if opener is None or not any(isinstance(node, ast.Attribute) and node.attr == "on_window_destroy" for node in ast.walk(opener)):
        problems.append("open_window が、ウィンドウの destroy に on_window_destroy をつないでいない")
    main = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"), None)  # 起動の入口。
    if main is None or not any(isinstance(node, ast.Call) and dotted_name(node.func) == "install_signal_handlers" for node in ast.walk(main)):
        problems.append("main() が install_signal_handlers（SIGHUP・SIGQUIT を含む）を呼んでいない")
    handlers = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "install_signal_handlers"), None)  # 合図の登録。
    names = {dotted_name(node) for node in ast.walk(handlers)} if handlers is not None else set()  # 登録で参照している名前。
    if not {"signal.SIGHUP", "signal.SIGQUIT", "signal.SIGINT", "signal.SIGTERM"} <= names:
        problems.append("install_signal_handlers が SIGINT・SIGTERM・SIGHUP・SIGQUIT のどれかを扱っていない")
    assert not problems, "ast の検査で見つかった問題: " + " / ".join(problems[:20])
    return [
        f"ast: 禁止モジュール {len(FORBIDDEN_MODULES)} 種・禁止の呼び出し・書き込み系の属性 {len(FORBIDDEN_WRITE_ATTRIBUTES)} 種・open の mode・os.open のフラグ・shell=True・set_visibility(False) は 0 件",
        "ast: 指紋（--exposure-sha256）を付けるのは build_cli_arguments と build_approve_arguments の各 1 か所だけ。連結・option_pair での組み立ては 0 件",
        "ast: 稼働表示の繰り返しタイマーを始めるのは open_window だけ、止めるのは stop_hub_timer だけ（ウィンドウの destroy から呼ぶ）",
        "例外（理由つき・決めた関数の中だけ）: " + "、".join(f"{name}（{function}: {reason}）" for name, (function, reason) in STATIC_EXCEPTIONS.items()),
    ]


# ---------------------------------------------------------------------------
# 実行
# ---------------------------------------------------------------------------


# 全項目を実行し、実機の設定とリポジトリに何も残していないことを確かめる。
def main() -> int:
    parser = argparse.ArgumentParser(description="project-bridge-gui.py の自己試験")
    parser.add_argument("--screenshot-dir", help="画面の PNG の保存先（既定は新しい一時ディレクトリ。確認用に残す）")
    options = parser.parse_args()
    if not sys.platform.startswith("linux"):
        print("gui-selftest は Ubuntu/Linux 専用です。", file=sys.stderr)
        return 2
    real_home = Path(pwd.getpwuid(os.getuid()).pw_dir)  # 実機の HOME（環境変数ではなく利用者情報から取る）。
    original_config_home = os.environ.get("XDG_CONFIG_HOME")  # 試験前の XDG_CONFIG_HOME。
    real_before = real_state_snapshot(real_home, original_config_home)
    artifacts_before = repository_artifacts()
    screenshot_directory = Path(options.screenshot_dir).resolve() if options.screenshot_dir else Path(tempfile.mkdtemp(prefix="project-bridge-gui-screens-"))
    screenshot_directory.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="project-bridge-gui-selftest-"))  # 試験用の一時ディレクトリ（最後に消す）。
    results = Results()
    try:
        isolate_environment(temporary)
        print(f"一時ディレクトリ（最後に削除）: {temporary}", flush=True)
        print(f"画像の保存先（確認用に残す）: {screenshot_directory}", flush=True)
        try:
            gui = load_module("project_bridge_gui_for_selftest", GUI_FILE)
            help_data = gui.load_help_data(HELP_FILE)
            cli_options = gui.load_cli_option_names(CLI_FILE)
        except Exception as error:  # 読み込めなければ、以降の項目は実行できない。
            print(f"FAIL 0. 画面のファイルと説明データの読み込み: {error}", flush=True)
            print("PROJECT_BRIDGE_GUI_SELFTEST FAIL（読み込み）", flush=True)
            return 1

        # import だけでは PyGObject を読み込まないこと（純粋関数を画面なしで使える）。
        def check_lazy_import():
            assert "gi" not in sys.modules, "project-bridge-gui.py の import だけで PyGObject が読み込まれた"
            return ["import 後の sys.modules に gi は無い"]

        results.run("0. import だけでは PyGObject を読まない", check_lazy_import)
        results.run("1. 説明データの網羅", lambda: check_help_data(help_data))
        results.run("2. CLI との突き合わせ", lambda: check_cli_match(gui, help_data))
        results.run("3. 引数配列の組み立て", lambda: check_arguments(gui, help_data, cli_options))
        results.run("4. 承認 JSON の解釈", lambda: check_approval_json(gui, help_data))
        results.run("4b. hub.json の読み取り（書かない・作らない）", lambda: check_hub_reading(gui, temporary))
        results.run("4c-1. 表示用の引用（S2 の試験ベクトル）と禁止文字の判定（S1）", lambda: check_display_quote(gui))
        results.run("4c-2. ログ欄の 1 行（NUL・ESC は \\xNN、長い行は切り詰め）", lambda: check_log_sanitize(gui))
        results.run("4d-1. 攻撃: 改行入りの allowFiles 名（偽の指紋・偽の行・空行 60 行）", lambda: check_attack_newline_name(gui))
        results.run("4d-2. 攻撃: 行区切り・双方向制御・ゼロ幅・ESC・C1・フォルダー名の段落区切り", lambda: check_attack_invisible(gui))
        results.run("4d-3. 攻撃: カンマで複数に見せかけた拒否ディレクトリ 1 項目", lambda: check_attack_comma_item(gui))
        results.run("4d-4. 正常な名前（日本語・絵文字・U+0020・U+3000）は承認できる", lambda: check_benign_names(gui))
        results.run("4d-5. 項目 200 件・5,000 件の要約と全件の詳細", lambda: check_large_exposure(gui))
        results.run("4d-6. 別のフォルダーの承認の上書き（approvedProjectRoot）", lambda: check_override_warning(gui))
        results.run("4d-7. 同形異字（ラテン文字とキリル・ギリシャ文字の混在）の印", lambda: check_mixed_scripts(gui))
        results.run("4d-8. 偽の JSON の深い入れ子", lambda: check_deep_json(gui))
        results.run("4e. hub.json の堅牢化（FIFO・1 MiB 超・深い入れ子・所有者・approvalFile）", lambda: check_hub_hardening(gui, temporary))
        results.run("4f. ハブの稼働の判定（PID ファイル・cmdline・状態の文言）と Tunnel Client の探索・自動入力の条件", lambda: check_hub_state(gui, temporary))
        results.run("4g. 権限の確認・切り替え（hub-permissions の解釈・一致判定・反転・一覧の表示文）", lambda: check_permission_helpers(gui))
        results.run("5. 端末コマンドの組み立て", lambda: check_terminals(gui, help_data, cli_options, temporary))
        results.run("5b. 端末窓ヘルパーと起動時の案内", lambda: check_terminal_helper(temporary))
        results.run("5c. 端末の探索（PATH の空要素・相対要素・x-terminal-emulator の実体）", lambda: check_terminal_search(gui, temporary))
        results.run("5d. 端末窓ヘルパーの引数の制限（--action・未知のオプションなど）", lambda: check_helper_arguments(gui, help_data, temporary))
        results.run("5e. 端末窓ヘルパーの Enter 待ち（先行入力を捨てる・表示しない。pty）", lambda: check_helper_enter_wait(temporary))
        results.run("6. 画面の構造と操作の流れ", lambda: check_screen(gui, help_data, cli_options, temporary, screenshot_directory))
        results.run("6b-1. 承認ダイアログ: 良性（短い内容・要約・指紋・既定のボタン）", lambda: check_panel_benign(gui, help_data, screenshot_directory))
        results.run("6b-2. 承認ダイアログ: 5,000 件（要約が見える・末尾までのスクロール）", lambda: check_panel_long(gui, screenshot_directory))
        results.run("6b-3. 承認ダイアログ: 禁止文字あり（承認ボタンは常に無効）", lambda: check_panel_blocked(gui, screenshot_directory))
        results.run("6b-4. 承認ダイアログ: 別のフォルダーの承認の上書き", lambda: check_panel_override(gui, screenshot_directory))
        results.run("6c-1. 流れ: project-root を絶対パスにそろえる", lambda: check_flow_absolute_root(gui, help_data, cli_options))
        results.run("6c-2. 流れ: 上書き系のチェックは実行のたびにオフへ戻る", lambda: check_flow_dangerous_reset(gui, help_data, cli_options, temporary))
        results.run("6c-3. 流れ: approvalFile が所定の場所でない登録は「確かめられません」", lambda: check_flow_hub_approval_file(gui, help_data, cli_options, temporary))
        results.run("6c-4. 流れ: ログ欄の制御文字と長い行", lambda: check_flow_log_lines(gui, help_data, cli_options))
        results.run("6c-5. 流れ: 後処理の例外でも操作が必ず終わる", lambda: check_flow_always_finishes(gui, help_data, cli_options))
        results.run("6c-6. 流れ: 権限の切り替え（未確認は自動で確認・承認ダイアログの注記・キャンセル・書き込み・変更なし）", lambda: check_flow_permission_toggle(gui, help_data, cli_options, temporary))
        results.run("7. 実 CLI との連携（一時 HOME/XDG）", lambda: check_real_cli(gui, help_data, cli_options, temporary, real_home))
        results.run("7b. 停止（プロセスグループへの SIGTERM）", lambda: check_process_group_stop(gui))
        results.run("7c. 停止（CLI が終わったあとに残った孫）", lambda: check_leader_exited_group(gui))
        results.run("7d. SIGHUP・SIGQUIT で子と孫を止めてから終わる", lambda: check_signal_shutdown(gui, temporary))
        results.run("7e. 子プロセスの出力の上限（4 MiB・長い行）と作業ディレクトリ", lambda: check_child_output_limits(gui))
        results.run("8. 禁止事項の静的検査（正規表現と ast）", lambda: check_static() + check_static_ast())
    finally:
        shutil.rmtree(temporary, ignore_errors=True)

    # 実機の設定が試験の前後で変わっていないこと。
    def check_real_state():
        real_after = real_state_snapshot(real_home, original_config_home)
        changed = [name for name in real_before if real_before[name] != real_after.get(name)]
        assert not changed, f"実機の設定が変わった: {changed}"
        return [f"{name}: {'無いまま' if value == 'absent' else '変化なし'}" for name, value in real_before.items()]

    # リポジトリに試験の残骸が増えていないこと。
    def check_repository():
        added = sorted(repository_artifacts() - artifacts_before)
        assert not added, f"リポジトリに残ったもの: {added}"
        assert not temporary.exists(), "一時ディレクトリが残っている"
        return ["__pycache__・画像・足場・hub.json・キーの増加なし。一時ディレクトリは削除済み"]

    results.run("9. 実機の設定が変わっていない", check_real_state)
    results.run("10. リポジトリと一時ディレクトリの後始末", check_repository)
    if results.failures:
        print(f"PROJECT_BRIDGE_GUI_SELFTEST FAIL（{results.failures} 件）", flush=True)
        return 1
    print("PROJECT_BRIDGE_GUI_SELFTEST PASS", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
