#!/usr/bin/env python3
"""Ubuntu向けChatGPT Project Bridge管理コマンド。"""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import getpass
import gzip
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from pathlib import Path, PurePosixPath


SKILL_ROOT = Path(__file__).resolve().parent.parent  # スキル本体の絶対パス。
SERVER_PATH = SKILL_ROOT / "scripts" / "server.mjs"  # 読み取り専用MCPサーバー。
PERMISSION_HELPER_PATH = SKILL_ROOT / "scripts" / "bridge-permission.mjs"  # set-permission が、権限の切り替えを反映した設定の候補を作るのに使うNode.jsの部品（Windows版と同じ変換）。
SELFTEST_PATH = SKILL_ROOT / "scripts" / "selftest.mjs"  # ローカル自己試験。
LINUX_SECURITY_SELFTEST_PATH = SKILL_ROOT / "scripts" / "linux-security-selftest.mjs"  # Linux固有境界試験。
SECURITY_SELFTEST_PATH = SKILL_ROOT / "scripts" / "security-selftest.mjs"  # 公開境界の防御を一時プロジェクトで試す自己試験。
LOCK_PATH = SKILL_ROOT / "dependencies.lock.json"  # 依存物の版とSHA-256の固定値。
SIGNATURE_NAMESPACE = "chatgpt-project-bridge-bundle"  # Bundle署名に使うssh-keygenの名前空間。
TUNNEL_DOWNLOAD_PREFIX = "https://github.com/openai/tunnel-client/releases/download/"  # 許可するTunnel Client取得元。
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")  # 小文字16進のSHA-256。
PROVENANCE_REPOSITORY = "openai/tunnel-client"  # 来歴証明で要求するリポジトリ。
PROVENANCE_WORKFLOW = "openai/tunnel-client/.github/workflows/release.yml"  # 来歴証明で要求する署名ワークフロー。
PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1"  # 来歴証明で要求する述語の種類。
CONFIG_NAME = ".chatgpt-project-bridge.json"  # プロジェクトごとの公開設定。
CONTEXT_NAME = "CHATGPT_PROJECT_CONTEXT.md"  # 長期概要文書。
STATUS_NAME = "CHATGPT_PROJECT_STATUS.md"  # 現在状態文書。
PROFILE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")  # Tunnel Clientプロファイル名。
TUNNEL_PATTERN = re.compile(r"^tunnel_[0-9a-f]{32}$")  # OpenAI tunnel_id形式。
MANIFEST_PATH = SKILL_ROOT / "distribution.json"  # 全OSの配布対象・mode・versionの唯一の正本。
TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels"  # Tunnel作成画面。
API_KEYS_URL = "https://platform.openai.com/settings/organization/api-keys"  # Runtime API Key作成画面。
PLUGINS_URL = "https://chatgpt.com/plugins"  # ChatGPT App登録画面。
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})  # 設定やパスに使えない文字の一般カテゴリ（共通仕様S1: 制御・書式・行区切り・段落区切り・対にならないサロゲート）。
CONFIG_TEXT_FIELDS = ("projectName", "contextFile", "statusFile", "profileName", "tunnelId")  # 公開設定のうち利用者に表示する1つだけの文字列項目。
EXPOSURE_TEXT_FIELDS = ("projectRoot", "contextFile", "statusFile")  # サーバーが返す公開範囲のうち1つだけの文字列項目。
GIT_SAFE_OPTIONS = ("-c", "core.fsmonitor=false", "--no-optional-locks")  # Gitの呼び出しごとに付ける、fsmonitorの実行と索引のロックを止めるオプション（共通仕様S5）。
GIT_NO_DIFF_PROGRAM_OPTIONS = ("--no-ext-diff", "--no-textconv")  # logなど差分を扱う呼び出しで、外部diffとtextconvの実行を止めるオプション。
GIT_CHECKED_SCOPES = frozenset({"local", "worktree"})  # 実行を伴う設定を検査するgit configのscope。
GIT_UNSAFE_CONFIG_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand|worktree)$",
        r"^(filter|diff|merge)\..+\.(clean|smudge|process|command|textconv|driver|cachetextconv)$",
        r"^diff\.external$",
        r"^(alias|include|includeif|url|credential|protocol|gpg|http|sendemail|uploadpack|receive)\.",
        r"^submodule\..+\.update$",
        r"^remote\..+\.(receivepack|uploadpack|vcs|proxy)$",
    )
)  # .git/config にあればGit情報を収集しない、実行を伴いうる設定のキー（共通仕様S5。3つの実装で同じ一覧）。submodule は実行を伴う update だけを対象にする（例外E2）。
GIT_LFS_SAFE_VALUES = {
    "filter.lfs.clean": frozenset({"git-lfs clean -- %f"}),
    "filter.lfs.smudge": frozenset({"git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"}),
    "filter.lfs.process": frozenset({"git-lfs filter-process", "git-lfs filter-process --skip"}),
}  # Git LFS が書く正規の設定（共通仕様S5の例外E1）。キーと値が大文字小文字を区別して完全に一致するときだけ危険とみなさない。


class BridgeError(RuntimeError):
    """利用者へ簡潔に表示する安全な操作エラー。"""


# 1文字が共通仕様S1の禁止文字（制御・書式・行区切り・段落区切り・対にならないサロゲート）かを返す。
def is_forbidden_character(character: str) -> bool:
    return unicodedata.category(character) in FORBIDDEN_CATEGORIES


# 文字列に共通仕様S1の禁止文字が1つでも含まれるかを返す。
def has_forbidden_character(value: str) -> bool:
    return any(is_forbidden_character(character) for character in value)


# 1文字を \u と小文字16進4桁（BMP外は \U と8桁）の形にする。
def escape_code_point(character: str) -> str:
    code = ord(character)
    return f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}"


# 端末へ出す文字列から禁止文字だけを \uXXXX にする（引用符は付けない）。keep_newline のときは改行（LF）だけ残す（複数行のエラー文用）。
def escape_forbidden(value: str, keep_newline: bool = False) -> str:
    return "".join(
        escape_code_point(character) if is_forbidden_character(character) and not (keep_newline and character == "\n") else character
        for character in value
    )


# 値を画面・端末へ出す形にする（共通仕様S2）。二重引用符で囲み、\ と " を退避し、禁止文字とU+0020以外の空白類を \uXXXX にする。
def quote_for_display(value: object) -> str:
    text = value if isinstance(value, str) else str(value)  # 引用する文字列。
    pieces = ['"']  # 組み立て中の表示文字列。
    for character in text:
        if character == "\\":
            pieces.append("\\\\")
        elif character == '"':
            pieces.append('\\"')
        elif is_forbidden_character(character) or (character != " " and unicodedata.category(character) == "Zs"):
            pieces.append(escape_code_point(character))
        else:
            pieces.append(character)
    pieces.append('"')
    return "".join(pieces)


# json.dumps（ensure_ascii=False）の出力に残る禁止文字を、JSONとして同じ値の \uXXXX（BMP外はサロゲート対）へ置き換える。
# json.dumps は U+0020 未満を必ず退避するので、ここで置き換えるのは DEL 以降の文字だけ（字下げの改行は残る）。
def escape_json_for_terminal(text: str) -> str:
    pieces = []  # 組み立て中のJSON文字列。
    for character in text:
        code = ord(character)
        if code < 0x7F or not is_forbidden_character(character):
            pieces.append(character)
        elif code <= 0xFFFF:
            pieces.append(f"\\u{code:04x}")
        else:
            offset = code - 0x10000  # サロゲート対へ分けるための値。
            pieces.append(f"\\u{0xD800 + (offset >> 10):04x}\\u{0xDC00 + (offset & 0x3FF):04x}")
    return "".join(pieces)


# 値をJSONにして、端末へ制御文字を出さない形で返す。
def dumps_for_terminal(value: object) -> str:
    return escape_json_for_terminal(json.dumps(value, ensure_ascii=False, indent=2))


# 設定・公開範囲のうち利用者に表示する文字列を、(項目名, 値) の組で設定の順に返す。配列は 項目名[番号]（0始まり）で表す。
def displayed_values(source: dict, text_fields: tuple[str, ...]) -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []  # (項目名, 値) の一覧。
    for name in text_fields:
        if isinstance(source.get(name), str):
            values.append((name, source[name]))
    for name in ("allowFiles", "denyDirectories"):
        items = source.get(name)
        if isinstance(items, list):
            values.extend((f"{name}[{index}]", item) for index, item in enumerate(items) if isinstance(item, str))
    rules = source.get("allowDirectories")
    if isinstance(rules, list):
        values.extend((f"allowDirectories[{index}].path", rule["path"]) for index, rule in enumerate(rules) if isinstance(rule, dict) and isinstance(rule.get("path"), str))
    return values


# 表示する値に禁止文字が1つでもあれば、承認の確認へ進まずに止める（サーバー側の拒否に加えた二重の防御）。
def reject_forbidden_values(values: list[tuple[str, str]]) -> None:
    for label, value in values:
        if has_forbidden_character(value):
            raise BridgeError(f"公開範囲の設定に使えない文字が含まれています: {label} = {quote_for_display(value)}")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """loopback health確認が外部URLへリダイレクトされることを防ぐ。"""

    # health endpointからのリダイレクトは接続先にかかわらず拒否する。
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


# CLIのAction表記をWindows版とUbuntu版で共通化する。
def normalize_action(value: str) -> str:
    compact = re.sub(r"[-_]", "", value.strip().lower())
    aliases = {
        "init": "init",
        "configuretunnel": "configure-tunnel",
        "savekey": "save-key",
        "update": "update",
        "test": "test",
        "doctor": "doctor",
        "start": "start",
        "status": "status",
        "addproject": "add-project",
        "approve": "approve",
        "showexposure": "show-exposure",
        "exportskill": "export-skill",
        "exportbundle": "export-bundle",
        "updatelock": "update-lock",
        "hubadd": "hub-add",
        "hubremove": "hub-remove",
        "hublist": "hub-list",
        "hubstart": "hub-start",
        "hubstop": "hub-stop",
        "hubrestart": "hub-restart",
        "hubdoctor": "hub-doctor",
        "hubstatus": "hub-status",
        "hubserviceinstall": "hub-service-install",
        "hubserviceuninstall": "hub-service-uninstall",
        "setpermission": "set-permission",
        "hubpermissions": "hub-permissions",
    }
    if compact not in aliases:
        raise BridgeError(f"未対応のActionです: {value}")
    return aliases[compact]


# 改行・NUL・制御文字・書式文字など（共通仕様S1の禁止文字）を含むパスを、Tunnelのコマンド文字列や表示へ渡さない。
def reject_unsafe_command_path(value: Path | str, label: str) -> None:
    text = str(value)
    if has_forbidden_character(text):
        raise BridgeError(f"{label}に改行・制御文字・書式文字などを含むパスは使用できません: {quote_for_display(text)}")


# 実在するプロジェクトルートをLinuxの大小文字を保持して解決する。
def resolve_project_root(raw: str | None) -> Path:
    if not raw:
        raise BridgeError("--project-root が必要です。")
    reject_unsafe_command_path(raw, "project-root")
    candidate = Path(raw).expanduser()
    if not candidate.exists() or not candidate.is_dir():
        raise BridgeError(f"プロジェクトフォルダーが存在しません: {quote_for_display(str(candidate))}")
    resolved = candidate.resolve(strict=True)
    reject_unsafe_command_path(resolved, "project-root")
    return resolved


# 指定パスがルート配下にあることを大小文字を区別して確認する。
def ensure_inside(root: Path, candidate: Path, label: str) -> Path:
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise BridgeError(f"{label}がプロジェクト外を指しています: {candidate}") from error
    if resolved == root:
        raise BridgeError(f"{label}にプロジェクトルート自体は指定できません。")
    return resolved


# 設定由来の相対ファイルを安全なプロジェクト内パスへ変換する。
def safe_project_file(root: Path, relative: str, label: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise BridgeError(f"{label}が空です。")
    if has_forbidden_character(relative):
        raise BridgeError(f"公開範囲の設定に使えない文字が含まれています: {label} = {quote_for_display(relative)}")
    raw = Path(relative)
    if raw.is_absolute() or "\x00" in relative:
        raise BridgeError(f"{label}はプロジェクト相対パスで指定してください: {relative}")
    lexical = root / raw
    resolved = ensure_inside(root, lexical, label)
    if lexical.is_symlink():
        raise BridgeError(f"{label}にシンボリックリンクは使用できません: {relative}")
    return resolved


# JSONを同一ディレクトリ内の一時ファイルから原子的に置き換える。
def atomic_write_text(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


# bridge設定を読み、設定ファイル自体のsymlinkを拒否する。
def read_config(root: Path) -> dict:
    path = root / CONFIG_NAME
    if path.is_symlink():
        raise BridgeError(f"設定ファイルにシンボリックリンクは使用できません: {path}")
    if not path.exists() or not path.is_file():
        raise BridgeError(f"bridge設定がありません。先に init を実行してください: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:  # ValueError は壊れたJSONと不正なUTF-8（UnicodeDecodeError）の両方。
        raise BridgeError(f"bridge設定を読み取れません: {path}: {error}") from error
    if not isinstance(value, dict):
        raise BridgeError(f"bridge設定のルートはJSON objectである必要があります: {path}")
    return value


# bridge設定を秘密値なしのJSONとして保存する。
def write_config(root: Path, config: dict) -> None:
    path = root / CONFIG_NAME
    if path.is_symlink():
        raise BridgeError(f"設定ファイルにシンボリックリンクは使用できません: {path}")
    atomic_write_text(path, json.dumps(config, ensure_ascii=False, indent=2) + "\n")


# プロジェクト名とLinux実パスから衝突しにくいプロファイル名を作る。
def new_profile_name(project_name: str, root: Path) -> str:
    slug = project_name.lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", slug).strip("-._") or "project"
    slug = slug[:42].rstrip("-") or "project"
    path_hash = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:8]
    return f"chatgpt-{slug}-{path_hash}"


# 明示値、設定値、生成値の順でプロファイル名を決める。
def resolve_profile(config: dict, explicit: str | None, root: Path) -> str:
    profile = explicit or str(config.get("profileName") or "") or new_profile_name(str(config.get("projectName") or root.name), root)
    if not PROFILE_PATTERN.fullmatch(profile):
        raise BridgeError(f"プロファイル名が不正です: {profile}")
    return profile


# 実行ファイルを明示パスまたはPATH・既知場所から探し、絶対パスで返す。
# symlinkは実体まで辿らない。Volta や snap のシムは、呼ばれた名前（argv[0]）で動作を切り替えるため、
# 実体（volta-shim など）を直接実行すると動かない。
def find_executable(explicit: str | None, name: str, candidates: list[Path]) -> str:
    if explicit:
        path = Path(os.path.abspath(Path(explicit).expanduser()))  # symlinkを辿らない絶対パス。
        if not path.is_file() or not os.access(path, os.X_OK):
            raise BridgeError(f"実行可能な{name}が見つかりません: {path}")
        return str(path)
    discovered = shutil.which(name)
    if discovered:
        return os.path.abspath(discovered)
    for candidate in candidates:
        expanded = candidate.expanduser()
        if expanded.is_file() and os.access(expanded, os.X_OK):
            return os.path.abspath(expanded)
    raise BridgeError(f"{name}が見つかりません。インストールマニュアルに従って導入してください。")


# Node.js 18以上を要求し、MCPサーバーに使う絶対パスを返す。
def find_node() -> str:
    executable = find_executable(None, "node", [Path("~/.local/bin/node")])
    result = subprocess.run([executable, "--version"], capture_output=True, text=True, check=False)
    match = re.fullmatch(r"v(\d+)(?:\.\d+){1,2}\s*", result.stdout)
    if result.returncode != 0 or not match or int(match.group(1)) < 18:
        detail = result.stdout.strip() or result.stderr.strip() or "取得不能"  # 版の表示、または失敗時のエラー出力。
        raise BridgeError(f"Node.js 18以上が必要です。実行したパス: {executable}  結果: {detail}")
    return executable


# 公式Tunnel Clientの実行ファイルを解決する。
def find_tunnel_client(explicit: str | None) -> str:
    return find_executable(explicit, "tunnel-client", [Path("~/.local/bin/tunnel-client"), Path("~/bin/tunnel-client")])


# XDG環境変数を絶対パスとして検証する。
def xdg_base(variable: str, fallback: str) -> Path:
    base = Path(os.environ.get(variable, fallback)).expanduser()
    if not base.is_absolute():
        raise BridgeError(f"{variable}は絶対パスで指定してください: {base}")
    return base


# XDG規約に従ったTunnel Clientのプロファイル格納先を返す。
def profile_directory() -> Path:
    return xdg_base("XDG_CONFIG_HOME", "~/.config") / "tunnel-client" / "profiles"


# XDG規約に従ったログ・PID・health URL格納先を返す。
def state_directory() -> Path:
    return xdg_base("XDG_STATE_HOME", "~/.local/state") / "tunnel-client"


# Runtime API Keyを格納するプロジェクト外の専用ディレクトリを返す。
def secret_directory() -> Path:
    return xdg_base("XDG_CONFIG_HOME", "~/.config") / "tunnel-client" / "secrets"


# 秘密ディレクトリの所有者・mode・symlink不使用を保証する。
def ensure_private_directory(path: Path) -> Path:
    expanded = path.expanduser()
    current = Path(expanded.anchor or "/")
    for part in expanded.parts[1:]:
        current /= part
        if current.is_symlink():  # 壊れた（リンク先が無い）シンボリックリンクも拒否する。
            raise BridgeError(f"秘密情報の保存経路にシンボリックリンクは使用できません: {current}")
    expanded.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved = expanded.resolve(strict=True)
    info = resolved.stat()
    if info.st_uid != os.getuid():
        raise BridgeError(f"秘密情報ディレクトリの所有者が現在ユーザーではありません: {resolved}")
    os.chmod(resolved, 0o700)
    return resolved


# Runtime API Keyの保存先を安全に解決する。
def secret_path(profile: str) -> Path:
    if not PROFILE_PATTERN.fullmatch(profile):
        raise BridgeError(f"プロファイル名が不正です: {profile}")
    return ensure_private_directory(secret_directory()) / f"{profile}.key"


# Runtime API Keyを原子的に0600で保存し、明示許可のない上書きとlinkを拒否する。
def save_runtime_key(root: Path, requested_profile: str | None, replace_key: bool = False) -> None:
    config = read_config(root)
    profile = resolve_profile(config, requested_profile, root)
    tunnel_id = str(config.get("tunnelId") or "")
    if not TUNNEL_PATTERN.fullmatch(tunnel_id):
        raise BridgeError("Runtime API Keyを保存する前にconfigure-tunnelを成功させてください。")
    if not assert_existing_profile_binding(root, profile, tunnel_id):
        raise BridgeError("Tunnelプロファイルがありません。Runtime API Keyを保存する前にconfigure-tunnelを実行してください。")
    save_profile_runtime_key(profile, replace_key)


# 指定プロファイル用のRuntime API Keyを非表示入力で受け、0600の専用ファイルへ保存する。既存キーは replace_key のときだけ上書きする。
def save_profile_runtime_key(profile: str, replace_key: bool = False) -> None:
    destination = secret_path(profile)  # キーの保存先。
    if destination.exists() or destination.is_symlink():
        details = destination.lstat()
        if stat.S_ISLNK(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.getuid():
            raise BridgeError(f"既存キーファイルの安全性を確認できません: {destination}")
        if not replace_key:
            raise BridgeError(f"Runtime API Keyは既にあります。置き換える場合だけ --replace-key を指定してください: {destination}")
    value = getpass.getpass("Runtime API Key（入力内容は表示されません）: ")
    try:
        if len(value) < 20:
            raise BridgeError("入力されたキーが短すぎます。Runtime API Keyを確認してください。")
        atomic_write_text(destination, value + "\n", 0o600)
        details = destination.stat()
        if details.st_uid != os.getuid() or stat.S_IMODE(details.st_mode) != 0o600 or details.st_nlink != 1:
            raise BridgeError(f"キーファイルの所有者またはmodeが不正です: {destination}")
        print(f"Runtime API Keyを0600の専用ファイルへ保存しました: {destination}")
        print("このファイルは別PCへコピーせず、移行先で再入力してください。")
    finally:
        value = ""


# Gitを対話なし・fsmonitorなし・ロックなしで実行する（共通仕様S5）。出力はUTF-8として読み、読めないバイトは置き換える。
# Gitが無いときは OSError を投げる。
def run_git(root: Path, arguments: list[str]) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()  # 認証の入力待ちで止まらないようにした環境。
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(["git", *GIT_SAFE_OPTIONS, "-C", str(root), *arguments], capture_output=True, encoding="utf-8", errors="replace", check=False, env=environment)


# git config --list --show-scope -z の出力から、local・worktree の実行を伴いうる設定のキーを1つ返す。無ければNone。
# 出力は「scope NUL キー LF 値 NUL」の並び（値の無いキーは LF 以降が無い）。Git LFS の正規の設定（例外E1）は除く。
def find_unsafe_git_config_key(listing: str) -> str | None:
    tokens = listing.split("\0")  # scope と「キー LF 値」が交互に並ぶ。
    for index in range(0, len(tokens) - 1, 2):
        scope = tokens[index].strip().lower()
        key, separator, value = tokens[index + 1].partition("\n")  # 値の無いキーでは separator が空。
        if scope not in GIT_CHECKED_SCOPES or not any(pattern.search(key) for pattern in GIT_UNSAFE_CONFIG_PATTERNS):
            continue
        if separator and value in GIT_LFS_SAFE_VALUES.get(key, frozenset()):
            continue
        return key
    return None


# プロジェクト自身がGitルートで、.git/config に実行を伴いうる設定が無いときだけGit情報を集めてよい。
# 戻り値は (集めてよいか, 集めない理由)。Gitが無い・Gitリポジトリでない・別のリポジトリの配下のときは、理由を空にする。
def git_collection_allowed(root: Path) -> tuple[bool, str]:
    try:
        top = run_git(root, ["rev-parse", "--show-toplevel"])
        if top.returncode != 0 or not top.stdout.strip() or Path(top.stdout.strip()).resolve(strict=True) != root:
            return False, ""
        listing = run_git(root, ["config", "--list", "--show-scope", "-z"])  # 設定を読むだけで、何も実行しない。
    except OSError:
        return False, ""
    if listing.returncode != 0:
        return False, "Git の情報を取得しません: Git の設定（git config --list --show-scope）を読み取れません。"
    unsafe_key = find_unsafe_git_config_key(listing.stdout)  # 見つかった実行を伴いうる設定。
    if unsafe_key is not None:
        return False, f"Git の情報を取得しません: .git/config に実行を伴いうる設定があります: {escape_forbidden(unsafe_key)}"
    return True, ""


# Gitの読み取り専用コマンドを実行し、失敗したら空文字を返す。git_collection_allowed で許可を得てから呼ぶ。
def git_output(root: Path, arguments: list[str]) -> str:
    try:
        result = run_git(root, arguments)
    except OSError:
        return ""
    return result.stdout.rstrip() if result.returncode == 0 else ""


# bridge設定のgitExposureを読み、キーが無ければ非公開として返す。戻り値は (パス公開, 件名公開)。
def git_exposure_setting(config: dict) -> tuple[bool, bool]:
    exposure = config.get("gitExposure")
    if not isinstance(exposure, dict):
        return False, False
    return exposure.get("paths") is True, exposure.get("commitSubjects") is True


# 状態文書のAUTO Gitブロックだけを現在値で更新する。名前を含む項目はgitExposureに従う。
def update_project_status(root: Path) -> None:
    config = read_config(root)
    status_path = safe_project_file(root, str(config.get("statusFile") or STATUS_NAME), "statusFile")
    if not status_path.is_file():
        raise BridgeError(f"状態文書がありません: {status_path}")
    expose_paths, expose_subjects = git_exposure_setting(config)  # 状態文書へ書く名前の範囲。
    git_allowed, git_skip_reason = git_collection_allowed(root)  # Git情報を集めてよいか。実行を伴う設定があれば「Git情報なし」と同じ扱いにする。
    if git_skip_reason:
        print(f"警告: {git_skip_reason}")

    # 許可されたときだけGitを実行し、許可されなければ空文字を返す。
    def collect(arguments: list[str]) -> str:
        return git_output(root, arguments) if git_allowed else ""

    branch = collect(["rev-parse", "--abbrev-ref", "HEAD"])
    head = collect(["log", "-1", *GIT_NO_DIFF_PROGRAM_OPTIONS, "--format=%h|%H|%ci|%s" if expose_subjects else "--format=%h|%H|%ci"])
    ahead = collect(["rev-list", "--left-right", "--count", "HEAD...origin/main"])
    # --ignore-submodules=dirty: サブモジュールの中で子のgit（検査していない子の .git/config のフィルターなど）を起動しない。
    porcelain = collect(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"]).splitlines()
    recent = collect(["log", "-10", *GIT_NO_DIFF_PROGRAM_OPTIONS, "--format=- %h %ci %s" if expose_subjects else "--format=- %h %ci"]).splitlines()
    submodules = collect(["submodule", "status"]).splitlines() if expose_paths else []  # 公開時だけ収集するサブモジュール一覧。
    counts = {"modified": 0, "added": 0, "deleted": 0, "untracked": 0}
    for line in porcelain:
        code = line[:2]
        if code == "??":
            counts["untracked"] += 1
        elif "D" in code:
            counts["deleted"] += 1
        elif "A" in code:
            counts["added"] += 1
        elif re.search(r"[MRTU]", code):
            counts["modified"] += 1
    now = dt.datetime.now().astimezone()
    offset = now.strftime("%z")
    timestamp = now.strftime("%Y-%m-%d %H:%M:%S") + (f" {offset[:3]}:{offset[3:]}" if offset else "")
    recent_text = "\n".join(recent) if recent else "- Git履歴なし、またはGitリポジトリではありません。"
    if not expose_paths:
        submodule_text = "- 非公開（gitExposure.paths が false）"
    else:
        submodule_text = "\n".join(f"- {line}" for line in submodules) if submodules else "- なし、または取得不能"
    auto_body = f"""## Git自動収集

- 収集日時：{timestamp}
- ブランチ：{branch or 'Git情報なし'}
- HEAD：{head or 'Git情報なし'}
- origin/mainとの差：{ahead or '取得不能'}
- 作業ツリー：変更 {counts['modified']} / 追加 {counts['added']} / 削除 {counts['deleted']} / 未追跡 {counts['untracked']}

### 直近コミット

{recent_text}

### サブモジュール

{submodule_text}"""
    begin = "<!-- AUTO:BEGIN git -->"
    end = "<!-- AUTO:END git -->"
    replacement = f"{begin}\n{auto_body}\n{end}"
    try:
        content = status_path.read_text(encoding="utf-8")
    except (OSError, ValueError) as error:  # ValueError は不正なUTF-8（UnicodeDecodeError）。
        raise BridgeError(f"状態文書を読み取れません: {status_path}: {error}") from error
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)
    updated = pattern.sub(replacement, content) if pattern.search(content) else content.rstrip() + "\n\n" + replacement + "\n"
    atomic_write_text(status_path, updated)
    print(f"状態文書のAUTO Gitブロックを更新しました: {status_path}")


# 既存文書を保持しつつbridge設定と2つのテンプレート文書を作る。
def initialize_project(root: Path, project_name: str | None, force: bool) -> None:
    config_path = root / CONFIG_NAME
    if config_path.exists() and not force:
        raise BridgeError(f"bridge設定は既にあります。置き換える場合だけ --force を指定してください: {config_path}")
    name = project_name.strip() if project_name and project_name.strip() else root.name
    if has_forbidden_character(name):  # 設定・文書を書く前に止め、何も作らない。
        raise BridgeError(f"公開範囲の設定に使えない文字が含まれています: projectName = {quote_for_display(name)}")
    config = {
        "schemaVersion": 1,
        "projectName": name,
        "contextFile": CONTEXT_NAME,
        "statusFile": STATUS_NAME,
        "profileName": new_profile_name(name, root),
        "tunnelId": None,
        "healthPort": None,
        "allowFiles": [CONTEXT_NAME, STATUS_NAME, "README.md"],
        "allowDirectories": [],
        "denyDirectories": [".git", ".codex", ".claude", "node_modules", "Saved", "Prompts", "Documents", "Build", "Builds", "dist", "out", "zzz-Temp"],
        "maxDocumentBytes": 524288,
        "gitExposure": {"paths": False, "commitSubjects": False},
    }
    write_config(root, config)
    today = dt.date.today().isoformat()
    templates = [
        ("CHATGPT_PROJECT_CONTEXT.template.md", CONTEXT_NAME),
        ("CHATGPT_PROJECT_STATUS.template.md", STATUS_NAME),
    ]
    for source_name, target_name in templates:
        target = root / target_name
        if target.is_symlink():
            raise BridgeError(f"{target_name}にシンボリックリンクは使用できません: {target}")
        if target.exists():
            print(f"既存文書を保持しました: {target}")
            continue
        source = SKILL_ROOT / "assets" / source_name
        text = source.read_text(encoding="utf-8").replace("{{PROJECT_NAME}}", name).replace("{{TODAY}}", today)
        atomic_write_text(target, text)
        print(f"文書を作成しました: {target}")
    update_project_status(root)
    print(f"bridge設定を作成しました: {config_path}")
    print("公開範囲を確認してください。既定では概要、状態、ルートREADMEだけです。Gitのファイル名とコミット件名は公開しません。")


# Node.jsでMCP stdio自己試験と公開境界の自己試験を実行する。
def test_project(root: Path) -> None:
    node = find_node()
    subprocess.run([node, str(SELFTEST_PATH), "--project-root", str(root), "--config", str(root / CONFIG_NAME)], check=True)
    subprocess.run([node, str(SECURITY_SELFTEST_PATH)], check=True)
    subprocess.run([node, str(LINUX_SECURITY_SELFTEST_PATH)], check=True)


# 公開範囲の承認ファイルを置くディレクトリの場所だけを返す。作成も権限変更もしない。
def approval_directory() -> Path:
    return xdg_base("XDG_CONFIG_HOME", "~/.config") / "chatgpt-project-bridge" / "approvals"


# プロファイルごとの公開範囲承認ファイルのパスを返す。プロジェクト外の0700ディレクトリに置く。
def approval_path(profile: str) -> Path:
    if not PROFILE_PATTERN.fullmatch(profile):
        raise BridgeError(f"プロファイル名が不正です: {profile}")
    directory = ensure_private_directory(approval_directory())
    return directory / f"{profile}.json"


# 承認ファイルの場所を読み取り専用で返す。ディレクトリを作らず、権限も変えず、無ければNoneを返す。
def find_approval_path(profile: str) -> Path | None:
    if not PROFILE_PATTERN.fullmatch(profile):
        raise BridgeError(f"プロファイル名が不正です: {profile}")
    directory = approval_directory()
    current = Path(directory.anchor or "/")
    for part in directory.parts[1:]:
        current /= part
        if current.is_symlink():
            raise BridgeError(f"公開範囲の承認ディレクトリの経路にシンボリックリンクは使用できません: {current}")
    if not directory.is_dir():
        return None
    details = directory.stat()  # 承認ディレクトリの所有者とmode。
    if details.st_uid != os.getuid():
        raise BridgeError(f"公開範囲の承認ディレクトリの所有者が現在ユーザーではありません: {directory}")
    if details.st_mode & 0o022:
        raise BridgeError(f"公開範囲の承認ディレクトリに、所有者以外の書き込み権があります（chmod 700 で直してください）: {directory}")
    return directory / f"{profile}.json"


# MCPサーバー自身に公開範囲を正規化させ、指紋と内容を返す。表示する値に禁止文字があれば、承認の確認へ進まずに止める。
# candidate_text（2.8.0）を渡すと、実際の設定ファイルではなく、その候補の設定（JSONの文字列。一時ファイルに書く）の公開範囲を求める。実際の設定は書かない。
def get_exposure(root: Path, candidate_text: str | None = None) -> dict:
    config_path = root / CONFIG_NAME
    if config_path.is_symlink():
        raise BridgeError(f"設定ファイルにシンボリックリンクは使用できません: {config_path}")
    candidate = json.loads(candidate_text) if candidate_text is not None else None  # 候補の設定（JSONとして読んだもの）。
    reject_forbidden_values(displayed_values(candidate if candidate is not None else read_config(root), CONFIG_TEXT_FIELDS))
    candidate_directory = tempfile.mkdtemp(prefix="bridge-permission-") if candidate_text is not None else None  # 候補の設定を置く一時フォルダー（0700）。
    try:
        server_config = config_path  # サーバーに読ませる設定。
        if candidate_directory is not None:
            server_config = Path(candidate_directory) / CONFIG_NAME
            server_config.write_text(candidate_text, encoding="utf-8")
        result = subprocess.run([find_node(), str(SERVER_PATH), "--print-exposure", "--project-root", str(root), "--config", str(server_config)], capture_output=True, encoding="utf-8", check=False)
        if result.returncode != 0:
            raise BridgeError(f"公開範囲を取得できません: {result.stderr.strip()}")
        printed = json.loads(result.stdout)
    except ValueError as error:  # 出力が途中で切れた・壊れた・UTF-8でない。
        raise BridgeError(f"公開範囲を取得できません: サーバーの出力をJSONとして読めません: {error}") from error
    finally:
        if candidate_directory is not None:
            shutil.rmtree(candidate_directory, ignore_errors=True)
    if not isinstance(printed, dict) or not SHA256_PATTERN.fullmatch(str(printed.get("sha256") or "")):
        raise BridgeError("公開範囲の指紋が不正です。")
    if not isinstance(printed.get("exposure"), dict):
        raise BridgeError("公開範囲の内容が不正です。")
    reject_forbidden_values(displayed_values(printed["exposure"], EXPOSURE_TEXT_FIELDS))
    return printed


# 承認ファイルを読み、無いか壊れていればNoneを返す。
# リンクを辿らずに開き、通常ファイル・所有者が自分・group/otherに書き込み権が無いことを確かめる。満たさなければ未承認として扱う。
def read_approval(path: Path) -> dict | None:
    if path.is_symlink():
        raise BridgeError(f"公開範囲の承認ファイルにシンボリックリンクは使用できません: {path}")
    if not path.is_file():
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)  # FIFOに差し替えられても開くときに待たない。
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise BridgeError(f"公開範囲の承認ファイルにシンボリックリンクは使用できません: {path}") from error
        return None
    try:
        details = os.fstat(descriptor)  # 開いたファイルそのものの種別・所有者・mode。
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o022:
            return None
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            data = stream.read()
        value = json.loads(data.decode("utf-8"))
    except (OSError, ValueError):  # ValueError は不正なUTF-8（UnicodeDecodeError）と壊れたJSON。
        return None
    finally:
        os.close(descriptor)
    return value if isinstance(value, dict) else None


# 承認ファイルに記録された指紋を返す。小文字16進64桁の文字列でなければNoneを返す。
def recorded_sha256(approval: dict | None) -> str | None:
    value = approval.get("sha256") if approval is not None else None
    return value if isinstance(value, str) and SHA256_PATTERN.fullmatch(value) else None


# 前回承認した公開範囲と今回の公開範囲を比べ、変わった項目を「項目名: 前 -> 後」の1行ずつで返す。
# json.dumps が退避しない禁止文字（U+2028 や書式文字など）は \uXXXX にして、行の形は変えない。
def exposure_change_lines(exposure: dict, previous: dict) -> list[str]:
    lines = []  # 変わった項目の説明。
    names = ["projectRoot", "contextFile", "statusFile", "allowFiles", "allowDirectories", "denyDirectories", "maxDocumentBytes", "gitExposure"]  # 比較対象の項目。
    if "detailExposure" in previous or "detailExposure" in exposure:  # 2.5.0 の詳細取得の公開設定。どちらにも無いときは比較しない（「なし」と「null」の偽の差分を出さない）。
        names.append("detailExposure")
    if "sourceScope" in previous or "sourceScope" in exposure:  # 2.6.0 のソース読み取り範囲を広げる設定。どちらにも無いときは比較しない。
        names.append("sourceScope")
    if "claudeCode" in previous or "claudeCode" in exposure:  # 2.7.0 の Claude Code のジョブ実行を許可する設定。どちらにも無いときは比較しない。
        names.append("claudeCode")
    for name in names:
        before = json.dumps(previous.get(name), ensure_ascii=False, sort_keys=True) if name in previous else "(なし)"
        after = json.dumps(exposure.get(name), ensure_ascii=False, sort_keys=True)
        if before != after:
            lines.append(f"{name}: {escape_forbidden(before)} -> {escape_forbidden(after)}")
    return lines


# 承認ファイルに記録された公開範囲を返す。無い・形が不正ならNoneを返す。
def approved_exposure(approval: dict | None) -> dict | None:
    return approval.get("exposure") if approval is not None and isinstance(approval.get("exposure"), dict) else None


# 承認ファイルに記録されたプロジェクトルートを返す（共通仕様S4）。無い・壊れている・文字列でなければNoneを返す。
def approved_project_root(approval: dict | None) -> str | None:
    previous = approved_exposure(approval)  # 前回承認した公開範囲。
    value = previous.get("projectRoot") if previous is not None else None
    return value if isinstance(value, str) else None


# 公開範囲の値が配列ならその要素を、そうでなければ空の一覧を返す。
def exposure_items(value: object) -> list:
    return value if isinstance(value, list) else []


# 公開範囲の全項目を、承認する前に読む順で表示する。値はすべて引用し、配列は1項目1行で件数とともに省略せず出す。
# 最後の4行は要約と指紋で、承認のプロンプトの直前に来る。other_root は同じプロファイル名で承認された別フォルダー（無ければNone）。
def show_exposure_details(exposure: dict, previous: dict | None, sha256: str, profile: str, other_root: str | None) -> None:
    git = exposure.get("gitExposure") if isinstance(exposure.get("gitExposure"), dict) else {}  # Git情報の公開設定。
    files = exposure_items(exposure.get("allowFiles"))  # 公開ファイル。
    directories = [rule for rule in exposure_items(exposure.get("allowDirectories")) if isinstance(rule, dict)]  # 公開ディレクトリの規則。
    denied = exposure_items(exposure.get("denyDirectories"))  # 拒否ディレクトリ。
    recursive_count = sum(1 for rule in directories if rule.get("recursive") is True)  # 配下すべてを公開するディレクトリの数。
    git_line = f"Git のファイル名: {'公開' if git.get('paths') is True else '非公開'} / Git のコミット件名: {'公開' if git.get('commitSubjects') is True else '非公開'}"  # Git情報の公開設定の1行。
    detail = exposure.get("detailExposure") if isinstance(exposure.get("detailExposure"), dict) else None  # 2.5.0 の詳細取得ツールの公開設定。設定が無ければ None（すべて非公開）。
    detail_line = None if detail is None else f"詳細取得ツール: ブランチ名 {'公開' if detail.get('branchNames') is True else '非公開'} / 差分の抜粋 {'公開' if detail.get('diffExcerpts') is True else '非公開'} / ファイル本文（設定・ソース・記録） {'公開' if detail.get('sourceText') is True else '非公開'}"  # 詳細取得ツールの公開設定の1行。
    scope = exposure.get("sourceScope") if isinstance(exposure.get("sourceScope"), dict) else None  # 2.6.0 のソース読み取り範囲を広げる設定。設定が無ければ None（広げない）。
    scope_additional = exposure_items(scope.get("additionalDirectories")) if scope is not None else []  # 既定除外のうち明示的に開けるディレクトリ。
    scope_logs = [rule for rule in exposure_items(scope.get("logDirectories")) if isinstance(rule, dict)] if scope is not None else []  # read_test_log が読んでよい場所。
    scope_line = None if scope is None else (
        f"ソース読み取り範囲: 追加で開けるディレクトリ {len(scope_additional)} 件"
        + ("（" + "、".join(quote_for_display(item) for item in scope_additional) + "）" if scope_additional else "")
        + f" / ログの読み取り場所 {len(scope_logs)} 件"
        + ("（" + "、".join(f"{quote_for_display(rule.get('path'))}{'（配下すべて）' if rule.get('recursive') is True else '（直下だけ）'}" for rule in scope_logs) + "）" if scope_logs else "")
    )  # 2.6.0 のソース読み取り範囲の公開設定の1行。
    claude_code = exposure.get("claudeCode") if isinstance(exposure.get("claudeCode"), dict) else None  # 2.7.0 のClaude Codeのジョブ実行を許可する設定。設定が無ければNone（無効）。
    claude_commands = exposure_items(claude_code.get("allowedCommands")) if claude_code is not None else []  # 確認なしで実行してよいコマンド。
    claude_enabled = claude_code.get("enabled") is True if claude_code is not None else False  # ChatGPTからClaude Codeのジョブ実行を許可するか。
    claude_line = None if claude_code is None else (
        f"Claude Code のジョブ: {'有効' if claude_enabled else '無効'}"
        + (f" / コマンドの実行（{len(claude_commands)} 件。確認なしで実行できます）: " + "、".join(quote_for_display(item) for item in claude_commands) if claude_commands else " / コマンドの実行: なし（ファイルの編集だけ）")
        + f" / model: {quote_for_display(claude_code.get('model')) if isinstance(claude_code.get('model'), str) else '（指定なし）'}"
        + f" / effort: {quote_for_display(claude_code.get('effort')) if isinstance(claude_code.get('effort'), str) else '（指定なし）'}"
        + f" / 制限時間: {escape_forbidden(str(claude_code.get('maxMinutes')))} 分"
        + f" / 推定コストの上限: {('$' + escape_forbidden(str(claude_code.get('maxBudgetUsd')))) if claude_code.get('maxBudgetUsd') is not None else '（指定なし）'}"
    )  # 2.7.0 のClaude Codeのジョブ実行を許可する設定の1行。
    claude_warning = None if not claude_enabled else (
        "警告: この承認で、ChatGPT から Claude Code を起動し、このプロジェクトの作業ツリーのファイルを書き換えさせ、"
        "次のコマンドを確認なしで実行させられるようになります（git の commit・push はできません。Claude Code の利用枠を消費します）。"
        "許可したコマンドがプロジェクト内のスクリプトを実行する場合、Claude Code はそのスクリプトを書き換えてから実行できるため、実質的に任意のコードを実行できます。"
    )  # claudeCode.enabled が true のときに必ず出す警告（文言は固定）。
    if other_root is not None:
        print("!" * 60)
        print(f"警告: このプロファイル名は別のフォルダー {quote_for_display(other_root)} の承認に使われています。承認すると、そのフォルダーの承認が上書きされます。")
        print("!" * 60)
    print(f"公開範囲の確認（承認状態: {'前回から変更あり' if previous is not None else '未承認'}）")
    print(f"プロジェクトルート: {quote_for_display(exposure.get('projectRoot'))}")
    print(f"プロファイル: {quote_for_display(profile)}")
    if previous is not None:
        changes = exposure_change_lines(exposure, previous)  # 前回の承認から変わった項目。
        print(f"前回の承認から変わった項目（{len(changes)} 件）:")
        for line in changes:
            print(f"  - {line}")
    print(f"公開ファイル（{len(files)} 件）:")
    for number, item in enumerate(files, start=1):
        print(f"  {number}. {quote_for_display(item)}")
    print(f"公開ディレクトリ（{len(directories)} 件）:")
    for number, rule in enumerate(directories, start=1):
        print(f"  {number}. {quote_for_display(rule.get('path'))}{'（配下すべて）' if rule.get('recursive') is True else '（直下だけ）'}")
    print(f"拒否ディレクトリ（{len(denied)} 件）:")
    for number, item in enumerate(denied, start=1):
        print(f"  {number}. {quote_for_display(item)}")
    print(git_line)
    if detail_line is not None:
        print(detail_line)
    if scope_line is not None:
        print(scope_line)
    if claude_line is not None:
        print(claude_line)
    if claude_warning is not None:
        print(claude_warning)
    print(f"文書 1 件の上限: {escape_forbidden(str(exposure.get('maxDocumentBytes')))} バイト")
    print("─── 承認する内容の要約（最終確認） ───")
    print(f"公開ファイル {len(files)} 件 / 公開ディレクトリ {len(directories)} 件（うち配下すべて {recursive_count} 件） / 拒否ディレクトリ {len(denied)} 件")
    print(git_line)
    if detail_line is not None:
        print(detail_line)
    if scope_line is not None:
        print(scope_line)
    if claude_line is not None:
        print(claude_line)
    if claude_warning is not None:
        print(claude_warning)
    print(f"公開範囲の指紋（SHA-256）: {sha256}")


# 公開範囲が承認済みかを確認し、未承認なら内容を表示して承認を求める。承認済みならTrueを返す。
def confirm_exposure(root: Path, profile: str, expected_sha256: str | None, no_prompt: bool = False) -> bool:
    printed = get_exposure(root)
    path = approval_path(profile)
    approval = read_approval(path)
    if recorded_sha256(approval) == printed["sha256"]:
        print(f"公開範囲は承認済みです（指紋 {printed['sha256']}）。")
        return True
    previous = approved_exposure(approval)  # 前回承認した公開範囲。
    recorded_root = approved_project_root(approval)  # 同じプロファイル名で承認されたフォルダー。
    other_root = recorded_root if recorded_root is not None and recorded_root != printed["exposure"].get("projectRoot") else None  # 別フォルダーの承認を上書きするときだけ警告する。
    show_exposure_details(printed["exposure"], previous, printed["sha256"], profile, other_root)
    if no_prompt:
        return False
    if expected_sha256:
        if expected_sha256.strip().lower() != printed["sha256"]:
            raise BridgeError("--exposure-sha256 が現在の公開範囲の指紋と一致しません。表示された内容を確認してください。")
    else:
        answer = input("この公開範囲をChatGPTへ公開することを承認しますか? [yes/NO]: ").strip().lower()
        if answer not in {"yes", "y"}:
            raise BridgeError("公開範囲が承認されなかったため中止しました。")
    record = {"schemaVersion": 1, "sha256": printed["sha256"], "approvedAt": dt.datetime.now().astimezone().isoformat(), "exposure": printed["exposure"]}  # 保存する承認内容。
    atomic_write_text(path, json.dumps(record, ensure_ascii=False, indent=2) + "\n", 0o600)
    print(f"公開範囲の承認を保存しました: {path}")
    return True


# 公開範囲の指紋・承認状態・前回承認との差分を、何も書き込まずに集めて返す。
# candidate_text（2.8.0）を渡すと、設定をその候補（JSONの文字列）に変えた場合の公開範囲として集める（承認状態は、いまの承認ファイルと比べる）。
def collect_exposure_report(root: Path, profile: str, candidate_text: str | None = None) -> dict:
    printed = get_exposure(root, candidate_text)
    path = find_approval_path(profile)  # 承認ディレクトリが無ければNone。
    approval = read_approval(path) if path is not None else None
    state = "unapproved"  # 承認ファイルが無い、または壊れている。
    approved_sha256 = recorded_sha256(approval)  # 承認済みの指紋。
    changes: list[str] = []  # 承認済みの前回との差分。
    if approval is not None:
        if approved_sha256 == printed["sha256"]:
            state = "approved"
        else:
            state = "changed"
            previous = approved_exposure(approval)  # 前回承認した公開範囲。
            changes = exposure_change_lines(printed["exposure"], previous) if previous is not None else []
    return {
        "schemaVersion": 1,
        "projectRoot": str(root),
        "profile": profile,
        "exposureSha256": printed["sha256"],
        "approvalState": state,
        "approvedSha256": approved_sha256,
        "approvedProjectRoot": approved_project_root(approval),  # 承認ファイルに記録されたフォルダー（共通仕様S4）。別のフォルダーなら、承認すると上書きになる。
        "exposure": printed["exposure"],
        "changes": changes,
    }


# 公開範囲の確認結果をJSON 1つだけ標準出力へ出す。承認ファイル・設定・ログのどれにも書き込まない。
def show_exposure(root: Path, requested_profile: str | None) -> None:
    config = read_config(root)
    profile = resolve_profile(config, requested_profile, root)
    print(dumps_for_terminal(collect_exposure_report(root, profile)))


# 公開設定に、権限の切り替え（2.8.0）を反映した候補を、Node.js の部品（bridge-permission.mjs。Windows版と同じ変換）で作る。実際の設定は書かない。
# - source_read on: detailExposure.sourceText と gitExposure.paths を true にする。off: detailExposure.sourceText だけ false にする（paths は残す）。
# - claude_code on / off: claudeCode.enabled を true / false にする（claudeCode が無い on は {"enabled": true}＝許可コマンドなしで作る。無い off は何もしない）。
# - allowed_commands: 渡したときだけ claudeCode.allowedCommands を置き換える（書けないコマンドの検証は、公開範囲を求めるときにサーバーが行う）。
# 指定しなかった項目は変えない。戻り値: (候補のJSONの文字列, 設定が変わるか)。
def build_permission_candidate(root: Path, source_read: str | None, claude_code: str | None, allowed_commands: list[str] | None) -> tuple[str, bool]:
    config_path = root / CONFIG_NAME  # プロジェクトの公開設定。
    if config_path.is_symlink():
        raise BridgeError(f"設定ファイルにシンボリックリンクは使用できません: {config_path}")
    work_directory = tempfile.mkdtemp(prefix="bridge-permission-")  # 候補を受け取る一時フォルダー（0700）。
    try:
        output_path = Path(work_directory) / "candidate.json"  # 候補の保存先（部品が新しく作る）。
        command = [find_node(), str(PERMISSION_HELPER_PATH), "--config", str(config_path), "--output", str(output_path)]  # 部品の起動コマンド。
        if source_read:
            command += ["--source-read", source_read]
        if claude_code:
            command += ["--claude-code", claude_code]
        # Windows版と同じく、1つの値に改行で区切って複数を渡せる（コマンドのパターンに改行は含められない）。
        for item in allowed_commands or []:
            for line in item.splitlines():
                if line.strip():
                    command += ["--allowed-command", line.strip()]
        result = subprocess.run(command, capture_output=True, encoding="utf-8", check=False)
        if result.returncode != 0:
            raise BridgeError(f"権限の変更を設定へ反映できません: {result.stderr.strip()}")
        try:
            changed = json.loads(result.stdout).get("changed") is True  # 設定が変わるか。
            return output_path.read_text(encoding="utf-8"), changed
        except (OSError, ValueError, AttributeError) as error:
            raise BridgeError(f"権限の変更の結果を読めません: {error}") from error
    finally:
        shutil.rmtree(work_directory, ignore_errors=True)


# 設定ファイルを、元のバイト列のまま原子的に書き戻す（適用の途中で失敗したときの復元）。
def restore_file_bytes(path: Path, data: bytes, mode: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


# 権限（ソースの読み取り・Claude Code の起動・許可コマンド）の切り替えを、変更と承認を1つの操作にして行う（2.8.0）。
# 指紋なし: 変更後の公開範囲の確認結果（show-exposure と同じ形のJSON）を出すだけで、設定も承認も書かない。
# 指紋付き: 変更後の指紋と一致するときだけ、設定を書き、実物の設定の指紋を確かめてから承認を書く。途中で失敗したら設定を元のバイト列に戻す。
def set_permission(root: Path, args: argparse.Namespace) -> None:
    config = read_config(root)
    profile = resolve_profile(config, args.profile, root)
    candidate_text, changed = build_permission_candidate(root, args.source_read, args.claude_code, args.allowed_command)  # 変更後の設定の候補（JSONの文字列）と、設定が変わるか。
    report = collect_exposure_report(root, profile, candidate_text)  # 変更後の公開範囲の確認結果。
    if not args.exposure_sha256:
        print(dumps_for_terminal(report))
        return
    if args.exposure_sha256.strip().lower() != report["exposureSha256"]:
        raise BridgeError("--exposure-sha256 が変更後の公開範囲の指紋と一致しません。確認の結果を読み直してください。設定も承認も変えていません。")
    config_path = root / CONFIG_NAME  # プロジェクトの公開設定。
    original = config_path.read_bytes()  # 元のバイト列（失敗時に戻す）。
    original_mode = stat.S_IMODE(config_path.stat().st_mode)  # 元の権限。
    if changed:
        atomic_write_text(config_path, candidate_text, original_mode)
    try:
        printed = get_exposure(root)  # 書いた実物の設定から求め直した公開範囲。
        if printed["sha256"] != report["exposureSha256"]:
            raise BridgeError("書いた設定の公開範囲の指紋が、確認した内容と一致しません。設定を元に戻しました。")
        record = {"schemaVersion": 1, "sha256": printed["sha256"], "approvedAt": dt.datetime.now().astimezone().isoformat(), "exposure": printed["exposure"]}  # 保存する承認内容。
        atomic_write_text(approval_path(profile), json.dumps(record, ensure_ascii=False, indent=2) + "\n", 0o600)
    except BaseException:
        if changed:
            restore_file_bytes(config_path, original, original_mode)
        raise
    print(f"{'設定を変更し、' if changed else '設定は変わりません。'}公開範囲の承認を保存しました（指紋 {printed['sha256']}）。ハブの再起動は要りません。")


# 公開範囲から、ソースの読み取りの状態を求める。on = sourceText と paths が両方 true、partial = sourceText だけ true（ファイル名が無く使えない）、off = それ以外。
def source_read_state(exposure: dict) -> str:
    detail = exposure.get("detailExposure")  # 詳細取得の公開設定（全部falseなら項目ごと無い）。
    git_exposure = exposure.get("gitExposure")  # Git情報の公開設定。
    text_allowed = isinstance(detail, dict) and detail.get("sourceText") is True  # 本文の公開。
    paths_allowed = isinstance(git_exposure, dict) and git_exposure.get("paths") is True  # ファイル名の公開。
    if text_allowed and paths_allowed:
        return "on"
    return "partial" if text_allowed else "off"


# 公開範囲から、Claude Code の起動の状態を求める。on / off / unset（claudeCode の設定が無い）。
def claude_code_state(exposure: dict) -> str:
    section = exposure.get("claudeCode")  # Claude Code のジョブの設定。
    if not isinstance(section, dict):
        return "unset"
    return "on" if section.get("enabled") is True else "off"


# ハブの1プロジェクトの権限の状態を、何も書き込まずに求める。1件の失敗は、そのプロジェクトの error に入れて残りを続ける。
def hub_permission_entry(item: dict) -> dict:
    profile = Path(item["approvalFile"]).stem  # ハブの承認に使うプロファイル名（approvalFile の拡張子を除いた名前）。
    entry = {
        "name": item["name"],
        "root": item["root"],
        "profile": profile,
        "approvalState": "unavailable",
        "sourceRead": None,
        "claudeCode": None,
        "allowedCommandCount": 0,
        "error": None,
    }  # 1プロジェクトの状態。
    try:
        printed = get_exposure(Path(item["root"]))
        approval = read_approval(Path(item["approvalFile"]))
        entry["approvalState"] = "approved" if recorded_sha256(approval) == printed["sha256"] else ("changed" if approval is not None else "unapproved")
        entry["sourceRead"] = source_read_state(printed["exposure"])
        entry["claudeCode"] = claude_code_state(printed["exposure"])
        section = printed["exposure"].get("claudeCode")  # Claude Code のジョブの設定。
        commands = section.get("allowedCommands") if isinstance(section, dict) else None  # 許可コマンド。
        entry["allowedCommandCount"] = len(commands) if isinstance(commands, list) else 0
    except (BridgeError, ValueError, OSError) as error:
        entry["error"] = str(error)
    return entry


# ハブの全プロジェクトについて、ソースの読み取りと Claude Code の起動の状態・承認の状態を、JSON 1つだけ標準出力へ出す（2.8.0）。何も書き込まない。
def hub_permissions() -> None:
    hub = read_hub()  # 現在のハブ設定。
    print(dumps_for_terminal({"schemaVersion": 1, "projects": [hub_permission_entry(item) for item in hub["projects"]]}))


# Tunnel ClientのstdioプロファイルをXDGディレクトリへ生成する。
def configure_tunnel(root: Path, args: argparse.Namespace) -> None:
    if not args.tunnel_id or not TUNNEL_PATTERN.fullmatch(args.tunnel_id):
        raise BridgeError("--tunnel-id は tunnel_ に32桁の小文字16進数が続く形式です。")
    config = read_config(root)
    profile = resolve_profile(config, args.profile, root)
    client = find_tunnel_client(args.tunnel_client_path)
    node = find_node()
    profiles = ensure_private_directory(profile_directory())
    profile_path = profiles / f"{profile}.yaml"
    existing_tunnel = str(config.get("tunnelId") or "")
    if existing_tunnel and existing_tunnel != args.tunnel_id and not args.force:
        raise BridgeError(f"既存設定のTunnel IDと一致しません。別Tunnelへの変更は明示的な --force が必要です: {existing_tunnel}")
    if profile_path.exists() or profile_path.is_symlink():
        details = profile_path.lstat()
        if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
            raise BridgeError(f"既存Tunnelプロファイルの安全性を確認できません: {profile_path}")
        profile_text = profile_path.read_text(encoding="utf-8", errors="replace")
        root_matches = str(root) in profile_text
        tunnel_matches = args.tunnel_id in profile_text
        has_approval = "--approval-file" in profile_text  # 2.1.0以降の承認付き起動コマンドか。
        if (not root_matches or not tunnel_matches) and not args.force:
            raise BridgeError(f"既存Tunnelプロファイルは別ルートまたは別Tunnelを参照しています: {profile_path}")
        if not has_approval and not args.force:
            raise BridgeError(f"既存Tunnelプロファイルは公開範囲の承認に対応していません（2.0.0で作成）。add-projectを --force-reconfigure 付きで実行して再生成してください: {profile_path}")
        if root_matches and tunnel_matches and has_approval and not args.force:
            config["profileName"] = profile
            config["tunnelId"] = args.tunnel_id
            write_config(root, config)
            print(f"同じTunnelプロファイルを再利用します: {profile_path}")
            return
    pid_path = state_directory() / f"{profile}.pid"
    if pid_path.is_file() and not pid_path.is_symlink():
        try:
            running_pid = int(pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            running_pid = -1
        if running_pid > 0 and matching_process(running_pid, client, profile):
            raise BridgeError(f"Tunnel Client実行中はプロファイルを再設定できません。先に停止してください。PID: {running_pid}")
    reject_unsafe_command_path(SKILL_ROOT, "skill-root")
    approval = approval_path(profile)  # サーバーが照合するプロジェクト外の承認ファイル。
    reject_unsafe_command_path(approval, "approval-file")
    access_log = xdg_base("XDG_STATE_HOME", "~/.local/state") / "chatgpt-project-bridge" / f"access-{profile}.log"  # ChatGPTからのアクセスを記録するログ。
    reject_unsafe_command_path(access_log, "access-log")
    command = shlex.join([node, str(SERVER_PATH), "--stdio", "--project-root", str(root), "--config", str(root / CONFIG_NAME), "--approval-file", str(approval), "--notify", "--access-log", str(access_log)])
    key_reference = f"file:{secret_path(profile)}"
    port = int(args.health_port or 0)
    if port < 0 or port > 65535:
        raise BridgeError("--health-port は0から65535で指定してください。")
    command_line = [
        client,
        "init",
        "--sample",
        "sample_mcp_stdio_local",
        "--profile",
        profile,
        "--profile-dir",
        str(profiles),
        "--tunnel-id",
        args.tunnel_id,
        "--control-plane-api-key-ref",
        key_reference,
        "--health-listen-addr",
        f"127.0.0.1:{port}",
        "--mcp-command",
        command,
    ]
    if args.force:
        command_line.append("--force")
    subprocess.run(command_line, check=True)
    config["profileName"] = profile
    config["tunnelId"] = args.tunnel_id
    config["healthPort"] = port
    write_config(root, config)
    print(f"Tunnelプロファイルを設定しました: {profile_path}")
    print("health portは起動時に決まり、Statusは専用URLファイルから検出します。" if port == 0 else f"固定管理ポート: http://127.0.0.1:{port}/ui")


# Tunnel ClientへXDGプロファイル・状態ディレクトリを渡す共通環境を作る。
def tunnel_environment() -> dict[str, str]:
    profiles = ensure_private_directory(profile_directory())
    state = ensure_private_directory(state_directory())
    environment = os.environ.copy()
    environment["TUNNEL_CLIENT_PROFILE_DIR"] = str(profiles)
    environment["TUNNEL_CLIENT_STATE_DIR"] = str(state)
    return environment


# 保存済みプロファイルを公式doctorで検証し、公開範囲の承認状態も表示する。
def doctor(root: Path, args: argparse.Namespace) -> None:
    config = read_config(root)
    profile = resolve_profile(config, args.profile, root)
    tunnel_id = str(config.get("tunnelId") or "")
    if not TUNNEL_PATTERN.fullmatch(tunnel_id) or not assert_existing_profile_binding(root, profile, tunnel_id):
        raise BridgeError("doctorの前に同じプロジェクトとTunnelのプロファイルを設定してください。")
    if not confirm_exposure(root, profile, None, no_prompt=True):
        print("警告: 公開範囲が未承認です。承認されるまでChatGPTからのツール呼び出しは拒否されます。start時に承認を求めます。")
    client = find_tunnel_client(args.tunnel_client_path)
    subprocess.run([client, "doctor", "--profile-dir", str(profile_directory()), "--profile", profile, "--explain"], env=tunnel_environment(), check=True)


# PIDが同じTunnel Clientとプロファイルを指すかLinuxの/procで確認する。
def matching_process(pid: int, client: str, profile: str) -> bool:
    try:
        os.kill(pid, 0)
        executable = (Path("/proc") / str(pid) / "exe").resolve(strict=True)
        command = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\x00")
        arguments = [item.decode("utf-8", errors="replace") for item in command if item]
        return executable == Path(client).resolve(strict=True) and "--profile" in arguments and profile in arguments
    except (OSError, ValueError):
        return False


# 公開範囲の承認を確かめてから、Tunnel Clientをforegroundで起動し、動的health URLを状態ディレクトリへ記録する。
def start(root: Path, args: argparse.Namespace) -> None:
    config = read_config(root)
    profile = resolve_profile(config, args.profile, root)
    tunnel_id = str(config.get("tunnelId") or "")
    if not TUNNEL_PATTERN.fullmatch(tunnel_id) or not assert_existing_profile_binding(root, profile, tunnel_id):
        raise BridgeError("startの前に同じプロジェクトとTunnelのプロファイルを設定してください。")
    confirm_exposure(root, profile, getattr(args, "exposure_sha256", None))
    start_profile_tunnel(profile, args.tunnel_client_path, tunnel_id)


# 指定プロファイルのTunnel Clientを、同一プロファイルの重複起動を避けてforegroundで起動する。
def start_profile_tunnel(profile: str, tunnel_client_path: str | None, tunnel_id: str) -> None:
    client = find_tunnel_client(tunnel_client_path)  # 起動するTunnel Client。
    state = ensure_private_directory(state_directory())
    pid_path = state / f"{profile}.pid"
    log_path = state / f"{profile}.log"
    health_path = state / f"{profile}.health-url"
    if pid_path.exists() and not pid_path.is_symlink():
        try:
            pid = int(pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            pid = -1
        if pid > 0 and matching_process(pid, client, profile):
            print(f"同じプロファイルは既に起動中です。PID: {pid}")
            show_profile_status(profile, tunnel_id)
            return
        pid_path.unlink(missing_ok=True)
    health_path.unlink(missing_ok=True)
    print(f"Tunnel Clientを開始します。終了はCtrl+Cです。ログ: {log_path}")
    command = [
        client,
        "run",
        "--profile-dir",
        str(profile_directory()),
        "--profile",
        profile,
        "--pid.file",
        str(pid_path),
        "--log.file",
        str(log_path),
        "--health.url-file",
        str(health_path),
    ]
    subprocess.run(command, env=tunnel_environment(), check=True)


# Tunnel Clientが書いたloopback health URLだけを使って現在状態を表示する。
def show_status(root: Path) -> None:
    config = read_config(root)
    show_profile_status(resolve_profile(config, None, root), config.get("tunnelId"))


# 指定プロファイルのTunnel Clientが書いたloopback health URLから、現在状態を表示する。
def show_profile_status(profile: str, tunnel_id: str | None) -> None:
    health_path = state_directory() / f"{profile}.health-url"  # 動的health URLの記録先。
    if not health_path.is_file() or health_path.is_symlink():
        raise BridgeError(f"Tunnel Clientは停止中、またはhealth URLがありません: {health_path}")
    base_url = health_path.read_text(encoding="utf-8").strip().rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise BridgeError(f"loopback以外のhealth URLは拒否しました: {base_url}")
    try:
        opener = urllib.request.build_opener(NoRedirectHandler())
        with opener.open(base_url + "/health?details=true", timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, ValueError) as error:  # ValueError は壊れたJSONと不正なUTF-8。
        raise BridgeError(f"Tunnel Clientの管理画面へ接続できません: {base_url}/ui: {error}") from error
    print(dumps_for_terminal({"profile": profile, "tunnelId": tunnel_id, "adminUI": base_url + "/ui", "health": payload}))


# 既存profileが同じproject rootとTunnelを参照し、承認ファイル付きの起動コマンドであることを、鍵操作より前に確認する。
def assert_existing_profile_binding(root: Path, profile: str, tunnel_id: str, allow_legacy: bool = False) -> bool:
    path = profile_directory() / f"{profile}.yaml"
    if not path.exists() and not path.is_symlink():
        return False
    details = path.lstat()
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        raise BridgeError(f"既存Tunnelプロファイルの安全性を確認できません: {path}")
    content = path.read_text(encoding="utf-8", errors="replace")
    if str(root) not in content or tunnel_id not in content:
        raise BridgeError(f"既存Tunnelプロファイルは別ルートまたは別Tunnelを参照しています: {path}")
    if "--approval-file" not in content and not allow_legacy:
        raise BridgeError(f"既存Tunnelプロファイルは公開範囲の承認に対応していません（2.0.0で作成）。add-projectを --force-reconfigure 付きで実行して再生成してください: {path}")
    return True


# 正確なクラウド設定URLを表示し、許可時だけ既定browserで開く。
def show_cloud_url(label: str, url: str, no_browser: bool) -> None:
    print(f"{label}: {url}", flush=True)
    if no_browser:
        return
    opener = shutil.which("xdg-open")  # ブラウザーを開くコマンド。
    if opener:
        # ブラウザーのメッセージが端末へ混ざり、入力待ちが分かりにくくなるのを防ぐため、出力を捨てて別セッションで開く。
        try:
            subprocess.Popen([opener, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            return
        except OSError:
            pass
    webbrowser.open(url, new=2, autoraise=True)


# 初回・再開の状態を判定し、公開範囲の承認後に設定、鍵、doctor、foreground起動を順番に行う。
def add_project(args: argparse.Namespace) -> None:
    raw_root = args.project_root or input("プロジェクトルート: ").strip()
    root = resolve_project_root(raw_root)
    config_path = root / CONFIG_NAME
    existing = config_path.exists() or config_path.is_symlink()
    config = read_config(root) if existing else None
    name = args.project_name or (str(config.get("projectName") or "") if config else "")
    if not name:
        entered = input(f"プロジェクト名 [{root.name}]: ").strip()
        name = entered or root.name

    show_cloud_url("Tunnel作成・管理", TUNNELS_URL, args.no_browser)
    tunnel_id = args.tunnel_id or input("Tunnel ID (tunnel_...): ").strip()
    if not TUNNEL_PATTERN.fullmatch(tunnel_id):
        raise BridgeError("Tunnel IDは tunnel_ に32桁の小文字16進数が続く形式です。")

    if config:
        configured_tunnel = str(config.get("tunnelId") or "")
        if configured_tunnel and configured_tunnel != tunnel_id:
            raise BridgeError(f"既存設定のTunnel IDと一致しません。別プロジェクト用Tunnelとして扱ってください: {configured_tunnel}")
        profile = resolve_profile(config, args.profile, root)
    else:
        profile = args.profile or new_profile_name(name, root)
        if not PROFILE_PATTERN.fullmatch(profile):
            raise BridgeError(f"プロファイル名が不正です: {profile}")
    profile_exists = assert_existing_profile_binding(root, profile, tunnel_id, allow_legacy=bool(args.force_reconfigure))

    created_scaffold = False  # このActionでbridge設定と文書を新規作成したか。
    if config is None:
        initialize_project(root, name, False)
        created_scaffold = True
        config = read_config(root)
    test_project(root)
    print(f"解決済みプロジェクトルート: {root}")
    try:
        confirm_exposure(root, profile, args.exposure_sha256)
    except BridgeError:
        if created_scaffold:
            print(f"作成したbridge設定と文書は公開されていません。不要なら削除してください: {config_path}")
        raise

    configure_args = argparse.Namespace(**vars(args))
    configure_args.tunnel_id = tunnel_id
    configure_args.profile = profile
    configure_args.force = bool(args.force_reconfigure)
    if not profile_exists or args.force_reconfigure or not config.get("tunnelId"):
        configure_tunnel(root, configure_args)
    else:
        print(f"同じTunnelプロファイルを再利用します: {profile_directory() / (profile + '.yaml')}")

    key_path = secret_directory().expanduser() / f"{profile}.key"
    key_exists = key_path.is_file() and not key_path.is_symlink()
    if args.replace_key or not key_exists:
        show_cloud_url("Runtime API Key", API_KEYS_URL, args.no_browser)
        save_runtime_key(root, profile, replace_key=args.replace_key)
    else:
        print(f"既存Runtime API Keyを存在確認だけで再利用します: {key_path}")

    doctor(root, configure_args)
    show_cloud_url("ChatGPT Plugins", PLUGINS_URL, args.no_browser)
    if args.no_start:
        print("Tunnel Clientのforeground起動は --no-start により省略しました。")
        return
    start(root, configure_args)


# ---------------------------------------------------------------------------
# ハブ方式: PCごとに1つのTunnel・App・Runtime API Keyで、複数プロジェクトを公開する。
# ハブ設定は $XDG_CONFIG_HOME/chatgpt-project-bridge/hub.json（プロジェクトの外、0600）に置く。
# ---------------------------------------------------------------------------
HUB_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")  # ハブ内のプロジェクト名。


# ハブ設定ファイルのパスを返す（ディレクトリは0700で作る）。
def hub_path() -> Path:
    return ensure_private_directory(xdg_base("XDG_CONFIG_HOME", "~/.config") / "chatgpt-project-bridge") / "hub.json"


# このPCのハブ用Tunnelプロファイル名を、ハブ設定のパスから決める。
def hub_profile_name() -> str:
    return "chatgpt-hub-" + hashlib.sha256(str(hub_path()).encode("utf-8")).hexdigest()[:8]


# ハブ設定を読む。無ければ空のハブを返す。形式が不正なら止める。
def read_hub() -> dict:
    path = hub_path()  # ハブ設定ファイル。
    if path.is_symlink():
        raise BridgeError(f"ハブ設定にシンボリックリンクは使用できません: {path}")
    default_notifications = {"start": True, "access": True, "intervalSeconds": 60}  # 既定の通知設定（起動時とアクセス時に通知、同じプロジェクトは60秒に1回まで）。
    default_access_log = str(xdg_base("XDG_STATE_HOME", "~/.local/state") / "chatgpt-project-bridge" / "access.log")  # 既定のアクセスログ。
    if not path.exists():
        return {"schemaVersion": 1, "profileName": hub_profile_name(), "tunnelId": None, "healthPort": None, "notifications": default_notifications, "accessLog": default_access_log, "projects": []}
    try:
        hub = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:  # ValueError は壊れたJSONと不正なUTF-8（UnicodeDecodeError）の両方。
        raise BridgeError(f"ハブ設定を読めません: {path}: {error}") from error
    if not isinstance(hub, dict) or hub.get("schemaVersion") != 1 or not isinstance(hub.get("projects"), list):
        raise BridgeError(f"ハブ設定の形式が不正です: {path}")
    for item in hub["projects"]:
        if not isinstance(item, dict) or not all(isinstance(item.get(key), str) for key in ("name", "root", "approvalFile")):
            raise BridgeError(f"ハブ設定の登録プロジェクトの形式が不正です（name・root・approvalFile が文字列ではありません）: {path}")
    # 2.2.1 以前のハブ設定には通知とアクセスログの項目が無いので、既定値を補う。
    if not isinstance(hub.get("notifications"), dict):
        hub["notifications"] = default_notifications
    if not hub.get("accessLog"):
        hub["accessLog"] = default_access_log
    return hub


# ハブ設定を0600で原子的に保存する。
def write_hub(hub: dict) -> None:
    record = {
        "schemaVersion": 1,
        "profileName": hub["profileName"],
        "tunnelId": hub.get("tunnelId"),
        "healthPort": hub.get("healthPort"),
        "notifications": hub.get("notifications"),
        "accessLog": hub.get("accessLog"),
        "projects": [{"name": item["name"], "root": item["root"], "approvalFile": item["approvalFile"]} for item in hub["projects"]],
    }  # 保存するハブ設定。
    atomic_write_text(hub_path(), json.dumps(record, ensure_ascii=False, indent=2) + "\n", 0o600)


# プロジェクト名から、ハブ内で使う名前（英数字と . _ -）を作る。
def new_hub_project_name(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._") or "project"  # 使えない文字を置き換えた名前。
    return slug[:63].rstrip("-._") or "project"


# ハブ用プロファイルが、このPCのハブ設定と指定Tunnelを参照していることを確かめる。無ければ False を返す。
def assert_hub_profile_binding(profile: str, tunnel_id: str) -> bool:
    path = profile_directory() / f"{profile}.yaml"  # ハブ用プロファイル。
    if not path.exists() and not path.is_symlink():
        return False
    details = path.lstat()
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        raise BridgeError(f"既存のハブ用Tunnelプロファイルの安全性を確認できません: {path}")
    content = path.read_text(encoding="utf-8", errors="replace")
    if "--hub" not in content or str(hub_path()) not in content or tunnel_id not in content:
        raise BridgeError(f"既存のハブ用Tunnelプロファイルは、このPCのハブ設定または指定Tunnelを参照していません: {path}")
    return True


# ハブ用Tunnelプロファイルを公式initで生成し、ハブ設定にTunnel IDを記録する。
def initialize_hub_profile(hub: dict, tunnel_id: str, tunnel_client_path: str | None, replace: bool) -> None:
    profile = hub["profileName"]  # ハブ用プロファイル名。
    client = find_tunnel_client(tunnel_client_path)
    node = find_node()
    profiles = ensure_private_directory(profile_directory())
    pid_path = state_directory() / f"{profile}.pid"
    if pid_path.is_file() and not pid_path.is_symlink():
        try:
            running_pid = int(pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            running_pid = -1
        if running_pid > 0 and matching_process(running_pid, client, profile):
            raise BridgeError(f"ハブのTunnel Client実行中はプロファイルを再設定できません。先に停止してください。PID: {running_pid}")
    reject_unsafe_command_path(SKILL_ROOT, "skill-root")
    reject_unsafe_command_path(hub_path(), "hub")
    command = shlex.join([node, str(SERVER_PATH), "--stdio", "--hub", str(hub_path())])  # ハブモードのMCP起動コマンド。
    command_line = [
        client, "init", "--sample", "sample_mcp_stdio_local",
        "--profile", profile, "--profile-dir", str(profiles),
        "--tunnel-id", tunnel_id,
        "--control-plane-api-key-ref", f"file:{secret_path(profile)}",
        "--health-listen-addr", "127.0.0.1:0",
        "--mcp-command", command,
    ]
    if replace:
        command_line.append("--force")
    subprocess.run(command_line, check=True)
    hub["tunnelId"] = tunnel_id
    hub["healthPort"] = 0
    write_hub(hub)
    print(f"ハブ用Tunnelプロファイルを設定しました: {profiles / (profile + '.yaml')}")


# ハブ内の各プロジェクトについて、名前・承認状態・ルートを返す。値は端末へそのまま出せる形（制御文字を退避済み）にする。
# 1つのプロジェクトで例外が起きても、そのプロジェクトを「使用不可」にして残りを続ける。
def hub_project_states(hub: dict) -> list[tuple[str, str, str]]:
    states = []  # (名前, 承認状態, ルート) の一覧。
    for item in hub["projects"]:
        try:
            printed = get_exposure(Path(item["root"]))
            approval = read_approval(Path(item["approvalFile"]))
            state = "承認済み" if recorded_sha256(approval) == printed["sha256"] else "未承認（設定が変わったか、まだ承認していない）"
        except (BridgeError, ValueError, OSError) as error:
            state = f"使用不可（{escape_forbidden(str(error))}）"
        states.append((escape_forbidden(item["name"]), state, quote_for_display(item["root"])))
    return states


# プロジェクトをハブへ追加する。初回だけTunnelプロファイル・キー・doctor・起動まで行う。承認を得るまでTunnelやキーは変更しない。
def hub_add(args: argparse.Namespace) -> None:
    raw_root = args.project_root or input("プロジェクトルート: ").strip()
    root = resolve_project_root(raw_root)
    hub = read_hub()  # 現在のハブ設定。
    hub_tunnel = str(hub.get("tunnelId") or "")  # ハブに記録済みのTunnel ID。
    if not hub_tunnel:
        show_cloud_url("Tunnel作成・管理（このPCのハブ用に1つ作成）", TUNNELS_URL, args.no_browser)
        tunnel_id = args.tunnel_id or input("Tunnel ID (tunnel_...): ").strip()
    else:
        if args.tunnel_id and args.tunnel_id != hub_tunnel:
            raise BridgeError(f"このPCのハブは別のTunnelを使っています: {hub_tunnel}")
        tunnel_id = hub_tunnel
    if not TUNNEL_PATTERN.fullmatch(tunnel_id):
        raise BridgeError("Tunnel IDは tunnel_ に32桁の小文字16進数が続く形式です。")
    profile = hub["profileName"]  # ハブ用プロファイル名。
    profile_exists = (profile_directory() / f"{profile}.yaml").exists()  # ハブ用プロファイルの有無。
    if profile_exists and not args.force_reconfigure:
        assert_hub_profile_binding(profile, tunnel_id)

    config_path = root / CONFIG_NAME  # プロジェクトの公開設定。
    created_scaffold = False  # このActionで scaffold を作ったか。
    if not config_path.exists() and not config_path.is_symlink():
        initialize_project(root, args.project_name or root.name, False)
        created_scaffold = True
    config = read_config(root)
    if config.get("tunnelId"):
        print(f"注意: このプロジェクトには従来方式のTunnel（{escape_forbidden(str(config['tunnelId']))}）も設定されています。同じプロジェクトを従来方式とハブ方式で同時に起動しないでください。")
    project_profile = resolve_profile(config, None, root)  # 承認ファイルを決めるプロジェクトのプロファイル名。
    test_project(root)
    print(f"解決済みプロジェクトルート: {root}")
    try:
        confirm_exposure(root, project_profile, args.exposure_sha256)
    except BridgeError:
        if created_scaffold:
            print(f"作成したbridge設定と文書は公開されていません。不要なら削除してください: {config_path}")
        raise

    existing = [item for item in hub["projects"] if Path(item["root"]) == root]  # 既に登録済みの同じルート。
    name = existing[0]["name"] if existing else (args.hub_name or new_hub_project_name(str(config.get("projectName") or root.name)))  # ハブ内の名前。
    if not HUB_NAME_PATTERN.fullmatch(name):
        raise BridgeError(f"ハブ内の名前は英数字で始まり、英数字と . _ - の63文字以内です: {name}")
    if any(item["name"].lower() == name.lower() and Path(item["root"]) != root for item in hub["projects"]):
        raise BridgeError(f"ハブには同じ名前の別プロジェクトがあります: {name}（--hub-name で別の名前を指定してください）")
    hub["projects"] = [item for item in hub["projects"] if Path(item["root"]) != root] + [{"name": name, "root": str(root), "approvalFile": str(approval_path(project_profile))}]
    write_hub(hub)
    print(f"ハブに登録しました: {name}（{root}）")

    need_profile = (not profile_exists) or bool(args.force_reconfigure) or not hub_tunnel  # ハブ用プロファイルの生成が必要か。
    key_path = secret_directory().expanduser() / f"{profile}.key"  # ハブ用Runtime API Key。
    key_exists = key_path.is_file() and not key_path.is_symlink()  # キーが保存済みか。
    if not need_profile and key_exists and not args.replace_key:
        print("このPCのハブは設定済みです。起動中のハブには再起動なしで反映されます。ChatGPTでは list_projects で確認できます。")
        return
    if need_profile:
        initialize_hub_profile(hub, tunnel_id, args.tunnel_client_path, bool(args.force_reconfigure and profile_exists))
    else:
        print("ハブ用プロファイルは設定済みですが、Runtime API Keyが保存されていません。キーの入力から続けます。")
    if args.replace_key or not key_exists:
        show_cloud_url("Runtime API Key（このPC用に1つ作成）", API_KEYS_URL, args.no_browser)
        save_profile_runtime_key(profile, bool(args.replace_key))
    else:
        print(f"既存Runtime API Keyを存在確認だけで再利用します: {key_path}")
    hub_doctor(args)
    show_cloud_url("ChatGPT Plugins（このPCのハブ用にAppを1つ作成）", PLUGINS_URL, args.no_browser)
    if args.no_start:
        print("ハブのforeground起動は --no-start により省略しました。")
        return
    hub_start(args)


# ハブから指定プロジェクトを外す。プロジェクトのファイルと承認ファイルには触れない。
def hub_remove(args: argparse.Namespace) -> None:
    hub = read_hub()  # 現在のハブ設定。
    before = len(hub["projects"])  # 削除前の件数。
    if args.hub_name:
        hub["projects"] = [item for item in hub["projects"] if item["name"].lower() != args.hub_name.lower()]
    else:
        root = resolve_project_root(args.project_root or str(Path.cwd()))
        hub["projects"] = [item for item in hub["projects"] if Path(item["root"]) != root]
    if len(hub["projects"]) == before:
        raise BridgeError("ハブに該当するプロジェクトがありません。hub-list で確認してください。")
    write_hub(hub)
    print("ハブから外しました。起動中のハブにも再起動なしで反映されます。プロジェクトのファイルと承認ファイルは残しています。")


# ハブの設定と、登録プロジェクトの承認状態を表示する。
def hub_list() -> None:
    hub = read_hub()  # 現在のハブ設定。
    print(f"ハブ設定: {hub_path()}")
    print(f"プロファイル: {escape_forbidden(str(hub['profileName']))}  Tunnel: {escape_forbidden(str(hub.get('tunnelId') or '未設定'))}")
    states = hub_project_states(hub)  # 各プロジェクトの状態。
    if not states:
        print("登録プロジェクト: なし（hub-add で追加します）")
        return
    for name, state, root in states:
        print(f"  {name}: {state}  {root}")


# ハブ用プロファイルを公式doctorで検証し、各プロジェクトの承認状態も表示する。
def hub_doctor(args: argparse.Namespace) -> None:
    hub = read_hub()  # 現在のハブ設定。
    tunnel_id = str(hub.get("tunnelId") or "")
    if not TUNNEL_PATTERN.fullmatch(tunnel_id) or not assert_hub_profile_binding(hub["profileName"], tunnel_id):
        raise BridgeError("ハブのTunnelが未設定です。先に hub-add を実行してください。")
    for name, state, _ in hub_project_states(hub):
        print(f"  {name}: {state}")
    hub_autostart_diagnostics()  # Tunnel Clientのdoctorが失敗しても表示されるよう、先に実行する。
    client = find_tunnel_client(args.tunnel_client_path)
    subprocess.run([client, "doctor", "--profile-dir", str(profile_directory()), "--profile", hub["profileName"], "--explain"], env=tunnel_environment(), check=True)


# 実行中のユーザー名を返す（lingerの確認・有効化の対象）。pwdはUnix専用のため、Windowsで読み込まれても失敗しないよう関数の中で読む
# （gui-selftest-windows-static.py が project-bridge.py をWindowsで読み込む）。
def current_user_name() -> str:
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


# 自動起動（systemdユーザーサービス）が、再起動後にログイン無しで動く状態かを確かめる。見つかった問題は警告にとどめ、hub-doctor自体は失敗にしない。
# systemctl・loginctlが使えない環境（コンテナ・試験など）では、その検査を省く（警告も出さない）。
def hub_autostart_diagnostics() -> None:
    unit_path = hub_service_path()
    if not unit_path.is_file():
        print("警告: 自動起動は未登録です。hub-service-install で登録してください。")
    else:
        try:
            enabled = subprocess.run(["systemctl", "--user", "is-enabled", unit_path.name], capture_output=True, text=True, check=False)
        except OSError:
            enabled = None  # systemctlが使えない環境では、この検査を省く。
        if enabled is not None:
            state = enabled.stdout.strip() or enabled.stderr.strip() or "不明"
            if state != "enabled":
                print(f"警告: 自動起動が有効になっていません（{state}）。hub-service-install で有効化してください。")
    user = current_user_name()  # lingerの確認対象（自分のユーザー）。
    try:
        linger = subprocess.run(["loginctl", "show-user", user, "-p", "Linger", "--value"], capture_output=True, text=True, check=False)
    except OSError:
        return  # loginctlが使えない環境では、この検査を省く。
    if linger.returncode != 0 or linger.stdout.strip() != "yes":
        print(f"警告: lingerが無効です。ログインしていないときはハブが動きません。hub-service-install で有効化、または sudo loginctl enable-linger {user} を実行してください。")


# 全プロジェクトの公開範囲の承認を確かめてから、ハブのTunnel Clientをforegroundで起動する。
# --service（自動起動用）のときは入力を求めず、未承認のプロジェクトは公開しないまま起動する。
def hub_start(args: argparse.Namespace) -> None:
    service = bool(getattr(args, "service", False))  # 入力を求めない起動か。
    hub = read_hub()  # 現在のハブ設定。
    tunnel_id = str(hub.get("tunnelId") or "")
    if not TUNNEL_PATTERN.fullmatch(tunnel_id) or not assert_hub_profile_binding(hub["profileName"], tunnel_id):
        raise BridgeError("ハブのTunnelが未設定です。先に hub-add を実行してください。")
    write_hub(hub)  # 2.2.1 以前のハブ設定へ、通知とアクセスログの既定値を書き足す。
    for item in hub["projects"]:
        name = escape_forbidden(item["name"])  # 端末へ出すハブ内の名前。
        print(f"--- {name}（{quote_for_display(item['root'])}）", flush=True)
        try:
            if not confirm_exposure(Path(item["root"]), Path(item["approvalFile"]).stem, None, no_prompt=service):
                print(f"警告: {name} は未承認のため公開しません。approve で承認すると、再起動なしで公開されます。", flush=True)
        except (BridgeError, ValueError, OSError) as error:
            # 対話の起動では止める（承認の拒否を含む）。自動起動では、このプロジェクトだけを公開せずに残りとハブを起動する。
            if not service:
                if isinstance(error, BridgeError):
                    raise
                raise BridgeError(f"{name} を確認できません: {error}") from error
            print(f"警告: {name} を確認できないため公開しません: {escape_forbidden(str(error))}", flush=True)
    start_profile_tunnel(hub["profileName"], args.tunnel_client_path, tunnel_id)


# ハブのTunnel ClientのPIDを返す。動いていなければ None。
def hub_running_pid(hub: dict, tunnel_client_path: str | None) -> int | None:
    pid_path = state_directory() / f"{hub['profileName']}.pid"  # Tunnel Clientが書くPIDファイル。
    if not pid_path.is_file() or pid_path.is_symlink():
        return None
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return pid if pid > 0 and matching_process(pid, find_tunnel_client(tunnel_client_path), hub["profileName"]) else None


# 動いているハブのTunnel Clientを止め、止まったことを確かめる。動いていなければ False を返す。
def hub_stop(args: argparse.Namespace) -> bool:
    hub = read_hub()  # 現在のハブ設定。
    pid = hub_running_pid(hub, args.tunnel_client_path)
    if pid is None:
        print("ハブは起動していません。")
        return False
    os.kill(pid, signal.SIGTERM)
    for _ in range(60):
        if hub_running_pid(hub, args.tunnel_client_path) is None:
            print(f"ハブを停止しました。PID: {pid}")
            return True
        time.sleep(0.5)
    raise BridgeError(f"ハブのTunnel Clientを停止できませんでした。PID: {pid}")


# systemdユーザーサービスのユニットファイルのパスを返す。
def hub_service_path() -> Path:
    return xdg_base("XDG_CONFIG_HOME", "~/.config") / "systemd" / "user" / "chatgpt-project-bridge-hub.service"


# PCの再起動後もログイン無しでハブが動くよう、自分のユーザーのlingerを有効にする。
# 既に有効なら何もしない。loginctlが無い環境、または権限などで有効化できなかった環境では、
# 失敗にせず手動のコマンドを案内する（有効化自体の成否は呼び出し元の処理を止めない）。
def ensure_linger_enabled() -> None:
    user = current_user_name()  # linger確認・有効化の対象（自分のユーザー）。
    manual_command = f"sudo loginctl enable-linger {user}"  # 自動化できなかったときの案内。
    try:
        before = subprocess.run(["loginctl", "show-user", user, "-p", "Linger", "--value"], capture_output=True, text=True, check=False)
        if before.returncode == 0 and before.stdout.strip() == "yes":
            return  # 既に有効。
        subprocess.run(["loginctl", "enable-linger", user], check=False)
        after = subprocess.run(["loginctl", "show-user", user, "-p", "Linger", "--value"], capture_output=True, text=True, check=False)
    except OSError:
        print(f"注意: loginctlを実行できないため、lingerを確認できません。ログインしていないときも動かす場合は {manual_command} を実行してください。")
        return
    if after.returncode == 0 and after.stdout.strip() == "yes":
        print("lingerを有効にしました。ログインしていないときもハブが動きます。")
    else:
        print(f"注意: lingerを有効にできませんでした（権限などが考えられます）。ログインしていないときも動かす場合は {manual_command} を実行してください。")


# ログイン時にハブを自動起動するsystemdユーザーサービスを登録する。no_enable のときはユニットを書くだけにする。
# 有効化したときは、ログインしていないときも動くようlingerも有効にする（失敗しても有効化自体は失敗にしない）。
def hub_service_install(args: argparse.Namespace) -> None:
    hub = read_hub()  # 現在のハブ設定。
    if not TUNNEL_PATTERN.fullmatch(str(hub.get("tunnelId") or "")):
        raise BridgeError("ハブのTunnelが未設定です。先に hub-add を実行してください。")
    script = Path(__file__).resolve()  # 自動起動で呼ぶ管理スクリプト。
    node_directory = str(Path(find_node()).parent)  # サービスのPATHへ入れるNode.jsの場所（Voltaなどのシムを含む）。
    client_directory = str(Path(find_tunnel_client(args.tunnel_client_path)).parent)  # Tunnel Clientの場所。
    path_entries = list(dict.fromkeys([node_directory, client_directory, str(Path("~/.local/bin").expanduser()), "/usr/local/bin", "/usr/bin", "/bin"]))  # サービス用のPATH。
    for value in [script, Path(sys.executable), *map(Path, path_entries)]:
        reject_unsafe_command_path(value, "service")
        if '"' in str(value) or "%" in str(value):
            raise BridgeError(f"サービスのパスに使えない文字が含まれています: {value}")
    # After=network-online.targetは--userサービスからはそのTargetが見えないため効かない（起動順の指定にならない）。
    # 代わりにExecStartPreで既定経路が付くまで最大60秒待つ。付かなくても失敗にせず起動する（NetworkManager以外でも動くように、ipコマンドの結果だけで判定する）。
    # systemdの行では$と%をそのまま書けないため、シェルへ渡す$は$$に、%はすべて%%にする。
    # サービスのPATHに/usr/sbin・/sbinが無くても、ipが/usr/sbinや/sbinにしか無い環境で60秒を待ち切らないよう、PATHの末尾へ足す。
    wait_for_route = 'PATH="$$PATH:/usr/sbin:/sbin"; count=0; while [ "$$count" -lt 60 ]; do ip route show default | grep -q . && exit 0; count=$$((count+1)); sleep 1; done; exit 0'
    unit = "\n".join([
        "[Unit]",
        "Description=ChatGPT Project Bridge hub (Tunnel Client)",
        "",
        "[Service]",
        "Type=simple",
        f'Environment="PATH={":".join(path_entries)}"',
        f"ExecStartPre=/bin/sh -c '{wait_for_route}'",
        f'ExecStart="{sys.executable}" -u "{script}" hub-start --service',
        "Restart=on-failure",
        "RestartSec=15",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ])  # ユニットファイルの内容。
    unit_path = hub_service_path()
    if unit_path.is_symlink():
        raise BridgeError(f"ユニットファイルにシンボリックリンクは使用できません: {unit_path}")
    atomic_write_text(unit_path, unit)
    print(f"自動起動のユニットを書きました: {unit_path}")
    print("注意: ログインしている間（lingerを有効にしたときは、ログインしていないときも）、承認済みのプロジェクトがChatGPTから常に読める状態になります。")
    if args.no_enable:
        print("--no-enable のため、有効化はしていません。")
        return
    if hub_running_pid(hub, args.tunnel_client_path) is not None:
        raise BridgeError("ハブが手動で起動中です。Ctrl+C か hub-stop で止めてから、もう一度実行してください。")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", unit_path.name], check=True)
    print("自動起動を有効にし、ハブを起動しました。状態: systemctl --user status chatgpt-project-bridge-hub")
    print("解除は hub-service-uninstall です。")
    ensure_linger_enabled()


# 自動起動のsystemdユーザーサービスを止めて解除する。
def hub_service_uninstall(args: argparse.Namespace) -> None:
    unit_path = hub_service_path()
    if not unit_path.exists():
        print("自動起動は登録されていません。")
        return
    if not args.no_enable:
        subprocess.run(["systemctl", "--user", "disable", "--now", unit_path.name], check=False)
    unit_path.unlink()
    if not args.no_enable:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    print(f"自動起動を解除しました: {unit_path}")


# 単一Manifestを検証し、配布ファイルとmodeを記載順で返す。
def load_distribution_manifest() -> tuple[str, list[tuple[str, int]]]:
    if MANIFEST_PATH.is_symlink() or not MANIFEST_PATH.is_file():
        raise BridgeError(f"distribution manifestが通常ファイルではありません: {MANIFEST_PATH}")
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BridgeError(f"distribution manifestを読めません: {error}") from error
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("version"), str) or not manifest["version"]:
        raise BridgeError("distribution manifestのschemaVersionまたはversionが不正です。")
    entries: list[tuple[str, int]] = []
    seen: set[str] = set()
    for item in manifest.get("files", []):
        relative = item.get("path") if isinstance(item, dict) else None
        mode_text = item.get("mode") if isinstance(item, dict) else None
        if not isinstance(relative, str) or not relative or PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
            raise BridgeError(f"distribution manifestのpathが不正です: {relative}")
        if relative in seen or not re.fullmatch(r"0[67][0-7]{2}", str(mode_text)):
            raise BridgeError(f"distribution manifestの重複pathまたはmodeが不正です: {relative}")
        seen.add(relative)
        entries.append((relative, int(str(mode_text), 8)))
    if "distribution.json" not in seen or not entries:
        raise BridgeError("distribution manifest自身を含むfilesが必要です。")
    return manifest["version"], entries


# 配布対象をfdで固定して読み、symlink・hardlink・境界外参照の混入を拒否する。
def read_distribution_file(relative: str, mode: int) -> tuple[bytes, int]:
    source = SKILL_ROOT / relative
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError as error:
        raise BridgeError(f"配布対象を安全に開けません: {relative}: {error}") from error
    try:
        opened_stat = os.fstat(descriptor)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise BridgeError(f"配布対象が通常ファイルではありません: {relative}")
        if opened_stat.st_nlink != 1:
            raise BridgeError(f"hardlinkされた配布対象は拒否しました: {relative}")
        path_stat = source.lstat()
        if stat.S_ISLNK(path_stat.st_mode):
            raise BridgeError(f"symlinkされた配布対象は拒否しました: {relative}")
        resolved = source.resolve(strict=True)
        try:
            resolved.relative_to(SKILL_ROOT)
        except ValueError as error:
            raise BridgeError(f"スキル外を指す配布対象は拒否しました: {relative}") from error
        current_stat = source.stat()
        if (opened_stat.st_dev, opened_stat.st_ino) != (current_stat.st_dev, current_stat.st_ino):
            raise BridgeError(f"検査中に差し替えられた配布対象を拒否しました: {relative}")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            data = stream.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise BridgeError(f"配布対象が8 MiBを超えています: {relative}")
        return data, mode
    finally:
        os.close(descriptor)


# スキル一式をUbuntu向けtar.gzまたは共通ZIPとして原子的に出力する。
def export_skill(output: str | None, force: bool) -> None:
    if not output:
        raise BridgeError("export-skillでは --output-path が必要です。")
    destination = Path(output).expanduser().resolve(strict=False)
    if not destination.parent.is_dir():
        raise BridgeError(f"出力先フォルダーがありません: {destination.parent}")
    if destination == SKILL_ROOT or SKILL_ROOT in destination.parents:
        raise BridgeError("配布物の出力先にスキル本体の配下は指定できません。")
    if destination.is_symlink():
        raise BridgeError(f"symlinkの出力先は拒否しました: {destination}")
    if destination.exists() and not force:
        raise BridgeError(f"出力ファイルは既にあります。置き換える場合だけ --force を指定してください: {destination}")
    if not (destination.name.endswith(".tar.gz") or destination.suffix.lower() == ".zip"):
        raise BridgeError("出力形式は .tar.gz または .zip を指定してください。")
    _, entries = load_distribution_manifest()
    payloads = [(relative, *read_distribution_file(relative, mode)) for relative, mode in entries]
    temporary_handle = tempfile.NamedTemporaryFile(prefix=f".{destination.name}.", dir=destination.parent, delete=False)
    temporary = Path(temporary_handle.name)
    temporary_handle.close()
    try:
        if destination.name.endswith(".tar.gz"):
            with temporary.open("wb") as raw_stream:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw_stream, mtime=0) as gzip_stream:
                    with tarfile.open(fileobj=gzip_stream, mode="w") as archive:
                        for relative, data, mode in payloads:
                            member = tarfile.TarInfo(f"chatgpt-project-bridge/{relative}")
                            member.size = len(data)
                            member.mode = mode
                            member.mtime = 0
                            archive.addfile(member, io.BytesIO(data))
        else:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for relative, data, mode in payloads:
                    member = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                    member.compress_type = zipfile.ZIP_DEFLATED
                    member.external_attr = (stat.S_IFREG | mode) << 16
                    archive.writestr(member, data)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"スキルパッケージを作成しました: {destination}")


# Windows/Ubuntuの1コマンド導入Bundleを同じManifestから再現可能に作る。署名鍵があればSHA256SUMS.txtへSSH署名する。
def export_bundle(output: str | None, force: bool, signing_key: str | None = None) -> None:
    if not output:
        raise BridgeError("export-bundleでは --output-path が必要です。")
    ssh_keygen = None  # 署名に使うssh-keygen。署名しない場合はNone。
    key_path = None  # 署名鍵の絶対パス。
    if signing_key:
        key_path = Path(signing_key).expanduser().resolve(strict=False)
        if not key_path.is_file():
            raise BridgeError(f"署名鍵がありません: {key_path}")
        ssh_keygen = shutil.which("ssh-keygen")
        if not ssh_keygen:
            raise BridgeError("ssh-keygenが見つかりません。openssh-clientを導入してください。")
    destination = Path(output).expanduser().resolve(strict=False)
    if destination == SKILL_ROOT or SKILL_ROOT in destination.parents:
        raise BridgeError("Bundleの出力先にSkill本体の配下は指定できません。")
    if destination.is_symlink():
        raise BridgeError(f"symlinkの出力先は拒否しました: {destination}")
    if destination.exists() and not destination.is_dir():
        raise BridgeError(f"Bundle出力先がフォルダーではありません: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    bundle_names = ("Windows", "Ubuntu")
    for name in bundle_names:
        target = destination / name
        if target.is_symlink():
            raise BridgeError(f"symlinkのBundle対象は拒否しました: {target}")
        if target.exists() and not target.is_dir():
            raise BridgeError(f"Bundle対象がフォルダーではありません: {target}")
        if target.exists() and not force:
            raise BridgeError(f"Bundle対象は既にあります。置き換える場合だけ --force を指定してください: {target}")
    version, entries = load_distribution_manifest()
    payloads = [(relative, *read_distribution_file(relative, mode)) for relative, mode in entries]
    payload_by_path = {relative: (data, mode) for relative, data, mode in payloads}
    stage = Path(tempfile.mkdtemp(prefix=".chatgpt-project-bridge.bundle.", dir=destination))
    backups: dict[str, Path] = {}
    installed: set[str] = set()
    try:
        windows = stage / "Windows"
        ubuntu = stage / "Ubuntu"
        windows.mkdir(); ubuntu.mkdir()
        windows_archive = windows / "chatgpt-project-bridge.zip"
        ubuntu_archive = ubuntu / "chatgpt-project-bridge.tar.gz"
        with zipfile.ZipFile(windows_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, data, mode in payloads:
                member = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(member, data)
        with ubuntu_archive.open("wb") as raw_stream:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw_stream, mtime=0) as gzip_stream:
                with tarfile.open(fileobj=gzip_stream, mode="w") as archive:
                    for relative, data, mode in payloads:
                        member = tarfile.TarInfo(f"chatgpt-project-bridge/{relative}")
                        member.size = len(data); member.mode = mode; member.mtime = 0
                        archive.addfile(member, io.BytesIO(data))
        windows_installer = windows / "install.ps1"
        ubuntu_installer = ubuntu / "install.sh"
        windows_installer.write_bytes(payload_by_path["scripts/install-windows.ps1"][0])
        ubuntu_installer.write_bytes(payload_by_path["scripts/install-ubuntu.sh"][0])
        os.chmod(ubuntu_installer, 0o755)
        for directory, files in ((windows, [windows_archive, windows_installer]), (ubuntu, [ubuntu_archive, ubuntu_installer])):
            version_file = directory / "VERSION.txt"  # 版の表示用ファイル。一覧の照合対象に含める。
            version_file.write_text(version + "\n", encoding="utf-8", newline="\n")
            lines = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in [*files, version_file]]
            sums_path = directory / "SHA256SUMS.txt"  # 人が別経路で照合する対象の一覧。
            sums_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            if ssh_keygen:
                subprocess.run([ssh_keygen, "-Y", "sign", "-f", str(key_path), "-n", SIGNATURE_NAMESPACE, str(sums_path)], check=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        for name in bundle_names:
            target = destination / name
            if target.exists():
                backup = destination / f".{name}.backup.{stamp}.{os.getpid()}"
                if backup.exists():
                    raise BridgeError(f"Bundle backup先が既にあります: {backup}")
                os.replace(target, backup)
                backups[name] = backup
            os.replace(stage / name, target)
            installed.add(name)
        for backup in backups.values():
            shutil.rmtree(backup)
    except BaseException:
        for name in reversed(bundle_names):
            target = destination / name
            backup = backups.get(name)
            if name in installed and target.exists():
                shutil.rmtree(target)
            if backup is not None and backup.exists():
                os.replace(backup, target)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(f"Bundleを作成しました: {destination}")
    print("導入先で実行前に照合する指紋（SHA256SUMS.txt のSHA-256）。Bundleとは別の経路で伝えてください:")
    for name in bundle_names:
        print(f"  {name}: {hashlib.sha256((destination / name / 'SHA256SUMS.txt').read_bytes()).hexdigest()}")
    if ssh_keygen:
        print(f"SHA256SUMS.txt.sig を作成しました（名前空間 {SIGNATURE_NAMESPACE}）。署名鍵の指紋:")
        subprocess.run([ssh_keygen, "-l", "-f", str(key_path)], check=True)
    else:
        print("署名していません。署名する場合は --signing-key でSSH秘密鍵を指定してください。")


# HTTPSでURLを取得し、本文をバイト列で返す。
def fetch_https(url: str, headers: dict[str, str] | None = None) -> bytes:
    if not url.startswith("https://"):
        raise BridgeError(f"HTTPS以外の取得先は拒否しました: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "chatgpt-project-bridge-lock-updater", **(headers or {})})
    with urllib.request.urlopen(request, timeout=120) as response:
        final_url = response.geturl()
        if not final_url.startswith("https://"):
            raise BridgeError(f"HTTPS以外へのリダイレクトを拒否しました: {final_url}")
        return response.read()


# 公開ハッシュ一覧から指定名の値を1件だけ取り出す。
def published_sha256(sums_text: str, name: str) -> str:
    values = [line.split()[0].lower() for line in sums_text.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip("*") == name]
    if len(values) != 1 or not SHA256_PATTERN.fullmatch(values[0]):
        raise BridgeError(f"公開SHA-256を一意に特定できません: {name}")
    return values[0]


# 来歴証明の検証に使うGitHub CLIを、明示パス、PATH、既定の導入先の順に探す。見つからなければ止める。
def find_gh(explicit: str | None) -> str:
    try:
        return find_executable(explicit, "gh", [Path("~/.local/bin/gh")])
    except BridgeError as error:
        raise BridgeError("Tunnel Clientの来歴証明を検証するGitHub CLI（gh）が見つかりません。手順書の「Bundle作成（保守者向け）」に従って導入するか、--gh-path で指定してください。") from error


# Tunnel ClientのアーカイブをSLSA来歴証明（Sigstore bundle）で検証する。署名ワークフロー・タグ・コミットまで照合し、失敗なら止める。
def assert_tunnel_provenance(gh: str, artifact: Path, bundle: Path, source_ref: str, source_digest: str) -> None:
    result = subprocess.run(
        [
            gh, "attestation", "verify", str(artifact),
            "--bundle", str(bundle),
            "--repo", PROVENANCE_REPOSITORY,
            "--signer-workflow", PROVENANCE_WORKFLOW,
            "--source-ref", source_ref,
            "--source-digest", source_digest,
            "--predicate-type", PROVENANCE_PREDICATE,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    if result.returncode != 0:
        raise BridgeError(f"Tunnel Clientの来歴証明の検証に失敗しました: {artifact.name}\n{(result.stdout + result.stderr).strip()}")


# 依存物（Tunnel Client / Node.js）の版とSHA-256をロックファイルへ固定する。保守者がSkillのソース上で実行する。
# Tunnel Clientは公開SHA256SUMS.txtとの一致に加え、SLSA来歴証明をGitHub CLIで検証できた版だけを固定する。
def update_lock(tunnel_version: str | None, node_version: str | None, gh_path: str | None = None) -> None:
    if tunnel_version and not re.fullmatch(r"v[0-9A-Za-z.\-]+", tunnel_version):
        raise BridgeError(f"--tunnel-client-version の形式が不正です: {tunnel_version}")
    if node_version and not re.fullmatch(r"v\d+\.\d+\.\d+", node_version):
        raise BridgeError(f"--node-version は v22.11.0 の形式で指定してください: {node_version}")
    gh = find_gh(gh_path)  # 来歴証明の検証に使うGitHub CLI。
    gh_version_result = subprocess.run([gh, "--version"], capture_output=True, text=True, check=False)
    if gh_version_result.returncode != 0 or not gh_version_result.stdout.strip():
        raise BridgeError(f"GitHub CLIを実行できません: {gh}")
    gh_version = gh_version_result.stdout.strip().splitlines()[0]  # ロックへ記録する検証ツールの版。
    api = "https://api.github.com/repos/openai/tunnel-client/releases/" + (f"tags/{tunnel_version}" if tunnel_version else "latest")  # リリース情報の取得先。
    release = json.loads(fetch_https(api, {"Accept": "application/vnd.github+json"}))
    assets = {asset["name"]: asset["browser_download_url"] for asset in release.get("assets", [])}  # 名前からURLへの対応。
    if "SHA256SUMS.txt" not in assets:
        raise BridgeError("Tunnel ClientのSHA256SUMS.txtがありません。")
    tunnel_sums = fetch_https(assets["SHA256SUMS.txt"]).decode("utf-8")  # 公開されたハッシュ一覧。
    bundle_names = sorted(name for name in assets if re.fullmatch(r"tunnel-client-v[^/]+-provenance\.sigstore\.json", name))
    if len(bundle_names) != 1 or not assets[bundle_names[0]].startswith(TUNNEL_DOWNLOAD_PREFIX):
        raise BridgeError("Tunnel Clientの来歴証明（*-provenance.sigstore.json）を一意に特定できません。")
    commit = json.loads(fetch_https(f"https://api.github.com/repos/openai/tunnel-client/commits/{release['tag_name']}", {"Accept": "application/vnd.github+json"}))
    source_digest = str(commit.get("sha") or "")  # タグが指すコミット。来歴証明のビルド元と照合する。
    if not re.fullmatch(r"[0-9a-f]{40}", source_digest):
        raise BridgeError(f"タグ {release['tag_name']} のコミットを特定できません。")
    source_ref = f"refs/tags/{release['tag_name']}"  # 来歴証明で要求するビルド元の参照。
    tunnel_assets: dict[str, dict[str, str]] = {}  # 固定するTunnel Clientのプラットフォーム別アセット。
    with tempfile.TemporaryDirectory(prefix="chatgpt-project-bridge-lock-") as temporary:
        bundle_data = fetch_https(assets[bundle_names[0]])  # 来歴証明の本文。
        bundle_path = Path(temporary) / bundle_names[0]
        bundle_path.write_bytes(bundle_data)
        for platform in ("windows-amd64", "linux-amd64", "linux-arm64"):
            pattern = re.compile(rf"^tunnel-client-v[^/]+-{re.escape(platform)}\.zip$")
            matches = sorted(name for name in assets if pattern.fullmatch(name))
            if len(matches) != 1:
                raise BridgeError(f"Tunnel Clientの {platform} アセットを一意に特定できません。")
            name = matches[0]
            url = assets[name]
            if not url.startswith(TUNNEL_DOWNLOAD_PREFIX):
                raise BridgeError(f"想定外の取得元です: {url}")
            data = fetch_https(url)  # アセットの本文。
            actual = hashlib.sha256(data).hexdigest()
            if published_sha256(tunnel_sums, name) != actual:
                raise BridgeError(f"Tunnel Clientの {platform} アセットのSHA-256が公開値と一致しません。")
            artifact = Path(temporary) / name
            artifact.write_bytes(data)
            assert_tunnel_provenance(gh, artifact, bundle_path, source_ref, source_digest)
            tunnel_assets[platform] = {"name": name, "url": url, "sha256": actual}
    tunnel_provenance = {
        "bundle": {"name": bundle_names[0], "url": assets[bundle_names[0]], "sha256": hashlib.sha256(bundle_data).hexdigest()},
        "repository": PROVENANCE_REPOSITORY,
        "signerWorkflow": PROVENANCE_WORKFLOW,
        "sourceRef": source_ref,
        "sourceDigest": source_digest,
        "predicateType": PROVENANCE_PREDICATE,
        "verifiedWith": gh_version,
    }  # ロックへ記録する来歴証明の検証条件。

    index = json.loads(fetch_https("https://nodejs.org/dist/index.json"))
    if node_version:
        candidates = [item for item in index if item.get("version") == node_version]
    else:
        candidates = [item for item in index if item.get("lts")]
    if not candidates or not candidates[0].get("lts"):
        raise BridgeError("Node.jsのLTS版を特定できません。--node-version にLTS版を指定してください。")
    node_tag = candidates[0]["version"]  # 固定するNode.jsの版。
    node_sums = fetch_https(f"https://nodejs.org/dist/{node_tag}/SHASUMS256.txt").decode("utf-8")  # 公開されたハッシュ一覧。
    node_assets: dict[str, dict[str, str]] = {}  # 固定するNode.jsのLinux向けアセット。
    for architecture in ("x64", "arm64"):
        name = f"node-{node_tag}-linux-{architecture}.tar.xz"
        url = f"https://nodejs.org/dist/{node_tag}/{name}"
        actual = hashlib.sha256(fetch_https(url)).hexdigest()
        if published_sha256(node_sums, name) != actual:
            raise BridgeError(f"Node.jsの linux-{architecture} アセットのSHA-256が公開値と一致しません。")
        node_assets[f"linux-{architecture}"] = {"name": name, "url": url, "sha256": actual}
    print(f"警告: Linuxではwingetを確認できないため、OpenJS.NodeJS.LTS {node_tag.lstrip('v')} の存在は確認していません。")

    previous = json.loads(LOCK_PATH.read_text(encoding="utf-8")) if LOCK_PATH.is_file() else None  # 更新前のロック。
    if LOCK_PATH.is_symlink():
        raise BridgeError(f"依存物ロックにシンボリックリンクは使用できません: {LOCK_PATH}")
    lock = {
        "schemaVersion": 1,
        "tunnelClient": {"version": release["tag_name"], "assets": tunnel_assets, "provenance": tunnel_provenance},
        "node": {"version": node_tag, "wingetVersion": node_tag.lstrip("v"), "assets": node_assets},
    }  # 書き込むロック内容。
    atomic_write_text(LOCK_PATH, json.dumps(lock, ensure_ascii=False, indent=2) + "\n")
    print(f"依存物ロックを更新しました: {LOCK_PATH}")
    print(f"  Tunnel Client: {(previous or {}).get('tunnelClient', {}).get('version', '(なし)')} -> {release['tag_name']}")
    for platform, asset in tunnel_assets.items():
        print(f"    {platform}: {asset['sha256']}")
    print(f"    来歴証明: 3アセットとも検証済み（{PROVENANCE_WORKFLOW}、{source_ref}、コミット {source_digest}、{gh_version}）")
    print(f"  Node.js: {(previous or {}).get('node', {}).get('version', '(なし)')} -> {node_tag}")
    for platform, asset in node_assets.items():
        print(f"    {platform}: {asset['sha256']}")
    print("差分を確認してからコミットし、export-bundleでBundleを作り直してください。")


# Windows版と対応する引数の定義を組み立てる。import しただけでは何も実行しない。
def build_parser() -> argparse.ArgumentParser:
    # allow_abbrev=False: --exposure のような省略形で別のオプション（--exposure-sha256 など）が効かないようにする。
    parser = argparse.ArgumentParser(description="Ubuntu向けChatGPT Project Bridge管理コマンド", allow_abbrev=False)
    parser.add_argument("action", nargs="?", help="init / configure-tunnel / save-key / update / test / doctor / start / status / add-project / approve / show-exposure / export-skill / export-bundle / update-lock / hub-add / hub-remove / hub-list / hub-start / hub-stop / hub-restart / hub-doctor / hub-status / hub-service-install / hub-service-uninstall / set-permission / hub-permissions")
    parser.add_argument("--action", "-Action", dest="action_option")
    parser.add_argument("--project-root", "-ProjectRoot", dest="project_root")
    parser.add_argument("--project-name", "-ProjectName", dest="project_name")
    parser.add_argument("--profile", "-Profile", dest="profile")
    parser.add_argument("--tunnel-id", "-TunnelId", dest="tunnel_id")
    parser.add_argument("--health-port", "-HealthPort", dest="health_port", type=int, default=0)
    parser.add_argument("--tunnel-client-path", "-TunnelClientPath", dest="tunnel_client_path")
    parser.add_argument("--output-path", "-OutputPath", dest="output_path")
    parser.add_argument("--force", "-Force", action="store_true")
    parser.add_argument("--no-browser", "-NoBrowser", action="store_true")
    parser.add_argument("--no-start", "-NoStart", action="store_true")
    parser.add_argument("--force-reconfigure", "-ForceReconfigure", action="store_true")
    parser.add_argument("--replace-key", "-ReplaceKey", action="store_true")
    parser.add_argument("--exposure-sha256", "-ExposureSha256", dest="exposure_sha256", help="非対話で承認するときの公開範囲の指紋")
    parser.add_argument("--signing-key", "-SigningKey", dest="signing_key", help="export-bundleでSHA256SUMS.txtへ署名するSSH秘密鍵")
    parser.add_argument("--tunnel-client-version", "-TunnelClientVersion", dest="tunnel_client_version", help="update-lockで固定するTunnel Clientのタグ")
    parser.add_argument("--node-version", "-NodeVersion", dest="node_version", help="update-lockで固定するNode.js LTSの版")
    parser.add_argument("--gh-path", "-GhPath", dest="gh_path", help="update-lockで来歴証明を検証するGitHub CLIのパス")
    parser.add_argument("--hub-name", "-HubName", dest="hub_name", help="hub-add / hub-remove で使う、ハブ内のプロジェクト名")
    parser.add_argument("--service", "-Service", action="store_true", help="hub-start / hub-restart を入力なしで実行する（自動起動用）")
    parser.add_argument("--no-enable", action="store_true", help="hub-service-install / uninstall でユニットファイルの書き込み・削除だけを行う")
    parser.add_argument("--source-read", "-SourceRead", dest="source_read", choices=("on", "off"), help="set-permission で、ChatGPT からのソースの読み取りを on（sourceText と paths を許可）/ off（sourceText を止める）にする")
    parser.add_argument("--claude-code", "-ClaudeCode", dest="claude_code", choices=("on", "off"), help="set-permission で、ChatGPT からの Claude Code の起動（claudeCode.enabled）を on / off にする")
    parser.add_argument("--allowed-command", "-AllowedCommand", dest="allowed_command", action="append", help="set-permission で、Claude Code に確認なしで実行させるコマンドのパターン（複数指定できる。指定すると一覧を置き換える）")
    return parser


# Actionを実行し、秘密値を含まないエラーだけを標準エラーへ返す。
def main() -> int:
    args = build_parser().parse_args()
    raw_action = args.action_option or args.action
    if not raw_action:
        raise BridgeError("Actionが必要です。--help で一覧を確認してください。")
    action = normalize_action(raw_action)
    if sys.platform != "linux" and action not in {"export-skill", "export-bundle", "update-lock"}:
        raise BridgeError("このコマンドはUbuntu/Linux専用です。Windowsでは project-bridge.ps1 を使用してください。")
    rootless = {"add-project", "export-skill", "export-bundle", "update-lock", "hub-add", "hub-remove", "hub-list", "hub-start", "hub-stop", "hub-restart", "hub-doctor", "hub-status", "hub-service-install", "hub-service-uninstall", "hub-permissions"}  # プロジェクトルートを先に解決しない操作。
    root = None if action in rootless else resolve_project_root(args.project_root)
    if action == "init":
        initialize_project(root, args.project_name, args.force)
        test_project(root)
    elif action == "configure-tunnel":
        configure_tunnel(root, args)
    elif action == "save-key":
        save_runtime_key(root, args.profile, replace_key=args.replace_key)
    elif action == "update":
        update_project_status(root)
    elif action == "test":
        test_project(root)
    elif action == "doctor":
        doctor(root, args)
    elif action == "start":
        start(root, args)
    elif action == "status":
        show_status(root)
    elif action == "add-project":
        add_project(args)
    elif action == "approve":
        config = read_config(root)
        confirm_exposure(root, resolve_profile(config, args.profile, root), args.exposure_sha256)
    elif action == "show-exposure":
        show_exposure(root, args.profile)
    elif action == "set-permission":
        set_permission(root, args)
    elif action == "hub-permissions":
        hub_permissions()
    elif action == "export-skill":
        export_skill(args.output_path, args.force)
    elif action == "export-bundle":
        export_bundle(args.output_path, args.force, args.signing_key)
    elif action == "update-lock":
        update_lock(args.tunnel_client_version, args.node_version, args.gh_path)
    elif action == "hub-add":
        hub_add(args)
    elif action == "hub-remove":
        hub_remove(args)
    elif action == "hub-list":
        hub_list()
    elif action == "hub-start":
        hub_start(args)
    elif action == "hub-stop":
        hub_stop(args)
    elif action == "hub-restart":
        hub_stop(args)
        hub_start(args)
    elif action == "hub-service-install":
        hub_service_install(args)
    elif action == "hub-service-uninstall":
        hub_service_uninstall(args)
    elif action == "hub-doctor":
        hub_doctor(args)
    elif action == "hub-status":
        hub = read_hub()
        if not hub.get("tunnelId"):
            raise BridgeError("ハブのTunnelが未設定です。先に hub-add を実行してください。")
        show_profile_status(hub["profileName"], hub.get("tunnelId"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BridgeError as error:
        # エラー文に含まれる設定値・パス由来の制御文字（ESC・OSCなど）を端末へそのまま出さない。複数行の文のため改行だけ残す。
        print(f"ERROR: {escape_forbidden(str(error), keep_newline=True)}", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as error:
        print(f"ERROR: 外部コマンドが失敗しました（終了コード {error.returncode}）。", file=sys.stderr)
        raise SystemExit(error.returncode or 1)
    except KeyboardInterrupt:
        print("\n中断しました。", file=sys.stderr)
        raise SystemExit(130)
