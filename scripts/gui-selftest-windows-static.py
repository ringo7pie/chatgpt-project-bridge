#!/usr/bin/env python3
"""Windows版GUI（project-bridge-gui.ps1）を、pwshもWindowsも使わずに静的に検査する。

この試験はps1を一度も実行しない。確かめられるのは、ソースの書き方・共有データとCLIとの整合・
引用関数・表示の無害化・承認ダイアログの中身を作る純粋関数のアルゴリズム（Pythonへ写した版）までで、画面の動作は確かめられない。
標準ライブラリだけを使い、どこへも書き込まない（project-bridge.py を参照実装として読み込むときも __pycache__ を作らない）。
"""

from __future__ import annotations

import importlib.util
import json
import random
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path


sys.dont_write_bytecode = True  # 参照実装として読み込む project-bridge.py の __pycache__ をリポジトリに作らない。

SCRIPT_ROOT = Path(__file__).resolve().parent  # 検査対象スクリプトの配置先。
SKILL_ROOT = SCRIPT_ROOT.parent  # Skillのルート。
GUI_PATH = SCRIPT_ROOT / "project-bridge-gui.ps1"  # 検査するWindows版GUI。
CLI_PATH = SCRIPT_ROOT / "project-bridge.ps1"  # GUIが呼ぶWindows版CLI。
PYTHON_CLI_PATH = SCRIPT_ROOT / "project-bridge.py"  # 共通仕様S2の参照実装 quote_for_display を持つUbuntu版CLI。
UBUNTU_GUI_PATH = SCRIPT_ROOT / "project-bridge-gui.py"  # ツールチップの折り返しの参照実装 wrap_display_text を持つUbuntu版GUI。
HELP_PATH = SKILL_ROOT / "assets" / "gui-help.ja.json"  # 両OSで共有する説明データ。
HEADER_LINES = 60  # 規約の宣言を探す先頭の行数（param ブロックの後ろ）。
TOOLTIP_LIMIT = 1000  # ツールチップ本文の上限文字数（ps1の $script:ToolTipMaxLength と同じ）。

# Get-Verb（PowerShell 7.4）の承認済み動詞。
APPROVED_VERBS = frozenset(
    """
    Add Approve Assert Backup Block Build Checkpoint Clear Close Compare Complete Compress Confirm Connect
    Convert ConvertFrom ConvertTo Copy Debug Deny Deploy Disable Disconnect Dismount Edit Enable Enter Exit
    Expand Export Find Format Get Grant Group Hide Import Initialize Install Invoke Join Limit Lock Measure
    Merge Mount Move New Open Optimize Out Ping Pop Protect Publish Push Read Receive Redo Register Remove
    Rename Repair Request Reset Resize Resolve Restart Restore Resume Revoke Save Search Select Send Set Show
    Skip Split Start Step Stop Submit Suspend Switch Sync Test Trace Unblock Undo Uninstall Unlock Unprotect
    Unpublish Unregister Update Use Wait Watch Write
    """.split()
)

# GUIのソースに現れてはいけない語。（説明, 正規表現）の組。
FORBIDDEN_PATTERNS = [
    ("-Verified（インストーラー専用）", re.compile(r"-Verified\b", re.IGNORECASE)),
    ("Read-Host（キーや確認をGUIで受けない）", re.compile(r"Read-Host", re.IGNORECASE)),
    ("SecureString（キーをGUIで扱わない）", re.compile(r"SecureString", re.IGNORECASE)),
    ("ConvertFrom-SecureString", re.compile(r"ConvertFrom-SecureString", re.IGNORECASE)),
    ("Invoke-Expression", re.compile(r"Invoke-Expression", re.IGNORECASE)),
    ("iex", re.compile(r"(?<![\w-])iex\s", re.IGNORECASE)),
    ("Write-Host（powershell.md 規約）", re.compile(r"Write-Host", re.IGNORECASE)),
    (".Arguments =（ArgumentList を使う）", re.compile(r"\.Arguments\s*=")),
    ("DPAPI（キーの保存はCLIの役目）", re.compile(r"DPAPI", re.IGNORECASE)),
    (".key.dpapi", re.compile(r"\.key\.dpapi", re.IGNORECASE)),
    ("出力イベント（Runspace の無いスレッドで動くため使わない）", re.compile(r"OutputDataReceived|ErrorDataReceived|BeginOutputReadLine|BeginErrorReadLine|Register-ObjectEvent", re.IGNORECASE)),
    ("-Command（文字列をコマンドとして実行しない）", re.compile(r"(?<![\w-])-Command\b", re.IGNORECASE)),
    ("-c（-Command の短縮形）", re.compile(r"(?<![\w-])-c(?=[\s'\"]|$)", re.IGNORECASE)),
    ("-EncodedCommand（-e・-ec・-enc を含む）", re.compile(r"(?<![\w-])-(?:EncodedCommand|enc|ec|e)(?=[\s'\"]|$)", re.IGNORECASE)),
    ("Invoke-Command", re.compile(r"Invoke-Command", re.IGNORECASE)),
    ("[scriptblock]::Create（文字列からコードを作らない）", re.compile(r"\[scriptblock\]::Create", re.IGNORECASE)),
    ("-Verb（RunAs などの昇格をしない）", re.compile(r"(?<![\w-])-Verb\b", re.IGNORECASE)),
    ("Invoke-WebRequest（通信しない）", re.compile(r"Invoke-WebRequest|\biwr\b", re.IGNORECASE)),
    ("Invoke-RestMethod（通信しない）", re.compile(r"Invoke-RestMethod|\birm\b", re.IGNORECASE)),
    ("HttpClient（通信しない）", re.compile(r"HttpClient", re.IGNORECASE)),
    ("WebClient（通信しない）", re.compile(r"WebClient", re.IGNORECASE)),
    ("-NoExit（別コンソールに対話プロンプトを残さない）", re.compile(r"-NoExit\b", re.IGNORECASE)),
    ("P/Invoke（Add-Type の型定義・DllImport を使わない）", re.compile(r"-TypeDefinition|-MemberDefinition|DllImport", re.IGNORECASE)),
]
# ファイル・フォルダーへ書く命令（GUI は 1 つも持たない。クリップボードへのコピーはファイルへの書き込みではないため対象外）。
WRITE_COMMANDS = [
    ("Set-Content", re.compile(r"Set-Content", re.IGNORECASE)),
    ("Add-Content", re.compile(r"Add-Content", re.IGNORECASE)),
    ("Out-File", re.compile(r"Out-File", re.IGNORECASE)),
    ("Tee-Object", re.compile(r"Tee-Object", re.IGNORECASE)),
    ("Copy-Item", re.compile(r"Copy-Item", re.IGNORECASE)),
    ("Move-Item", re.compile(r"Move-Item", re.IGNORECASE)),
    ("Remove-Item", re.compile(r"Remove-Item", re.IGNORECASE)),
    ("Rename-Item", re.compile(r"Rename-Item", re.IGNORECASE)),
    ("New-Item", re.compile(r"New-Item", re.IGNORECASE)),
    ("Set-Item", re.compile(r"Set-Item(?!Property)|Set-ItemProperty|New-ItemProperty", re.IGNORECASE)),
    ("Clear-Content", re.compile(r"Clear-Content", re.IGNORECASE)),
    ("Export-Csv / Export-Clixml", re.compile(r"Export-Csv|Export-Clixml", re.IGNORECASE)),
    ("[IO.File]::（書き込みを含む File の静的メソッド）", re.compile(r"\[(?:System\.)?IO\.(?:File|Directory)\]::", re.IGNORECASE)),
    ("WriteAll* / AppendAll*", re.compile(r"WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines", re.IGNORECASE)),
    ("StreamWriter / FileStream / CreateDirectory", re.compile(r"StreamWriter|FileStream|CreateDirectory|CreateText|OpenWrite", re.IGNORECASE)),
]


@dataclass
class StringToken:
    """ソース中の文字列リテラル1つ。"""

    line: int  # 始まりの行番号（1始まり）。
    kind: str  # single / double / here。
    content: str  # 中身（式展開の部分を除く）。


@dataclass
class LexResult:
    """簡易字句解析の結果。"""

    code: str  # 文字列とコメントを空白にしたソース（位置と改行は元のまま）。
    expandable: str  # コメントと単一引用符の文字列だけを空白にしたソース（変数名の検査用）。
    strings: list[StringToken] = field(default_factory=list)  # 文字列リテラル。
    error: str = ""  # 字句解析で見つけた問題。


@dataclass
class Report:
    """試験項目の結果を集める。"""

    failures: int = 0  # 失敗した項目の数。

    def check(self, name: str, problems: list[str]) -> None:
        if problems:
            self.failures += 1
            print(f"FAIL {name}: {problems[0]}")
            for problem in problems[1:]:
                print(f"    {problem}")
        else:
            print(f"PASS {name}")


# 位置から行番号（1始まり）を求める。
def line_of(text: str, position: int) -> int:
    return text.count("\n", 0, position) + 1


# PowerShellのソースを、文字列・コメント・here-string・式展開（$()）だけを見分ける簡易字句解析にかける。
def lex_powershell(source: str) -> LexResult:
    length = len(source)
    code = list(source)
    expandable = list(source)
    strings: list[StringToken] = []

    def blank(start: int, end: int, also_expandable: bool) -> None:
        for index in range(start, min(end, length)):
            if source[index] != "\n":
                code[index] = " "
                if also_expandable:
                    expandable[index] = " "

    modes: list[list] = [["code", 0]]  # モードの積み重ね。["sub", 括弧の深さ] は文字列中の $() を表す。
    string_starts: list[tuple[int, str, list[str]]] = []  # 二重引用符・here-stringの開始位置・種類・中身。
    position = 0
    while position < length:
        mode = modes[-1]
        character = source[position]
        following = source[position + 1] if position + 1 < length else ""
        if mode[0] in ("code", "sub"):
            if character == "<" and following == "#":
                end = source.find("#>", position + 2)
                if end < 0:
                    return LexResult("".join(code), "".join(expandable), strings, f"閉じていないブロックコメント（{line_of(source, position)} 行）")
                blank(position, end + 2, True)
                position = end + 2
                continue
            if character == "#":
                end = source.find("\n", position)
                end = length if end < 0 else end
                blank(position, end, True)
                position = end
                continue
            if character == "`":
                position += 2
                continue
            if character == "@" and following in ("'", '"') and source[position + 2 : position + 3] in ("\n", "\r"):
                terminator = "\n" + following + "@"
                end = source.find(terminator, position + 2)
                if end < 0:
                    return LexResult("".join(code), "".join(expandable), strings, f"閉じていない here-string（{line_of(source, position)} 行）")
                strings.append(StringToken(line_of(source, position), "here", source[position + 2 : end]))
                blank(position, end + len(terminator), following == "'")
                position = end + len(terminator)
                continue
            if character == "'":
                cursor = position + 1
                content: list[str] = []
                while True:
                    if cursor >= length:
                        return LexResult("".join(code), "".join(expandable), strings, f"閉じていない単一引用符の文字列（{line_of(source, position)} 行）")
                    if source[cursor] == "'":
                        if source[cursor + 1 : cursor + 2] == "'":
                            content.append("'")
                            cursor += 2
                            continue
                        break
                    content.append(source[cursor])
                    cursor += 1
                strings.append(StringToken(line_of(source, position), "single", "".join(content)))
                blank(position, cursor + 1, True)
                position = cursor + 1
                continue
            if character == '"':
                modes.append(["dq", 0])
                string_starts.append((position, "double", []))
                blank(position, position + 1, False)
                position += 1
                continue
            if mode[0] == "sub":
                if character == "(":
                    mode[1] += 1
                elif character == ")":
                    mode[1] -= 1
                    if mode[1] == 0:
                        modes.pop()
                        position += 1
                        continue
            position += 1
            continue
        # 二重引用符の文字列の中。
        if character == "`":
            blank(position, position + 2, False)
            if string_starts:
                string_starts[-1][2].append(source[position : position + 2])
            position += 2
            continue
        if character == "$" and following == "(":
            blank(position, position + 1, False)
            modes.append(["sub", 1])
            position += 2
            continue
        if character == '"':
            if following == '"':
                blank(position, position + 2, False)
                string_starts[-1][2].append('"')
                position += 2
                continue
            start, kind, content_parts = string_starts.pop()
            strings.append(StringToken(line_of(source, start), kind, "".join(content_parts)))
            blank(position, position + 1, False)
            modes.pop()
            position += 1
            continue
        blank(position, position + 1, False)
        string_starts[-1][2].append(character)
        position += 1
    if len(modes) != 1:
        return LexResult("".join(code), "".join(expandable), strings, f"閉じていない文字列か式展開（モード {modes[-1][0]}）")
    return LexResult("".join(code), "".join(expandable), strings)


# 括弧の対応を調べ、問題を行番号つきで返す。
def bracket_problems(code: str) -> list[str]:
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[tuple[str, int]] = []
    problems: list[str] = []
    for position, character in enumerate(code):
        if character in "([{":
            stack.append((character, position))
        elif character in ")]}":
            if not stack or stack[-1][0] != pairs[character]:
                problems.append(f"{line_of(code, position)} 行の '{character}' に対応する開き括弧がありません")
                return problems
            stack.pop()
    for character, position in stack:
        problems.append(f"{line_of(code, position)} 行の '{character}' が閉じていません")
    return problems


# 関数定義（function Name { ... }）の名前と、本体の範囲（codeの位置）を返す。
def function_ranges(code: str) -> dict[str, tuple[int, int]]:
    ranges: dict[str, tuple[int, int]] = {}
    for match in re.finditer(r"(?m)^\s*function\s+([A-Za-z][\w-]*)\s*\{", code):
        depth = 0
        for position in range(match.end() - 1, len(code)):
            if code[position] == "{":
                depth += 1
            elif code[position] == "}":
                depth -= 1
                if depth == 0:
                    ranges[match.group(1)] = (match.start(), position + 1)
                    break
    return ranges


# 位置を含む関数の名前を返す。関数の外なら空文字。
def enclosing_function(ranges: dict[str, tuple[int, int]], position: int) -> str:
    for name, (start, end) in ranges.items():
        if start <= position < end:
            return name
    return ""


# ps1の「$script:名前 = @('a', 'b')」の文字列配列を読む。
def read_script_array(source: str, name: str) -> list[str]:
    match = re.search(r"\$script:" + re.escape(name) + r"\s*=\s*@\(([^)]*)\)", source)
    if match is None:
        return []
    return re.findall(r"'([^']*)'", match.group(1))


# CLIのparamブロックから、パラメーター名とActionのValidateSetを読む。
def read_cli_parameters(cli_source: str) -> tuple[set[str], list[str]]:
    start = cli_source.find("[CmdletBinding()]\nparam(")
    if start < 0:
        start = cli_source.find("param(")
    block_start = cli_source.find("(", cli_source.find("param(", start))
    depth = 0
    block_end = block_start
    for position in range(block_start, len(cli_source)):
        if cli_source[position] == "(":
            depth += 1
        elif cli_source[position] == ")":
            depth -= 1
            if depth == 0:
                block_end = position
                break
    block = cli_source[block_start : block_end + 1]
    names = set(re.findall(r"\]\s*\$([A-Za-z][A-Za-z0-9]*)", block))
    validate = re.search(r"ValidateSet\(([^)]*)\)", block)
    actions = re.findall(r"'([^']*)'", validate.group(1)) if validate else []
    return names, actions


# ps1の ConvertTo-PascalName をPythonへ写した版（- で区切った各語の先頭1文字だけを大文字にして連結する）。
def pascal_name(name: str) -> str:
    return "".join(word[:1].upper() + word[1:] for word in name.split("-") if word)


# ps1の Test-PlatformOption をPythonへ写した版。platformOnly に載っていなければ両OSで出し、載っていれば値が同じOSのときだけ出す。
def platform_option_allowed(action: dict, option: str, platform: str = "windows") -> bool:
    platform_only = action.get("platformOnly") or {}
    if option not in platform_only:
        return True
    return platform_only[option] == platform


# ps1の Test-DashLeadingValue をPythonへ写した版。先頭の半角空白・タブ・全角空白を飛ばし、最初の文字がダッシュ類かを見る。
DASH_CHARACTERS = {"-", "\u2013", "\u2014", "\u2015"}  # ps1の $script:DashCharacters と同じ文字。


def dash_leading(value: str) -> bool:
    if not value:
        return False
    trimmed = value.lstrip(" \t\u3000")
    if not trimmed:
        return False
    return trimmed[0] in DASH_CHARACTERS


# ps1の Test-RunButtonEnabled をPythonへ写した版。
def run_button_enabled(action: str, busy: bool, foreground_running: bool, auxiliary_running: bool, auxiliary: set[str]) -> bool:
    is_auxiliary = action in auxiliary
    if is_auxiliary and auxiliary_running:
        return False
    if not busy:
        return True
    return is_auxiliary and foreground_running


# ps1の ConvertTo-QuotedArgument をPythonへ写した版。
def quote_argument(argument: str) -> str:
    if argument and not any(character in argument for character in " \t\""):
        return argument
    result = ['"']
    backslash_count = 0
    for character in argument:
        if character == "\\":
            backslash_count += 1
            continue
        if character == '"':
            result.append("\\" * (backslash_count * 2 + 1))
            result.append('"')
        else:
            result.append("\\" * backslash_count)
            result.append(character)
        backslash_count = 0
    result.append("\\" * (backslash_count * 2))
    result.append('"')
    return "".join(result)


# Windowsのコマンドライン規則（CommandLineToArgvW / MSVC CRT。プログラム名より後ろ）で、1つの文字列を引数配列へ戻す。
def split_windows_command_line(command_line: str) -> list[str]:
    arguments: list[str] = []
    position = 0
    length = len(command_line)
    while True:
        while position < length and command_line[position] in " \t":
            position += 1
        if position >= length:
            return arguments
        current: list[str] = []
        in_quotes = False
        while position < length:
            character = command_line[position]
            if character == "\\":
                cursor = position
                while cursor < length and command_line[cursor] == "\\":
                    cursor += 1
                count = cursor - position
                if cursor < length and command_line[cursor] == '"':
                    current.append("\\" * (count // 2))
                    if count % 2 == 1:
                        current.append('"')
                        position = cursor + 1
                    else:
                        position = cursor
                else:
                    current.append("\\" * count)
                    position = cursor
                continue
            if character == '"':
                if in_quotes and position + 1 < length and command_line[position + 1] == '"':
                    current.append('"')
                    position += 2
                    continue
                in_quotes = not in_quotes
                position += 1
                continue
            if character in " \t" and not in_quotes:
                break
            current.append(character)
            position += 1
        arguments.append("".join(current))


# ps1の Get-ActionToolTipText（GuiNote なし）をPythonへ写した版。上限で切る前の長さも返す。
def action_tooltip(action: dict) -> tuple[str, int]:
    lines: list[str] = []
    if action.get("summary"):
        lines += [str(action["summary"]), ""]
    for key, heading in (("when", "【いつ使う】"), ("requires", "【事前に必要】"), ("effect", "【実行すると】"), ("next", "【次にすること】"), ("caution", "【注意】")):
        if action.get(key):
            lines.append(heading + str(action[key]))
    while lines and lines[-1] == "":
        lines.pop()
    text = "\r\n".join(lines)
    return limit_tooltip(text), len(text)


# ps1の Get-OptionToolTipText（GuiNote なし）をPythonへ写した版。
def option_tooltip(option: dict) -> tuple[str, int]:
    lines: list[str] = []
    if option.get("summary"):
        lines.append(str(option["summary"]))
    for key, heading in (("example", "【入力例】"), ("default", "【既定】"), ("caution", "【注意】")):
        if option.get(key):
            lines.append(heading + str(option[key]))
    text = "\r\n".join(lines)
    return limit_tooltip(text), len(text)


# ps1の Limit-ToolTipText をPythonへ写した版。
def limit_tooltip(text: str, ellipsis: str = "…（続きは README・マニュアル）") -> str:
    if len(text) <= TOOLTIP_LIMIT:
        return text
    return text[: max(TOOLTIP_LIMIT - len(ellipsis), 0)].rstrip() + ellipsis


# ---------------------------------------------------------------------------
# 共通仕様 S1・S2 の参照実装と、ps1 の表示の無害化を Python へ写した版
# ---------------------------------------------------------------------------

FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})  # 共通仕様 S1 の禁止文字の一般カテゴリ。
PS_FORBIDDEN_CATEGORY_NAMES = frozenset({"Control", "Format", "LineSeparator", "ParagraphSeparator", "Surrogate"})  # S1 に対応する .NET の UnicodeCategory の名前。

# 共通仕様 S2 の試験ベクトル（入力, 期待する出力）。
# 規則の本文が正で、表は規則の例（S1 の禁止文字と U+0020 以外の Zs は、引用符の中で \u + 小文字 16 進 4 桁のテキストになる）。
# ソースには生の特殊文字を書かず、入力は chr() で組み立てる（ツールの変換で生の文字が入らないようにするため）。
S2_VECTORS = [
    ("README.md", '"README.md"'),
    ('a"b', '"a\\"b"'),
    ("a\\b", '"a\\\\b"'),
    ("x" + chr(0x0A) + "y", '"x\\u000ay"'),
    ("a" + chr(0x2028) + "b", '"a\\u2028b"'),
    ("a" + chr(0x202E) + "b", '"a\\u202eb"'),
    ("a" + chr(0x3000) + "b", '"a\\u3000b"'),
    ("a" + chr(0x09) + "b", '"a\\u0009b"'),
    ("日本語 a b", '"日本語 a b"'),
    (chr(0x1F600), '"' + chr(0x1F600) + '"'),
    (chr(0xE0041), '"\\U000e0041"'),
    ("", '""'),
]


# 共通仕様 S2 を本文の規則どおりに書いた参照実装（project-bridge.py が読めないときに使う）。
def builtin_quote_for_display(value: str) -> str:
    pieces = ['"']
    for character in value:
        category = unicodedata.category(character)
        if character == "\\":
            pieces.append("\\\\")
        elif character == '"':
            pieces.append('\\"')
        elif category in FORBIDDEN_CATEGORIES or (category == "Zs" and character != " "):
            code = ord(character)
            pieces.append(f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}")
        else:
            pieces.append(character)
    pieces.append('"')
    return "".join(pieces)


# 共通仕様 S1 を本文の規則どおりに書いた参照実装。
def builtin_has_forbidden_character(value: str) -> bool:
    return any(unicodedata.category(character) in FORBIDDEN_CATEGORIES for character in value)


# project-bridge.py の quote_for_display・has_forbidden_character を読み込む。読めなければ、この試験の参照実装を使う。
def load_reference_functions() -> tuple[object, object, str]:
    try:
        spec = importlib.util.spec_from_file_location("project_bridge_cli_reference", PYTHON_CLI_PATH)
        if spec is None or spec.loader is None:
            raise ImportError("spec を作れません")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        quote = getattr(module, "quote_for_display")
        forbidden = getattr(module, "has_forbidden_character")
        return quote, forbidden, "project-bridge.py の quote_for_display・has_forbidden_character"
    except Exception as error:  # 読み込めない理由は表示だけして、規則を直接書いた参照実装へ切り替える。
        return builtin_quote_for_display, builtin_has_forbidden_character, f"試験内の参照実装（project-bridge.py を読めません: {type(error).__name__}）"


# project-bridge-gui.py（Ubuntu 版 GUI。GTK はこの読み込みでは読み込まれない）を読み込む。読めなければ (None, 理由)。
def load_ubuntu_gui() -> tuple[object | None, str]:
    try:
        spec = importlib.util.spec_from_file_location("project_bridge_gui_reference", UBUNTU_GUI_PATH)
        if spec is None or spec.loader is None:
            raise ImportError("spec を作れません")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # dataclass が型注釈を解くときにモジュールを引くため、先に登録する。
        spec.loader.exec_module(module)
        return module, ""
    except Exception as error:  # 読み込めない理由は表示だけして、試験内の写しへ切り替える。
        return None, f"{type(error).__name__}: {error}"


# 文字列を UTF-16 の符号単位の列にする（.NET の string と同じ並び。対にならないサロゲートも 1 単位）。
def utf16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[index : index + 2], "little") for index in range(0, len(data), 2)]


# UTF-16 の符号単位の列を文字列へ戻す。
def units_to_text(units: list[int]) -> str:
    return b"".join(unit.to_bytes(2, "little") for unit in units).decode("utf-16-le", "surrogatepass")


# ps1 の走査（IsSurrogatePair・ConvertToUtf32）を写したもの。（コードポイント, 単位数）を順に返す。
def ps_code_points(text: str) -> list[tuple[int, int]]:
    units = utf16_units(text)
    result = []
    index = 0
    while index < len(units):
        unit = units[index]
        if 0xD800 <= unit <= 0xDBFF and index + 1 < len(units) and 0xDC00 <= units[index + 1] <= 0xDFFF:
            result.append((0x10000 + ((unit - 0xD800) << 10) + (units[index + 1] - 0xDC00), 2))
            index += 2
        else:
            result.append((unit, 1))
            index += 1
    return result


# ps1 の Format-EscapedText を Python へ写した版（Style は Quote・Plain・Log）。
def ps_format_escaped(text: str, style: str) -> str:
    pieces = ['"'] if style == "Quote" else []
    for code_point, _width in ps_code_points(text):
        category = unicodedata.category(chr(code_point))
        forbidden = category in FORBIDDEN_CATEGORIES
        other_space = category == "Zs" and code_point != 0x20
        if style == "Quote" and code_point == 0x5C:
            pieces.append("\\\\")
        elif style == "Quote" and code_point == 0x22:
            pieces.append('\\"')
        elif forbidden or (style != "Log" and other_space):
            if style == "Log" and code_point <= 0xFF:
                pieces.append(f"\\x{code_point:02x}")
            elif code_point <= 0xFFFF:
                pieces.append(f"\\u{code_point:04x}")
            else:
                pieces.append(f"\\U{code_point:08x}")
        else:
            pieces.append(chr(code_point))
    if style == "Quote":
        pieces.append('"')
    return "".join(pieces)


# ps1 の ConvertTo-DisplayQuoted を写した版。
def ps_quote(text: str) -> str:
    return ps_format_escaped(text, "Quote")


# ps1 の Test-ForbiddenCharacter を写した版。
def ps_has_forbidden(text: str) -> bool:
    return any(unicodedata.category(chr(code_point)) in FORBIDDEN_CATEGORIES for code_point, _width in ps_code_points(text))


# ps1 の Test-MixedScriptText の文字種の範囲を写した版（L: ラテン文字、C: キリル文字、G: ギリシャ文字、空: それ以外）。
def ps_script_class(code: int) -> str:
    if 0x41 <= code <= 0x5A or 0x61 <= code <= 0x7A or (0xC0 <= code <= 0x2AF and code not in (0xD7, 0xF7)) or 0x1E00 <= code <= 0x1EFF or 0x2C60 <= code <= 0x2C7F or 0xA720 <= code <= 0xA7FF:
        return "L"
    if 0x400 <= code <= 0x52F or 0x1C80 <= code <= 0x1C8F or 0xA640 <= code <= 0xA69F:
        return "C"
    if 0x370 <= code <= 0x3FF or 0x1F00 <= code <= 0x1FFF:
        return "G"
    return ""


# ps1 の Test-MixedScriptText を写した版。
def ps_mixed_script(text: str) -> bool:
    if not text:
        return False
    for segment in re.split(r"[/\\]", text):
        classes = {ps_script_class(code) for code in utf16_units(segment)}
        if "L" in classes and ("C" in classes or "G" in classes):
            return True
    return False


MIXED_SCRIPT_MARK = "  ⚠ 混在した文字種"  # ps1 の $script:MixedScriptMark と同じ印。
CONTINUATION_MARK = "      （続き）"  # ps1 の $script:ContinuationMark と同じ印。
DISPLAY_LINE_WIDTH = 200  # ps1 の $script:DisplayLineWidth と同じ幅。
CLI_OUTPUT_MARK = "│ "  # ps1 の $script:CliOutputMark と同じ印。


# ps1 の Format-DisplayValue を写した版。
def ps_display_value(text: str, suffix: str = "") -> str:
    display = ps_quote(text) + suffix
    if ps_mixed_script(text):
        display += MIXED_SCRIPT_MARK
    return display


# ps1 の Split-DisplayLine を写した版（UTF-16 の単位で数える）。
def ps_split_display(text: str, width: int = DISPLAY_LINE_WIDTH) -> list[str]:
    width = max(width, 2)
    units = utf16_units(text)
    if len(units) <= width:
        return [text]
    pieces: list[str] = []
    position = 0
    while position < len(units):
        length = min(width, len(units) - position)
        if position + length < len(units) and 0xD800 <= units[position + length - 1] <= 0xDBFF:
            length -= 1
        piece = units_to_text(units[position : position + length])
        pieces.append(piece if not pieces else CONTINUATION_MARK + piece)
        position += length
    return pieces


# ps1 の Get-EntryValue・Get-EntryList・Get-EntryText・Test-EntryNotFalse を写した版（JSON を読んだ dict と list が対象）。
def entry_value(entry: object, name: str) -> object:
    if isinstance(entry, dict) and name in entry:
        return entry[name]
    return None


def entry_list(entry: object, name: str) -> list:
    value = entry_value(entry, name)
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def ps_string(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "True" if value else "False"
    return str(value)


def entry_text(entry: object, name: str) -> str:
    return ps_string(entry_value(entry, name))


def entry_not_false(entry: object, name: str) -> bool:
    value = entry_value(entry, name)
    return not (isinstance(value, bool) and value is False)


# ps1 の Test-ExposureApproved を写した版。
def ps_exposure_approved(report: dict) -> bool:
    state = entry_value(report, "approvalState")
    approved = entry_value(report, "approvedSha256")
    current = entry_value(report, "exposureSha256")
    if not isinstance(state, str) or state != "approved":
        return False
    if not isinstance(approved, str) or not isinstance(current, str):
        return False
    return approved == current


# ps1 の Get-ExposureRootValue を写した版。
def ps_exposure_root(report: dict) -> str:
    root = entry_value(entry_value(report, "exposure"), "projectRoot")
    if isinstance(root, str):
        return root
    return entry_text(report, "projectRoot")


# .NET の StringComparison.OrdinalIgnoreCase を写したもの（1 文字ずつ、単純な大文字化で 1 文字になるものだけを大文字にして比べる。正規化はしない）。
def ordinal_ignore_case_key(text: str) -> str:
    return "".join(character.upper() if len(character.upper()) == 1 else character for character in text)


# ps1 の Test-ForeignApprovalOverwrite を写した版。
def ps_foreign_overwrite(report: dict) -> bool:
    if entry_text(report, "approvalState") != "changed":
        return False
    approved_root = entry_value(report, "approvedProjectRoot")
    if approved_root is None:
        return False
    if not isinstance(approved_root, str):
        return True
    current = [value for value in (entry_value(report, "projectRoot"), entry_value(entry_value(report, "exposure"), "projectRoot")) if isinstance(value, str)]
    # ps1 は [string]::Equals(…, OrdinalIgnoreCase)（大文字小文字だけの違いは同じ。Windows の NTFS は通常、大文字小文字を区別しないため）。
    # カルチャの比較（-inotcontains）は NFC と NFD・ゼロ幅文字・ケルビン記号を同じと見なすため使わない。
    return ordinal_ignore_case_key(approved_root) not in [ordinal_ignore_case_key(value) for value in current]


# ps1 の Get-ApprovalRootText を写した版。
def ps_root_text(report: dict) -> str:
    root = ps_exposure_root(report)
    text = "プロジェクトルート: " + ps_display_value(root)
    cli_root = entry_value(report, "projectRoot")
    if isinstance(cli_root, str) and cli_root != root:
        text += "（CLI が示したフォルダー: " + ps_quote(cli_root) + "）"
    return text


KNOWN_EXPOSURE_FIELDS = ("schemaVersion", "projectRoot", "contextFile", "statusFile", "allowFiles", "allowDirectories", "denyDirectories", "maxDocumentBytes", "gitExposure", "detailExposure", "sourceScope", "claudeCode")  # ps1 の $script:KnownExposureFields と同じ欄。


# ps1 の Get-ExposureShapeProblem を写した版。
def ps_shape_problems(report: dict) -> list[str]:
    exposure = entry_value(report, "exposure")
    if not isinstance(exposure, dict):
        return ["公開範囲（exposure）"]
    problems: list[str] = []

    def label(name: str) -> str:
        return EXPOSURE_FIELD_LABELS[name] + "（" + name + "）"

    for name in ("projectRoot", "contextFile", "statusFile"):
        if not isinstance(exposure.get(name), str):
            problems.append(label(name))
    for name in ("allowFiles", "denyDirectories"):
        value = exposure.get(name)
        if not (isinstance(value, list) and all(isinstance(item, str) for item in value)):
            problems.append(label(name))
    directories = exposure.get("allowDirectories")
    if not (isinstance(directories, list) and all(isinstance(rule, dict) and isinstance(rule.get("path"), str) and isinstance(rule.get("recursive"), bool) for rule in directories)):
        problems.append(label("allowDirectories"))
    limit = exposure.get("maxDocumentBytes")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0 or limit > 2**63 - 1:
        problems.append(label("maxDocumentBytes"))
    git = exposure.get("gitExposure")
    if not (isinstance(git, dict) and isinstance(git.get("paths"), bool) and isinstance(git.get("commitSubjects"), bool)):
        problems.append(label("gitExposure"))
    # 2.5.0 の詳細取得ツールの公開設定。省略（null も含む）されていれば検査しない（ps1 の Get-EntryValue と同じ）。
    detail = exposure.get("detailExposure")
    if detail is not None:
        detail_valid = isinstance(detail, dict) and all(isinstance(detail.get(name), bool) for name in ("sourceText", "branchNames", "diffExcerpts"))
        if not detail_valid:
            problems.append(label("detailExposure"))
    return problems


# ps1 の Get-ApprovalBlockReason を写した版。
def ps_block_reasons(forbidden: list[str], shape: list[str]) -> list[str]:
    reasons: list[str] = []
    if forbidden:
        shown = min(3, len(forbidden))
        reason = "設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。該当項目: " + "、".join(forbidden[:shown])
        if len(forbidden) > shown:
            reason += f"、ほか {len(forbidden) - shown} 件（全件は一覧の先頭）"
        reasons.append(reason)
    if shape:
        reasons.append("公開範囲の形式が想定と違うため承認できません（件数を構造から確かめられません）。該当する欄: " + "、".join(shape))
    return reasons


# ps1 の Add-ForbiddenField・Get-ForbiddenFieldList を写した版。
def ps_forbidden_fields(report: dict) -> list[str]:
    found: list[str] = []

    def walk(value: object, path: str, depth: int) -> None:
        if value is None:
            return
        if depth > 16:
            found.append(path + "（入れ子が深すぎるため確かめられません）")
            return
        if isinstance(value, str):
            if ps_has_forbidden(value):
                found.append(path + " = " + ps_quote(value))
            return
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = path + "." + ps_format_escaped(str(key), "Plain")
                if ps_has_forbidden(str(key)):
                    found.append(child_path + "（項目名）")
                walk(child, child_path, depth + 1)
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, path + "[" + str(index) + "]", depth + 1)

    for name in ("projectRoot", "profile", "exposure", "changes"):
        if isinstance(report, dict) and name in report:
            walk(report[name], name, 0)
    return found


# ps1 の Get-ApprovalSummary を写した版。
def ps_summary(report: dict) -> dict:
    exposure = entry_value(report, "exposure")
    files = entry_list(exposure, "allowFiles")
    directories = entry_list(exposure, "allowDirectories")
    recursive = sum(1 for rule in directories if entry_not_false(rule, "recursive"))
    denied = entry_list(exposure, "denyDirectories")
    git = entry_value(exposure, "gitExposure")
    paths_public = entry_not_false(git, "paths")
    subjects_public = entry_not_false(git, "commitSubjects")
    limit_text = ps_string(entry_value(exposure, "maxDocumentBytes"))
    if not re.fullmatch(r"[0-9]{1,12}", limit_text):
        limit_text = ps_quote(limit_text)
    return {
        "AllowFileCount": len(files),
        "AllowDirectoryCount": len(directories),
        "RecursiveDirectoryCount": recursive,
        "DenyDirectoryCount": len(denied),
        "GitPathsPublic": paths_public,
        "GitCommitSubjectsPublic": subjects_public,
        "CountLine": f"公開ファイル {len(files)} 件 / 公開ディレクトリ {len(directories)} 件（うち配下すべて {recursive} 件） / 拒否ディレクトリ {len(denied)} 件",
        "GitPathsText": "Git のファイル名: " + ("公開" if paths_public else "非公開"),
        "GitCommitSubjectsText": "Git のコミット件名: " + ("公開" if subjects_public else "非公開"),
        "LimitLine": f"文書 1 件の上限: {limit_text} バイト",
        "ShaLine": "公開範囲の指紋（SHA-256）: " + entry_text(report, "exposureSha256"),
    }


EXPOSURE_FIELD_LABELS = {
    "projectRoot": "プロジェクトルート",
    "contextFile": "概要文書",
    "statusFile": "状態文書",
    "allowFiles": "公開ファイル",
    "allowDirectories": "公開ディレクトリ",
    "denyDirectories": "拒否ディレクトリ",
    "maxDocumentBytes": "文書 1 件の上限",
    "gitExposure": "Git の公開設定",
    "detailExposure": "詳細取得ツールの公開設定",
    "sourceScope": "ソース読み取り範囲の公開設定",
    "claudeCode": "Claude Code のジョブ",
}  # ps1 の Get-ExposureFieldLabel と同じ対応（Ubuntu 版の CHANGE_LABELS とも同じ）。


# ps1 の Get-ExposureChangeText を写した版。
def ps_change_text(change: str) -> str:
    match = re.fullmatch(r"([A-Za-z]+): (.*)", change, re.DOTALL)
    if match is None:
        return "内容: " + ps_format_escaped(change, "Plain")
    label = EXPOSURE_FIELD_LABELS.get(match.group(1), "") or "不明な項目"
    return label + "（" + match.group(1) + "）: " + ps_format_escaped(match.group(2), "Plain")


# ps1 の Get-ApprovalDetailLine を写した版。
def ps_detail_lines(report: dict, forbidden: list[str], shape: list[str] | None = None) -> list[str]:
    exposure = entry_value(report, "exposure")
    lines: list[str] = []
    if forbidden:
        lines.append(f"【承認できない項目】{len(forbidden)} 件（制御文字・行区切り・双方向制御文字・不可視文字を含むため、偽装の可能性があります）")
        lines += [f"  {number}. {field_text}" for number, field_text in enumerate(forbidden, start=1)]
        lines.append("")
    if shape:
        lines.append(f"【形式が想定と違う欄】{len(shape)} 件（件数を構造から確かめられないため、承認できません）")
        lines += [f"  {number}. {problem}" for number, problem in enumerate(shape, start=1)]
        lines.append("")
    if entry_text(report, "approvalState") == "changed":
        changes = entry_list(report, "changes")
        lines.append(f"【前回の承認から変わった項目】{len(changes)} 件")
        if not changes:
            lines.append("  （差分を取得できませんでした。全項目を確認してください）")
        lines += [f"  {number}. " + ps_change_text(ps_string(change)) for number, change in enumerate(changes, start=1)]
        lines.append("")
    lines.append("【対象】")
    lines.append("  " + ps_root_text(report))
    lines.append("  プロファイル（承認の保存先の名前）: " + ps_display_value(entry_text(report, "profile")))
    lines.append("  概要文書（contextFile）: " + ps_display_value(entry_text(exposure, "contextFile")))
    lines.append("  状態文書（statusFile）: " + ps_display_value(entry_text(exposure, "statusFile")))
    lines.append("")
    files = entry_list(exposure, "allowFiles")
    lines.append(f"【公開ファイル】{len(files)} 件")
    if not files:
        lines.append("  （なし）")
    lines += [f"  {number}. " + ps_display_value(ps_string(item)) for number, item in enumerate(files, start=1)]
    lines.append("")
    directories = entry_list(exposure, "allowDirectories")
    lines.append(f"【公開ディレクトリ（Markdown だけ）】{len(directories)} 件")
    if not directories:
        lines.append("  （なし）")
    for number, rule in enumerate(directories, start=1):
        scope = "（配下すべて）" if entry_not_false(rule, "recursive") else "（直下だけ）"
        lines.append(f"  {number}. " + ps_display_value(entry_text(rule, "path"), scope))
    lines.append("")
    denied = entry_list(exposure, "denyDirectories")
    lines.append(f"【拒否ディレクトリ】{len(denied)} 件")
    if not denied:
        lines.append("  （なし）")
    lines += [f"  {number}. " + ps_display_value(ps_string(item)) for number, item in enumerate(denied, start=1)]
    lines.append("")
    detail_exposure = entry_value(exposure, "detailExposure")
    if isinstance(detail_exposure, dict):
        lines.append("【詳細取得ツールの公開設定】")
        lines.append("  ソースの本文（sourceText）: " + ("公開" if entry_not_false(detail_exposure, "sourceText") else "非公開"))
        lines.append("  差分の抜粋（diffExcerpts）: " + ("公開" if entry_not_false(detail_exposure, "diffExcerpts") else "非公開"))
        lines.append("  ブランチ名（branchNames）: " + ("公開" if entry_not_false(detail_exposure, "branchNames") else "非公開"))
        lines.append("")
    extra = [name for name in exposure if name not in KNOWN_EXPOSURE_FIELDS] if isinstance(exposure, dict) else []
    if extra:
        lines.append(f"【その他の項目】{len(extra)} 件")
        # ConvertTo-Json -Compress の表記は、この試験で使う単純な値（数・文字列・真偽値）では json.dumps と同じになる。
        lines += ["  - " + ps_format_escaped(name, "Plain") + ": " + ps_format_escaped(json.dumps(exposure[name], ensure_ascii=False, separators=(",", ":")), "Plain") for name in extra]
        lines.append("")
    summary = ps_summary(report)
    lines.append("【Git と文書の上限】")
    lines.append("  " + summary["GitPathsText"] + " / " + summary["GitCommitSubjectsText"])
    lines.append("  " + summary["LimitLine"])
    lines.append("")
    lines.append("【公開範囲の指紋（SHA-256）】")
    lines.append("  " + entry_text(report, "exposureSha256"))
    lines.append("（一覧はここまでです）")
    result: list[str] = []
    for line in lines:
        result += ps_split_display(line)
    return result


# ps1 の Test-ListScrolledToEnd を写した版。
def ps_scrolled_to_end(top_index: int, item_count: int, client_height: int, item_height: int) -> bool:
    if item_count <= 0:
        return True
    if item_height <= 0:
        return False
    return top_index + (client_height // item_height) >= item_count


# ps1 の Test-ApprovalAllowed を写した版。
def ps_approval_allowed(blocked: bool, reached_end: bool, read_checked: bool, needs_overwrite: bool, overwrite_checked: bool) -> bool:
    if blocked:
        return False
    if not (reached_end and read_checked):
        return False
    if needs_overwrite and not overwrite_checked:
        return False
    return True


# ps1 の Split-LogText・Format-LogLine を写した版。
def ps_format_log(line: str, prefix: str = "", from_cli: bool = False) -> list[str]:
    mark = CLI_OUTPUT_MARK if from_cli else ""
    return [prefix + mark + ps_format_escaped(piece, "Log") for piece in re.split(r"\r?\n", line)]


# ps1 の Resolve-CliParameterName を写した版。例外の代わりに None を返す。
def ps_resolve_parameter(option: str, cli_parameters: set[str], managed: list[str]) -> str | None:
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", option):
        return None
    name = pascal_name(option)
    if name.lower() in {item.lower() for item in managed}:
        return None
    if name not in cli_parameters:
        return None
    return name


# ps1 の ConvertTo-ConsoleHelperSplat を写した版。不正なら ValueError。
def ps_console_splat(bound: dict, key_actions: list[str], allowed_by_action: dict[str, list[str]], switches: list[str], forced_no_start: list[str]) -> dict:
    if "ConsoleHelper" not in bound:
        raise ValueError("-ConsoleHelper がありません")
    if "StaRelaunched" in bound:
        raise ValueError("-StaRelaunched と同時")
    action = bound.get("Action")
    if not isinstance(action, str) or action not in key_actions:
        raise ValueError("Action が不正")
    allowed = allowed_by_action[action]
    splat: dict = {"Action": action}
    for name, value in bound.items():
        if name in ("ConsoleHelper", "Action"):
            continue
        if name not in allowed:
            raise ValueError(f"{name} は使えない")
        if name in switches:
            if not isinstance(value, bool):
                raise ValueError("チェックの形式")
            if value:
                splat[name] = True
            continue
        if not isinstance(value, str) or not value.strip():
            raise ValueError("値が空")
        if dash_leading(value):
            raise ValueError("- で始まる")
        if ps_has_forbidden(value):
            raise ValueError("禁止文字")
        if name == "ExposureSha256" and not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("指紋の形式")
        splat[name] = value
    if action in forced_no_start and "NoStart" not in splat:
        raise ValueError("-NoStart が無い")
    return splat


# ps1 の「$script:Name = @{ Key = @('a', 'b') ... }」の、キーごとの文字列配列を読む。
def read_script_table(source: str, name: str) -> dict[str, list[str]]:
    match = re.search(r"\$script:" + re.escape(name) + r"\s*=\s*@\{(.*?)\n\}", source, re.DOTALL)
    if match is None:
        return {}
    table: dict[str, list[str]] = {}
    for row in re.finditer(r"(?m)^\s*(\w+)\s*=\s*@\(([^)]*)\)", match.group(1)):
        table[row.group(1)] = re.findall(r"'([^']*)'", row.group(2))
    return table


# ---------------------------------------------------------------------------
# ハブの稼働表示（画面の上の帯）と、分かっている値の自動入力。画面の文は Ubuntu 版と同じ
# ---------------------------------------------------------------------------

# 帯の 2 つのラベルの説明（ps1 の $script:HubStatusToolTip と同じ文）。
HUB_STATUS_TOOLTIP = (
    "この PC のハブ（Tunnel Client）のプロセスが動いているかを、3 秒ごとに調べて表示します。"
    "調べるのは、Tunnel Client が書く PID ファイルと、その PID のプロセスだけです（読み取りだけで、通信はしません。ハブ設定も読むだけです）。"
    "この画面の外（別の端末や自動起動）で起動したハブも表示します。"
    "「実行中」が示すのは、5 段階のうち 3 の「Tunnel Client の稼働」だけです。"
    "OpenAI とつながっているかは「ハブの稼働状態」で、ChatGPT から読めるかは ChatGPT の画面で確かめます。"
    "起動したときと「一覧を更新」のときには、分かっている値（「プロジェクトを追加」の Tunnel ID と、Tunnel Client の場所）を空の入力欄に入れます。"
    "入力済みの値は書き換えません。"
)
# かんたんタブ「確認の 5 段階」の説明（末尾の 1 文が、帯の表示の意味の注意）。
HUB_STAGE_TOOLTIP = (
    "ChatGPT からプロジェクトを読めるまでの確認を 5 段階に分けています。1 つの表示（緑のランプなど）にまとめず、段階ごとに確かめます。"
    "画面の上の「ハブ」の表示が示すのは、3 の Tunnel Client のプロセスの有無だけです。"
)
HUB_TUNNEL_PATTERN = r"^tunnel_[0-9a-f]{32}\z"  # Tunnel ID の形式（ps1 の Test-HubTunnelId と CLI が使う正規表現）。
HUB_PROFILE_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,62}\z"  # プロファイル名の形式（ps1 の Test-HubProfileName と CLI の Assert-ProfileName が使う正規表現）。
HUB_INTERVAL = 3000  # 稼働表示を調べ直す間隔（ミリ秒）。
# 稼働表示と自動入力のために足した関数（読み取りだけで、通信・書き込み・プロセスの起動をしない）。
HUB_FUNCTIONS = (
    "Test-HubTunnelId", "Test-HubProfileName", "Read-HubSummary", "Get-HubPidFilePath", "ConvertTo-HubProcessId", "Read-HubProcessId",
    "Test-HubProcessMatch", "Get-ProcessCommandLine", "Test-HubProcessRunning", "Get-HubRunState", "Get-HubStatusText", "Test-SharedInputOption",
    "Find-TunnelClientPath", "Test-AutoFillAllowed", "Update-HubStatusBand", "Set-AutoFilledText", "Set-KnownInputValue", "New-HubStatusBand",
)
# そのうち、画面もプロセスも見ない純粋な関数。
HUB_PURE_FUNCTIONS = ("Test-HubTunnelId", "Test-HubProfileName", "ConvertTo-HubProcessId", "Test-HubProcessMatch", "Get-HubStatusText", "Test-SharedInputOption", "Test-AutoFillAllowed")


# ps1 の ConvertTo-HubProcessId を写した版（前後の空白と改行を除いて数字だけ 1〜9 桁なら、その数。それ以外は 0）。
def ps_hub_process_id(text: str | None) -> int:
    trimmed = (text or "").strip()
    if re.fullmatch(r"[0-9]{1,9}", trimmed) is None:
        return 0
    return int(trimmed)


# ps1 の Test-HubProcessMatch を写した版（名前が tunnel-client で、コマンドラインに「--profile <名前>」があり、直後が空白か末尾。大文字小文字は区別しない）。
def ps_hub_process_match(process_name: str | None, command_line: str | None, profile_name: str) -> bool:
    if (process_name or "").upper() != "TUNNEL-CLIENT":
        return False
    if not (command_line or "").strip():
        return True
    return re.search(r"--profile\s+" + re.escape(profile_name) + r"(?:\s|\Z)", command_line, re.IGNORECASE) is not None


# CLI の Start-ProfileTunnel の照合（名前が tunnel-client.exe のプロセスのコマンドラインを、末尾が (?:\s|$) の正規表現で照合する）を写した版。
def cli_profile_match(command_line: str, profile_name: str) -> bool:
    return re.search(r"--profile\s+" + re.escape(profile_name) + r"(?:\s|$)", command_line, re.IGNORECASE) is not None


# ps1 の Get-HubStatusText を写した版。（状態の文, 詳細の文, 実行中か）を返す。
def ps_hub_status_text(status: dict) -> tuple[str, str, bool]:
    summary = "Tunnel ID: " + ps_format_escaped(status["TunnelId"], "Log") + " / プロファイル: " + ps_format_escaped(status["ProfileName"], "Log") + " / 登録 " + str(int(status["ProjectCount"])) + " 件"
    if status["State"] == "Running":
        return "ハブ: ● 実行中（PID " + str(int(status["ProcessId"])) + "）", summary, True
    if status["State"] == "Stopped":
        return "ハブ: ○ 停止中", summary + "。「ハブを起動」で起動します。", False
    if status["State"] == "Unset":
        return "ハブ: 未設定", "Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。", False
    reason_lines = [ps_format_escaped(line.strip(), "Log") for line in re.split(r"\r?\n", status["Reason"]) if line.strip()]
    return "ハブ: 確認できません", " ".join(reason_lines) if reason_lines else "理由を取得できませんでした。", False


# ps1 の Test-AutoFillAllowed を写した版（欄が空か、前回この処理が入れた値のままのときだけ書き換える）。
def ps_auto_fill_allowed(current: str, candidate: str, last_filled: str) -> bool:
    if not candidate.strip():
        return False
    if ps_has_forbidden(candidate):
        return False
    if dash_leading(candidate):
        return False
    if current == candidate:
        return False
    if not current.strip():
        return True
    if not last_filled:
        return False
    return current == last_filled


def use_safe_output() -> None:
    """出力先の文字コードで日本語を書けないとき（英語版 Windows の cp1252 へのリダイレクトなど）、落ちずに逃がし文字で書く。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            "日本語".encode(stream.encoding or "ascii")
        except (LookupError, UnicodeEncodeError):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="backslashreplace")


def main() -> int:
    use_safe_output()
    report = Report()

    # 1. 存在・文字コード・先頭の宣言。
    problems: list[str] = []
    if not GUI_PATH.is_file():
        report.check("1. ファイルの存在とUTF-8・先頭の宣言", [f"ファイルがありません: {GUI_PATH}"])
        print("PROJECT_BRIDGE_GUI_WINDOWS_STATIC FAIL")
        return 1
    raw = GUI_PATH.read_bytes()
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        report.check("1. ファイルの存在とUTF-8・先頭の宣言", [f"UTF-8として読めません: {error}"])
        print("PROJECT_BRIDGE_GUI_WINDOWS_STATIC FAIL")
        return 1
    source = source.removeprefix("\ufeff").replace("\r\n", "\n")
    head = source.split("\n")[:HEADER_LINES]
    if not head or head[0].strip() != "#Requires -Version 7":
        problems.append("1行目が #Requires -Version 7 ではありません")
    for required in ("Set-StrictMode -Version Latest", "$ErrorActionPreference = 'Stop'"):
        if not any(line.strip() == required for line in head):
            problems.append(f"先頭{HEADER_LINES}行に {required} がありません")
    report.check("1. ファイルの存在とUTF-8・先頭の宣言", problems)

    # 2. 括弧の対応。
    lexed = lex_powershell(source)
    problems = [lexed.error] if lexed.error else []
    problems += bracket_problems(lexed.code)
    report.check("2. 括弧の対応（文字列・コメント・here-string・$() を区別）", problems)
    code = lexed.code
    ranges = function_ranges(code)

    # 3. 禁止語と、書き込み命令が 1 つも無いこと。
    # 文字列やコメントの中も対象にする（& '命令名' のように文字列から呼ぶ書き方も見逃さないため）。例外にする行は無い。
    problems = []
    lines = source.split("\n")
    for number, text in enumerate(lines, start=1):
        for label, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(text):
                problems.append(f"{label}: {number} 行: {text.strip()}")
        for label, pattern in WRITE_COMMANDS:
            if pattern.search(text):
                problems.append(f"書き込み命令 {label}: {number} 行: {text.strip()}")
    # リダイレクト（> と >>）。文字列とコメントを除いたソースで探す（PowerShell の比較は -gt などの語で書くため、コードに > は現れない）。
    for match in re.finditer(r">", code):
        problems.append(f"リダイレクト（> / >>）: {line_of(code, match.start())} 行: {lines[line_of(code, match.start()) - 1].strip()}")
    report.check(f"3. 禁止語（{len(FORBIDDEN_PATTERNS)} 種。-Command・-EncodedCommand・Invoke-Command・-Verb・通信・-NoExit など）と、書き込み命令（{len(WRITE_COMMANDS)} 種とリダイレクト）が 1 つも無いこと", problems)

    # 4. 承認済み動詞と、1文字の変数名。
    problems = []
    for match in re.finditer(r"(?m)^\s*function\s+([A-Za-z][\w-]*)", code):
        name = match.group(1)
        parts = name.split("-", 1)
        if len(parts) != 2 or not parts[1]:
            problems.append(f"Verb-Noun 形式ではない関数: {name}（{line_of(code, match.start())} 行）")
        elif parts[0] not in APPROVED_VERBS:
            problems.append(f"承認済みでない動詞: {name}（{line_of(code, match.start())} 行）")
    for match in re.finditer(r"\$\{?(?:(?:script|global|local|private|using|env|variable):)?([A-Za-z_][A-Za-z0-9_]*)", lexed.expandable):
        variable = match.group(1)
        if len(variable) == 1 and variable != "_":
            problems.append(f"1文字の変数名 ${variable}（{line_of(lexed.expandable, match.start())} 行）")
    report.check(f"4. 関数名が承認済み動詞で始まり（{len(ranges)} 関数）、1文字の変数名が無いこと", problems)

    # 5. 共有データ・CLIとの整合。
    problems = []
    help_data = json.loads(HELP_PATH.read_text(encoding="utf-8"))
    cli_parameters, cli_actions = read_cli_parameters(CLI_PATH.read_text(encoding="utf-8"))
    json_actions = list(help_data["actions"].keys())
    converted_actions = [pascal_name(name) for name in json_actions]
    if len(json_actions) != 26:
        problems.append(f"JSONのAction数が26ではありません: {len(json_actions)}")
    for kebab, converted in zip(json_actions, converted_actions):
        if converted not in cli_actions:
            problems.append(f"Action {kebab} → {converted} がCLIの ValidateSet にありません")
    for action in cli_actions:
        if action not in converted_actions:
            problems.append(f"CLIの Action {action} に対応するJSONの項目がありません")
    gui_managed = read_script_array(source, "GuiManagedOptions")
    forced_no_start = read_script_array(source, "ForcedNoStartActions")
    if sorted(gui_managed) != ["exposure-sha256", "service"]:
        problems.append(f"$script:GuiManagedOptions が想定と違います: {gui_managed}")
    if sorted(forced_no_start) != ["AddProject", "HubAdd"]:
        problems.append(f"$script:ForcedNoStartActions が想定と違います: {forced_no_start}")
    missing_in_cli = sorted(name for name in help_data["options"] if pascal_name(name) not in cli_parameters)
    if missing_in_cli != ["no-enable"]:
        problems.append(f"CLIに無いオプションが no-enable だけではありません: {missing_in_cli}")
    for name in help_data["options"]:
        converted = pascal_name(name)
        if converted not in cli_parameters and converted.lower() in source.lower():
            problems.append(f"CLIに無いオプション {converted} がGUIのソースに現れます")
        if converted.lower() in {parameter.lower() for parameter in cli_parameters} and converted not in cli_parameters:
            problems.append(f"変換結果 {converted} とCLIのパラメーター名の大文字小文字が違います")
    # GUIの Get-VisibleOptionName を写し、各カードに出る欄がCLIに存在し、GUIが決める欄が出ないことを確かめる。
    visible: dict[str, list[str]] = {}
    for kebab, action in help_data["actions"].items():
        names = []
        for option in action.get("options", []):
            if option in gui_managed:
                continue
            if option == "no-start" and pascal_name(kebab) in forced_no_start:
                continue
            if not platform_option_allowed(action, option):
                continue
            if pascal_name(option) not in cli_parameters:
                continue
            names.append(option)
        visible[kebab] = names
    for kebab, names in visible.items():
        for option in names:
            if pascal_name(option) not in cli_parameters or option in ("exposure-sha256", "service", "no-enable"):
                problems.append(f"{kebab} のカードに出してはいけない欄 {option} が出ます")
    if visible.get("hub-service-install") != ["no-start"]:
        problems.append(f"Windows の hub-service-install の欄が no-start だけではありません: {visible.get('hub-service-install')}")
    if visible.get("hub-service-uninstall") != []:
        problems.append(f"Windows の hub-service-uninstall に欄があります: {visible.get('hub-service-uninstall')}")
    if visible.get("hub-stop") != []:
        problems.append(f"Windows の hub-stop に欄があります（tunnel-client-path は Ubuntu 専用）: {visible.get('hub-stop')}")
    for kebab in ("add-project", "hub-add"):
        if "no-start" in visible.get(kebab, []):
            problems.append(f"{kebab} に no-start の欄が出ます（GUI経由では常に -NoStart を付けるため出さない）")
    visible_function = source[ranges["Get-VisibleOptionName"][0] : ranges["Get-VisibleOptionName"][1]] if "Get-VisibleOptionName" in ranges else ""
    if "$CliParameters.Contains((ConvertTo-PascalName" not in visible_function:
        problems.append("Get-VisibleOptionName がCLIのパラメーター集合で欄を絞っていません")
    parameter_function = source[ranges["Get-CliParameterSet"][0] : ranges["Get-CliParameterSet"][1]] if "Get-CliParameterSet" in ranges else ""
    # Get-Command -Name <パス> はパスをワイルドカードとして扱い、[ ] を含むフォルダーでは別のファイルを指すため、パスをそのまま読む CommandMetadata を使う。
    if "[System.Management.Automation.CommandMetadata]::new($CliPath)" not in parameter_function or ".Parameters.Keys" not in parameter_function:
        problems.append("Get-CliParameterSet が ([System.Management.Automation.CommandMetadata]::new($CliPath)).Parameters.Keys を使っていません")
    if "Get-CliParameterSet" in ranges and re.search(r"Get-Command\b", code[ranges["Get-CliParameterSet"][0] : ranges["Get-CliParameterSet"][1]]):
        problems.append("Get-CliParameterSet が Get-Command（パスをワイルドカードとして扱う）を使っています")
    # 変換関数は表を持たず、規則を1つの関数に書いていること。写した版と同じ規則であることを本体の記述で確かめる。
    if "ConvertTo-PascalName" not in ranges:
        problems.append("ConvertTo-PascalName がありません")
    else:
        body = source[ranges["ConvertTo-PascalName"][0] : ranges["ConvertTo-PascalName"][1]]
        for needle in ("-split '-'", ".Substring(0, 1).ToUpperInvariant()", ".Substring(1)", "-join ''"):
            if needle not in body:
                problems.append(f"ConvertTo-PascalName の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
        if "@{" in body or "switch" in body or re.search(r"'Hub[A-Z]", body):
            problems.append("ConvertTo-PascalName が対応表を持っています")
    expected_examples = {"hub-add": "HubAdd", "exposure-sha256": "ExposureSha256", "hub-service-uninstall": "HubServiceUninstall", "show-exposure": "ShowExposure"}
    for kebab, expected in expected_examples.items():
        if pascal_name(kebab) != expected:
            problems.append(f"変換の代表例が違います: {kebab} → {pascal_name(kebab)}（期待 {expected}）")
    report.check(f"5. 共有データとCLIの整合（Action {len(json_actions)} 個・オプション {len(help_data['options'])} 個・CLIのパラメーター {len(cli_parameters)} 個）", problems)

    # 6. ツールチップの網羅（静的）。
    problems = []
    creation = re.compile(r"New-Object\s+(?:-TypeName\s+)?[\"']?System\.Windows\.Forms\.|\[System\.Windows\.Forms\.\w+\]::new\(", re.IGNORECASE)
    for match in creation.finditer(source):
        owner = enclosing_function(ranges, match.start())
        if owner not in ("New-GuiControl", "New-GuiComponent"):
            problems.append(f"共通ヘルパーを通らないWinFormsの生成: {line_of(source, match.start())} 行（関数 {owner or '外側'}）")
    for match in re.finditer(r"New-Object\s+(?:-TypeName\s+)?([\"'])", source):
        owner = enclosing_function(ranges, match.start())
        if owner not in ("New-GuiControl", "New-GuiComponent"):
            line_text = lines[line_of(source, match.start()) - 1].strip()
            problems.append(f"文字列で型名を渡す New-Object（型を静的に確かめられない）: {line_text}")
    control_body = source[ranges["New-GuiControl"][0] : ranges["New-GuiControl"][1]] if "New-GuiControl" in ranges else ""
    if "SetToolTip(" not in control_body:
        problems.append("New-GuiControl が SetToolTip を呼んでいません")
    if "Limit-ToolTipText" not in control_body:
        problems.append("New-GuiControl が本文を上限で切っていません（Limit-ToolTipText）")
    layout_types = set(read_script_array(source, "LayoutTypeNames"))
    component_types = set(read_script_array(source, "ComponentTypeNames"))
    control_calls = 0
    for match in re.finditer(r"New-GuiControl\b", code):
        if enclosing_function(ranges, match.start()) == "" and code[match.start() - 9 : match.start()].strip().endswith("function"):
            continue
        line_text = lines[line_of(code, match.start()) - 1]
        if re.match(r"\s*function\s+New-GuiControl", line_text):
            continue
        control_calls += 1
        type_match = re.search(r"New-GuiControl\s+-TypeName\s+'(\w+)'", line_text)
        if type_match is None:
            problems.append(f"New-GuiControl の型名が文字列リテラルではありません: {line_text.strip()}")
            continue
        if "-LayoutOnly" in line_text:
            if type_match.group(1) not in layout_types:
                problems.append(f"説明なし（-LayoutOnly）で作る型が配置用ではありません: {line_text.strip()}")
        elif not re.search(r"-ToolTipText\s+(?!''|\"\")\S", line_text):
            problems.append(f"New-GuiControl の呼び出しに説明（-ToolTipText）がありません: {line_text.strip()}")
    component_calls = 0
    for match in re.finditer(r"New-GuiComponent\b", code):
        line_text = lines[line_of(code, match.start()) - 1]
        if re.match(r"\s*function\s+New-GuiComponent", line_text):
            continue
        component_calls += 1
        type_match = re.search(r"New-GuiComponent\s+-TypeName\s+'(\w+)'", line_text)
        if type_match is None or type_match.group(1) not in component_types:
            problems.append(f"New-GuiComponent の型名が一覧にない、またはリテラルではありません: {line_text.strip()}")
    for setting in ("AutoPopDelay = 30000", "InitialDelay = 300", "ReshowDelay = 100", "ShowAlways = $true"):
        if setting not in source:
            problems.append(f"ToolTip の設定 {setting} がありません")
    # 共有データ側: 全Action・全オプションの説明本文が空でなく、上限内に収まること（Pythonへ写した組み立てで確かめる）。
    longest = 0
    for kebab, action in help_data["actions"].items():
        text, original = action_tooltip(action)
        longest = max(longest, original)
        if not text.strip():
            problems.append(f"Action {kebab} の説明が空です")
        if len(text) > TOOLTIP_LIMIT:
            problems.append(f"Action {kebab} の説明が上限を超えます: {len(text)}")
    for name, option in help_data["options"].items():
        text, original = option_tooltip(option)
        longest = max(longest, original)
        if not text.strip():
            problems.append(f"オプション {name} の説明が空です")
    long_sample = "あ" * 1500
    if len(limit_tooltip(long_sample)) > TOOLTIP_LIMIT or not limit_tooltip(long_sample).endswith("（続きは README・マニュアル）"):
        problems.append("上限で切る処理（Pythonへ写した版）が上限を守っていません")
    if "'…（続きは README・マニュアル）'" not in source:
        problems.append("ps1 の切り詰めの案内文が、写した版と違います")
    report.check(f"6. ツールチップの網羅（New-GuiControl {control_calls} 箇所・New-GuiComponent {component_calls} 箇所。説明本文の最長 {longest} 文字）", problems)

    # 7. 引用関数の突き合わせ。
    problems = []
    quote_body = source[ranges["ConvertTo-QuotedArgument"][0] : ranges["ConvertTo-QuotedArgument"][1]] if "ConvertTo-QuotedArgument" in ranges else ""
    for needle in ("IndexOfAny([char[]]@(' ', \"`t\", '\"'))", "'\\' * ($backslashCount * 2 + 1)", "'\\' * ($backslashCount * 2)", "'\\' * $backslashCount"):
        if needle not in quote_body:
            problems.append(f"ConvertTo-QuotedArgument の本体に規則の要点 {needle} がありません")
    cases = [
        "", "simple", "with space", "tab\there", 'quote"inside', 'quote" and space', "trail\\", "trail space\\",
        "C:\\Program Files\\", 'back\\\\"quote', "日本語のフォルダー", "E:\\作業 フォルダー\\プロジェクト", "\\\\server\\share\\",
        '"', '\\"', "a\\\\b", "-Action", "HubAdd", "E:\\work\\Example", 'ends with quote"', "  ", "\\", "\\\\ \\\\",
    ]
    textual = 0
    semantic = 0
    for case in cases:
        mine = quote_argument(case)
        reference = subprocess.list2cmdline([case])
        if '"' in case and not (" " in case or "\t" in case) and case:
            # list2cmdline は二重引用符だけの引数を囲まない。文字列は違っても、読み戻した結果が同じことを確かめる。
            if split_windows_command_line(mine) != [case] or split_windows_command_line(reference) != [case]:
                problems.append(f"読み戻しが一致しません: {case!r} → {mine!r} / list2cmdline {reference!r}")
            semantic += 1
        elif mine != reference:
            problems.append(f"list2cmdline と一致しません: {case!r} → {mine!r} / list2cmdline {reference!r}")
        else:
            textual += 1
        if split_windows_command_line(mine) != [case]:
            problems.append(f"読み戻すと元に戻りません: {case!r} → {mine!r} → {split_windows_command_line(mine)!r}")
    joined = " ".join(quote_argument(case) for case in cases)
    if split_windows_command_line(joined) != cases:
        problems.append("引数配列を連結した文字列を読み戻すと、元の配列に戻りません")
    generator = random.Random(20261008)
    alphabet = ["a", " ", "\t", '"', "\\", "あ", "-"]
    for _ in range(3000):
        sample = [
            "".join(generator.choice(alphabet) for _ in range(generator.randint(0, 8)))
            for _ in range(generator.randint(1, 4))
        ]
        line = " ".join(quote_argument(argument) for argument in sample)
        if split_windows_command_line(line) != sample:
            problems.append(f"乱数の引数配列で読み戻しが一致しません: {sample!r} → {line!r}")
            break
        if all('"' not in argument for argument in sample) and line != subprocess.list2cmdline(sample):
            problems.append(f"乱数の引数配列で list2cmdline と一致しません: {sample!r}")
            break
    report.check(f"7. 引用関数 ConvertTo-QuotedArgument の突き合わせ（文字列一致 {textual} 件・読み戻し一致 {semantic} 件・乱数 3000 件）", problems)

    # 8. 承認の経路が1か所であること。
    problems = []
    # パラメーターの形（-ExposureSha256。PowerShell は大文字小文字を区別しないため、区別せずに探す）だけを数える。
    # ShowExposure の JSON の項目名 exposureSha256（先頭に - が無い）を読む箇所は対象にしない。
    sha_tokens = [token for token in lexed.strings if re.fullmatch(r"-ExposureSha256", token.content.strip(), re.IGNORECASE)]
    if len(sha_tokens) != 1:
        problems.append(f"'-ExposureSha256' を引数にする文字列が1か所ではありません: {[token.line for token in sha_tokens]} 行")
    for token in sha_tokens:
        offset = sum(len(text) + 1 for text in lines[: token.line - 1])
        if enclosing_function(ranges, offset) != "Add-ApprovedExposureArgument":
            problems.append(f"'-ExposureSha256' が Add-ApprovedExposureArgument の外にあります: {token.line} 行")
    for match in re.finditer(r"(?<![\w.$])-ExposureSha256\b", code, re.IGNORECASE):
        problems.append(f"文字列の外で -ExposureSha256 を使っています: {line_of(code, match.start())} 行")
    for token in lexed.strings:
        if token.content.strip().lower() == "exposure-sha256":
            if not lines[token.line - 1].lstrip().startswith("$script:GuiManagedOptions"):
                problems.append(f"'exposure-sha256' が GUI の決めるオプションの一覧の外にあります: {token.line} 行")
    for match in re.finditer(r"ApprovedByUser\s*=\s*\$true", code):
        owner = enclosing_function(ranges, match.start())
        if owner != "Show-ApprovalDialog":
            problems.append(f"承認の結果を作る箇所が承認ダイアログの外にあります: {line_of(code, match.start())} 行（{owner}）")
    if len(re.findall(r"ApprovedByUser\s*=\s*\$true", code)) != 1:
        problems.append("承認の結果を作る箇所が1か所ではありません")
    argument_body = source[ranges["New-CliArgumentList"][0] : ranges["New-CliArgumentList"][1]] if "New-CliArgumentList" in ranges else ""
    if argument_body.count("$script:GuiManagedOptions -contains") < 2:
        problems.append("New-CliArgumentList が、GUIが決めるオプション（指紋・-Service）を値やチェックとして拒んでいません")
    approval_dialog = source[ranges["Show-ApprovalDialog"][0] : ranges["Show-ApprovalDialog"][1]] if "Show-ApprovalDialog" in ranges else ""
    for needle in ("Enabled = $false", "AcceptButton = $cancelButton", "CancelButton = $cancelButton", "-and (Test-ApprovalAllowed -Blocked $blocked -ReachedEnd $state.ReachedEnd -ReadChecked ([bool]$readCheck.Checked)"):
        if needle not in approval_dialog:
            problems.append(f"承認ダイアログに {needle} がありません")
    # -Service も、ハブの起動（Start-ActionJob）の固定の経路の 1 か所だけで加える。
    service_tokens = [token for token in lexed.strings if re.fullmatch(r"-Service", token.content.strip(), re.IGNORECASE)]
    if len(service_tokens) != 1:
        problems.append(f"'-Service' を引数にする文字列が1か所ではありません: {[token.line for token in service_tokens]} 行")
    for token in service_tokens:
        offset = sum(len(text) + 1 for text in lines[: token.line - 1])
        if enclosing_function(ranges, offset) != "Start-ActionJob":
            problems.append(f"'-Service' が Start-ActionJob の外にあります: {token.line} 行")
    calls = [line_of(code, match.start()) for match in re.finditer(r"Add-ApprovedExposureArgument\s+-ArgumentList", code)]
    report.check(f"8. 承認の経路が1か所（指紋を引数へ加えるのは Add-ApprovedExposureArgument だけ、-Service は Start-ActionJob だけ。呼び出し {len(calls)} 箇所: {calls} 行）", problems)

    # 9. 子プロセスとキー・起動の扱い（仕様の要点がソースにあること）。
    problems = []
    start_job = source[ranges["Start-CliJob"][0] : ranges["Start-CliJob"][1]] if "Start-CliJob" in ranges else ""
    for needle in ("$startInfo.ArgumentList.Add($argument)", "UseShellExecute = $false", "CreateNoWindow = $true", "RedirectStandardOutput = $true", "RedirectStandardError = $true", "RedirectStandardInput = $true", "StandardInput.Close()", "StandardOutputEncoding", "StandardErrorEncoding", "ReadLineAsync()"):
        if needle not in start_job:
            problems.append(f"Start-CliJob に {needle} がありません")
    key_console = source[ranges["Start-KeyConsole"][0] : ranges["Start-KeyConsole"][1]] if "Start-KeyConsole" in ranges else ""
    for needle in ("New-CliArgumentList -CliPath $script:GuiScriptPath -ConsoleHelper", "$arguments.Add('-NoStart')", "Join-CommandLine", "Start-Process -FilePath", "-PassThru", "$script:Ui.ConsoleProcess = Start-Process"):
        if needle not in key_console:
            problems.append(f"Start-KeyConsole に {needle} がありません")
    # この画面が管理する子プロセスにだけ -NonInteractive を付ける（入力を求められたら待たずにエラーで終える）。別コンソールの補助役には付けない（キーを入力するため）。
    if "    if (-not $ConsoleHelper) { $arguments.Add('-NonInteractive') }\n" not in argument_body:
        problems.append("New-CliArgumentList が、この画面が管理する子プロセスにだけ -NonInteractive を付けていません")
    elif argument_body.find("$arguments.Add('-NonInteractive')") > argument_body.find("$arguments.Add('-File')"):
        problems.append("-NonInteractive が -File より後ろにあります（スクリプトへの引数になります）")
    if re.search(r"-NoExit", source, re.IGNORECASE):
        problems.append("-NoExit が残っています（別コンソールに対話プロンプトを残さない）")
    if "Interval = 150" not in source:
        problems.append("タイマーの間隔 150ms がありません")
    if "$arguments.Add('-Service')" not in source:
        problems.append("HubStart・HubRestart に -Service を付ける箇所がありません")
    if ".Kill($true)" not in source:
        problems.append("プロセスツリーごと止める Kill($true) がありません")
    # WinForms を読み込むのは、画面を作る Start-BridgeGui と、起動の失敗をメッセージボックスで知らせる Show-StartupError だけ。
    for match in re.finditer(r"Add-Type\s+-AssemblyName\s+System\.Windows\.Forms", code):
        if enclosing_function(ranges, match.start()) not in ("Start-BridgeGui", "Show-StartupError"):
            problems.append(f"Add-Type System.Windows.Forms が画面を作る関数の外にあります: {line_of(code, match.start())} 行")
    if "if ($MyInvocation.InvocationName -ne '.') {" not in source:
        problems.append("ドットソース時に画面を出さない保護がありません")
    top_level_calls = [line_of(code, match.start()) for match in re.finditer(r"(?m)^\s*Start-BridgeGui\b", code) if enclosing_function(ranges, match.start()) == ""]
    if len(top_level_calls) != 1:
        problems.append(f"Start-BridgeGui を呼ぶ箇所が1か所ではありません: {top_level_calls}")
    if "GetApartmentState()" not in source or "'-STA'" not in source or "$IsWindows" not in source:
        problems.append("Windows 以外の停止、または STA でないときの起動し直しがありません")
    report.check("9. 子プロセス・別コンソール・起動の扱い（引数は1要素ずつ・入力はすぐ閉じる・-NoStart・-Service・STA）", problems)

    # 10. Hashtable のキー名が組み込みプロパティと衝突しないこと。
    # PowerShell の $hash.Values / $hash.Keys / $hash.Count はキーより組み込みプロパティが優先されるため、同名のキーは読めない。
    problems = []
    reserved = r"(Keys|Values|Count|IsReadOnly|IsFixedSize|IsSynchronized|SyncRoot|Comparer)"
    for match in re.finditer(r"(?m)(?:^|[{;])\s*" + reserved + r"\s*=(?!=)", code):
        problems.append(f"Hashtable のキー名 {match.group(1)} が組み込みプロパティと衝突します: {line_of(code, match.start(1))} 行")
    report.check("10. Hashtable のキー名が組み込みプロパティ（Keys・Values・Count など）と衝突しないこと", problems)

    # 関数の本体（ソースの文字列）を返す。無ければ空文字。
    def body_of(name: str) -> str:
        return source[ranges[name][0] : ranges[name][1]] if name in ranges else ""

    # 11. platformOnly（OS 専用のオプション）。
    problems = []
    checked_pairs = 0
    for kebab, action in help_data["actions"].items():
        if "platformOnly" not in action:
            problems.append(f"Action {kebab} に platformOnly がありません")
            continue
        platform_only = action["platformOnly"]
        if not isinstance(platform_only, dict):
            problems.append(f"Action {kebab} の platformOnly がオブジェクトではありません")
            continue
        for option, platform in platform_only.items():
            checked_pairs += 1
            if option not in action.get("options", []):
                problems.append(f"Action {kebab} の platformOnly のキー {option} が options にありません")
            if platform not in ("ubuntu", "windows"):
                problems.append(f"Action {kebab} の platformOnly の値 {platform!r} が ubuntu / windows のどちらでもありません")
            if platform == "windows" and pascal_name(option) not in cli_parameters:
                problems.append(f"Windows 専用のオプション {option}（{kebab}）が project-bridge.ps1 の param にありません")
            if platform == "ubuntu" and option in visible.get(kebab, []):
                problems.append(f"Ubuntu 専用のオプション {option} が Windows の {kebab} のカードに出ます")
    # Windows の CLI（project-bridge.ps1 の param）に無いオプションは、現れるすべての Action で platformOnly により ubuntu 専用になっていること。
    # platformOnly が主な仕組みで、CLI のパラメーター照合は二重の安全策（片方が抜けても欄が出ないことを、両方そろっているかで確かめる）。
    ubuntu_only_by_cli = []
    for kebab, action in help_data["actions"].items():
        for option in action.get("options", []):
            if option in gui_managed or pascal_name(option) in cli_parameters:
                continue
            ubuntu_only_by_cli.append(f"{kebab}:{option}")
            if (action.get("platformOnly") or {}).get(option) != "ubuntu":
                problems.append(f"Windows の CLI に無いオプション {option}（{kebab}）が、platformOnly で ubuntu 専用になっていません")
    if sorted(ubuntu_only_by_cli) != ["hub-service-install:no-enable", "hub-service-uninstall:no-enable"]:
        problems.append(f"Windows の CLI に無いオプションの現れ方が想定（hub-service-install と hub-service-uninstall の no-enable）と違います: {sorted(ubuntu_only_by_cli)}")
    if "$script:GuiPlatform = 'windows'" not in source:
        problems.append("$script:GuiPlatform = 'windows' がありません")
    platform_body = body_of("Test-PlatformOption")
    for needle in ("$Action.PSObject.Properties['platformOnly']", "$Action.platformOnly", "$platformOnly.PSObject.Properties[$OptionName]", "-ceq $Platform", "[string]$Platform = $script:GuiPlatform"):
        if needle not in platform_body:
            problems.append(f"Test-PlatformOption の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    # 項目が 1 つも無いオブジェクト（説明データの "platformOnly": {} など）に .PSObject.Properties.Name を読むと、StrictMode では例外になる。
    for match in re.finditer(r"\.PSObject\.Properties\.Name\b", code):
        problems.append(f"項目が 1 つも無い {{}} で StrictMode の例外になる .PSObject.Properties.Name があります（Properties[名前] で調べる）: {line_of(code, match.start())} 行")
    visible_body = body_of("Get-VisibleOptionName")
    platform_call = visible_body.find("Test-PlatformOption -Action $Action -OptionName $optionText")
    cli_call = visible_body.find("$CliParameters.Contains(")
    if platform_call < 0:
        problems.append("Get-VisibleOptionName が Test-PlatformOption を呼んでいません")
    if cli_call < 0:
        problems.append("Get-VisibleOptionName が CLI のパラメーター照合を残していません（二重の安全策）")
    # 写した規則の代表例（JSON の現在の設定に依存しない、作った例で確かめる）。
    sample = {"options": ["a", "b", "c"], "platformOnly": {"a": "ubuntu", "b": "windows"}}
    expected_rule = {"a": False, "b": True, "c": True}
    for option, expected in expected_rule.items():
        if platform_option_allowed(sample, option) != expected:
            problems.append(f"platformOnly の写した規則が違います: {option}")
    if platform_option_allowed({"options": ["a"]}, "a") is not True or platform_option_allowed({"options": ["a"], "platformOnly": {}}, "a") is not True:
        problems.append("platformOnly が無い・空のときに、オプションを出す規則になっていません")
    report.check(f"11. platformOnly（OS 専用のオプション）の構造と、Windows の画面への反映（指定 {checked_pairs} 件）", problems)

    # 12. - で始まる値を入口で止めること。
    problems = []
    dash_line = re.search(r"\$script:DashCharacters = @\('-'((?:, \[string\]\[char\]0x[0-9A-Fa-f]{4})*)\)", source)
    if dash_line is None:
        problems.append("$script:DashCharacters の定義がありません")
    else:
        ps1_dashes = {"-"} | {chr(int(code, 16)) for code in re.findall(r"0x([0-9A-Fa-f]{4})", dash_line.group(1))}
        if ps1_dashes != DASH_CHARACTERS:
            problems.append(f"ps1 のダッシュ類 {sorted(ps1_dashes)} が、Pythonへ写した版 {sorted(DASH_CHARACTERS)} と違います")
    dash_body = body_of("Test-DashLeadingValue")
    for needle in ("[string]::IsNullOrEmpty($Value)", "$Value.TrimStart([char[]]@(' ', \"`t\", [char]0x3000))", "$script:DashCharacters -contains $trimmed.Substring(0, 1)"):
        if needle not in dash_body:
            problems.append(f"Test-DashLeadingValue の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    label_body = body_of("Get-DashLeadingLabel")
    if "if ($kind -ne 'text' -and $kind -ne 'path') { continue }" not in label_body:
        problems.append("Get-DashLeadingLabel が text・path だけを対象にしていません")
    dash_cases = [
        ("-x", True), (" -x", True), ("\t-x", True), ("\u3000-x", True), ("--force", True), ("-", True), ("\u2013x", True), ("\u2014x", True),
        ("a-b", False), ("", False), ("   ", False), ("日本語", False), ("日本-語", False), ("E:\\-work", False), ("\\\\server\\-share", False), ("ProjA", False),
    ]
    for value, expected in dash_cases:
        if dash_leading(value) != expected:
            problems.append(f"- で始まる値の判定（写した版）が違います: {value!r} → {dash_leading(value)}（期待 {expected}）")
    if "if (Test-DashLeadingValue -Value $value) { throw" not in body_of("New-CliArgumentList"):
        problems.append("New-CliArgumentList が、- で始まる値を CLI へ渡さない最後の守りを持っていません")
    invoke_body = body_of("Invoke-ActionCard")
    dash_check = invoke_body.find("Get-DashLeadingLabel -Help $script:Ui.Help -Values $values")
    if dash_check < 0:
        problems.append("Invoke-ActionCard が - で始まる値を確かめていません")
    else:
        for start in ("Start-AuxiliaryJob", "Start-HubApprovalFlow", "Start-ScaffoldStep", "Start-ExposureStep", "Start-KeyConsole", "Start-ActionJob"):
            position = invoke_body.find(start)
            if position >= 0 and position < dash_check:
                problems.append(f"Invoke-ActionCard が - の確認より前に {start} を呼んでいます")
    if "は - で始められません" not in invoke_body:
        problems.append("どの欄が - で始まるかを示すメッセージがありません")
    report.check(f"12. - で始まる値を入口で止めること（判定の代表 {len(dash_cases)} 件・text と path だけが対象）", problems)

    # 13. 前面の子プロセスと並行して実行できる、読み取りだけの短い Action（補助）。
    problems = []
    auxiliary = set(read_script_array(source, "AuxiliaryActions"))
    if auxiliary != {"Status", "HubStatus", "HubList"}:
        problems.append(f"$script:AuxiliaryActions が Status・HubStatus・HubList ではありません: {sorted(auxiliary)}")
    kebab_by_pascal = {pascal_name(name): name for name in help_data["actions"]}
    for action_name in sorted(auxiliary):
        entry = help_data["actions"].get(kebab_by_pascal.get(action_name, ""), {})
        if entry.get("interactive") != [] or entry.get("foreground") is not False:
            problems.append(f"補助の {action_name} が、入力を求めない・終了する Action ではありません（interactive={entry.get('interactive')}、foreground={entry.get('foreground')}）")
        if set(entry.get("options", [])) - {"project-root"}:
            problems.append(f"補助の {action_name} に、フォルダー以外のオプションがあります: {entry.get('options')}")
    # 写した規則を、依頼の文の通りに書いた期待と、全 Action・全状態で突き合わせる。
    def expected_enabled(action: str, busy: bool, foreground_running: bool, auxiliary_running: bool) -> bool:
        if action in {"Status", "HubStatus", "HubList"}:
            return (not auxiliary_running) and ((not busy) or foreground_running)
        return not busy
    combinations = 0
    for action_name in sorted(kebab_by_pascal):
        for busy in (False, True):
            for foreground_running in ((False,) if not busy else (False, True)):
                for auxiliary_running in (False, True):
                    combinations += 1
                    mine = run_button_enabled(action_name, busy, foreground_running, auxiliary_running, auxiliary)
                    if mine != expected_enabled(action_name, busy, foreground_running, auxiliary_running):
                        problems.append(f"実行ボタンの可否が違います: {action_name} busy={busy} 前面={foreground_running} 補助={auxiliary_running} → {mine}")
    enabled_body = body_of("Test-RunButtonEnabled")
    for needle in ("$script:AuxiliaryActions -contains $ActionName", "if ($isAuxiliary -and $AuxiliaryRunning) { return $false }", "if (-not $Busy) { return $true }", "return ($isAuxiliary -and $ForegroundRunning)"):
        if needle not in enabled_body:
            problems.append(f"Test-RunButtonEnabled の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    if "Test-RunButtonEnabled -ActionName $card.ActionName" not in body_of("Update-ButtonState"):
        problems.append("Update-ButtonState が Test-RunButtonEnabled でボタンを決めていません")
    if "Test-RunButtonEnabled -ActionName $Card.ActionName" not in invoke_body:
        problems.append("Invoke-ActionCard が Test-RunButtonEnabled で実行の可否を確かめていません")
    if body_of("Get-LogLinePrefix").count('return "[$($ActionName)] "') != 1:
        problems.append("Get-LogLinePrefix が [Action 名] と空白を返していません")
    read_body = body_of("Read-CliJobOutput")
    if read_body.count("Add-LogLine -Line $line -LinePrefix $Job.LinePrefix -FromCli") != 2:
        problems.append("Read-CliJobOutput が、標準出力と標準エラー出力の両方の行頭に印を付けていません")
    auxiliary_body = body_of("Start-AuxiliaryJob")
    for forbidden in ("Add-ApprovedExposureArgument", "Start-KeyConsole", "'-Service'", "$script:Ui.Flow ="):
        if forbidden in auxiliary_body:
            problems.append(f"Start-AuxiliaryJob に {forbidden} があります（補助は読み取りだけで、操作の状態を変えない）")
    if "$script:AuxiliaryActions -notcontains $Card.ActionName" not in auxiliary_body:
        problems.append("Start-AuxiliaryJob が補助以外の Action を拒んでいません")
    if "LinePrefix = $linePrefix" not in auxiliary_body:
        problems.append("Start-AuxiliaryJob が行頭の印を子プロセスへ渡していません")
    if "@($script:Ui.Jobs.ToArray() | Where-Object { Test-JobRunning -Job $_ })" not in body_of("Confirm-WindowClose"):
        problems.append("Confirm-WindowClose が、本体と補助の両方の子プロセスを対象にしていません")
    if "$script:Ui.AuxJob.Id -eq $Job.Id" not in body_of("Clear-AuxiliaryJob"):
        problems.append("Clear-AuxiliaryJob が、記録を消す前に子プロセスの識別子を照合していません")
    report.check(f"13. 前面の子プロセスと並行して実行できる補助の Action（{', '.join(sorted(auxiliary))}。状態の組み合わせ {combinations} 通り）", problems)

    # 14. 表示の無害化（共通仕様 S1・S2）。ps1 の規則の要点と、Python へ写した版と参照実装との突き合わせ。
    problems = []
    reference_quote, reference_forbidden, reference_name = load_reference_functions()
    category_block = re.search(r"\$script:ForbiddenCategories = @\((.*?)\n\)", source, re.DOTALL)
    ps_categories = set(re.findall(r"\[System\.Globalization\.UnicodeCategory\]::(\w+)", category_block.group(1))) if category_block else set()
    if ps_categories != PS_FORBIDDEN_CATEGORY_NAMES:
        problems.append(f"$script:ForbiddenCategories が S1（Control・Format・LineSeparator・ParagraphSeparator・Surrogate）と違います: {sorted(ps_categories)}")
    escape_body = body_of("Format-EscapedText")
    for needle in (
        "[char]::IsSurrogatePair($Text, $index)",
        "$codePoint = [char]::ConvertToUtf32($Text, $index)",
        "$category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($Text, $index)",
        "$forbidden = $script:ForbiddenCategories -contains $category",
        "$otherSpace = ($category -eq [System.Globalization.UnicodeCategory]::SpaceSeparator) -and ($codePoint -ne 0x20)",
        "if ($Style -eq 'Quote' -and $codePoint -eq 0x5C) {",
        "[void]$builder.Append('\\\\')",
        "} elseif ($Style -eq 'Quote' -and $codePoint -eq 0x22) {",
        "[void]$builder.Append('\\\"')",
        "} elseif ($forbidden -or ($Style -ne 'Log' -and $otherSpace)) {",
        "if ($Style -eq 'Log' -and $codePoint -le 0xFF) {",
        "[void]$builder.Append('\\x' + $codePoint.ToString('x2'))",
        "} elseif ($codePoint -le 0xFFFF) {",
        "[void]$builder.Append('\\u' + $codePoint.ToString('x4'))",
        "[void]$builder.Append('\\U' + $codePoint.ToString('x8'))",
        "[void]$builder.Append($Text.Substring($index, $width))",
        "$index += $width",
    ):
        if needle not in escape_body:
            problems.append(f"Format-EscapedText の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    for function_name, style in (("ConvertTo-DisplayQuoted", "Quote"), ("ConvertTo-DisplayEscaped", "Plain"), ("ConvertTo-SafeLogLine", "Log")):
        if f"Format-EscapedText -Text $Text -Style {style}" not in body_of(function_name):
            problems.append(f"{function_name} が Format-EscapedText -Style {style} を使っていません")
    forbidden_body = body_of("Test-ForbiddenCharacter")
    for needle in ("[System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($Text, $index)", "if ($script:ForbiddenCategories -contains $category) { return $true }", "if ([char]::IsSurrogatePair($Text, $index)) { $index++ }"):
        if needle not in forbidden_body:
            problems.append(f"Test-ForbiddenCharacter の本体に {needle} がありません")
    for value, expected in S2_VECTORS:
        if reference_quote(value) != expected:
            problems.append(f"参照実装の S2 が試験ベクトルと違います: {ascii(value)} → {ascii(reference_quote(value))}（期待 {ascii(expected)}）")
        if ps_quote(value) != expected:
            problems.append(f"写した版の S2 が試験ベクトルと違います: {ascii(value)} → {ascii(ps_quote(value))}（期待 {ascii(expected)}）")
    # 乱数の文字列で、写した版（UTF-16 で走査）と参照実装（コードポイントで走査）が一致すること。
    pool = [ord(character) for character in "aZ09 \\\"-_/.日本語プロジェクト"] + [
        0x00, 0x09, 0x0A, 0x0D, 0x1B, 0x7F, 0x85, 0x9F, 0xA0, 0xAD, 0x61C, 0x200B, 0x200D, 0x200E, 0x200F, 0x2028, 0x2029,
        0x202A, 0x202E, 0x2060, 0x2066, 0x2069, 0x3000, 0x2003, 0xFEFF, 0x1F600, 0x1F468, 0xE0001, 0xE0041, 0xE007F, 0xD800, 0xDBFF, 0xDC00, 0xDFFF,
        0x430, 0x3B1, 0xE9,
    ]
    generator = random.Random(20261008)
    random_checked = 0
    for _ in range(4000):
        code_points = [generator.choice(pool) for _ in range(generator.randint(0, 10))]
        # 上位サロゲートの直後に下位サロゲートが来る組は .NET では 1 文字になるため、参照実装（Python の文字）と比べる対象から外す。
        if any(0xD800 <= first <= 0xDBFF and 0xDC00 <= second <= 0xDFFF for first, second in zip(code_points, code_points[1:])):
            continue
        sample = "".join(chr(code_point) for code_point in code_points)
        random_checked += 1
        if ps_quote(sample) != reference_quote(sample):
            problems.append(f"乱数の文字列で S2 が一致しません: {ascii(sample)} → {ascii(ps_quote(sample))} / 参照 {ascii(reference_quote(sample))}")
            break
        if ps_has_forbidden(sample) != bool(reference_forbidden(sample)):
            problems.append(f"乱数の文字列で S1 の判定が一致しません: {ascii(sample)}")
            break
        if ps_format_escaped(sample, "Plain") != builtin_quote_for_display(sample)[1:-1].replace("\\\\", "\\").replace('\\"', '"') and "\\" not in sample and '"' not in sample:
            problems.append(f"乱数の文字列で Plain の退避が S2 と一致しません: {ascii(sample)}")
            break
    log_vectors = [
        ("a" + chr(0x0D) + "b", "a\\x0db"), ("a" + chr(0x1B) + "[31m", "a\\x1b[31m"), (chr(0x7F) + chr(0x85), "\\x7f\\x85"),
        ("x" + chr(0x2028) + "y", "x\\u2028y"), ("x" + chr(0x202E) + "y", "x\\u202ey"), ("全角" + chr(0x3000) + "空白", "全角" + chr(0x3000) + "空白"),
        ("C:\\Users\\a", "C:\\Users\\a"), (chr(0xE0041), "\\U000e0041"), (chr(0x1F600), chr(0x1F600)), (chr(0xD800), "\\ud800"), ("", ""),
    ]
    for value, expected in log_vectors:
        if ps_format_escaped(value, "Log") != expected:
            problems.append(f"ログの無害化（写した版）が違います: {ascii(value)} → {ascii(ps_format_escaped(value, 'Log'))}（期待 {ascii(expected)}）")
    report.check(f"14. 表示の無害化（S1・S2。参照: {reference_name}。ベクトル {len(S2_VECTORS)} 件・乱数 {random_checked} 件・ログ {len(log_vectors)} 件。Unicode {unicodedata.unidata_version}）", problems)

    # 15. 承認ダイアログの中身を作る純粋関数（要約・一覧・禁止文字の検出・上書きの判定・承認済みの判定・同形異字・行の分割）。
    problems = []
    sha_current = "a" * 64
    sha_old = "b" * 64
    sample_report = {
        "schemaVersion": 1,
        "projectRoot": "E:\\work\\ProjA",
        "profile": "proja-1234",
        "exposureSha256": sha_current,
        "approvalState": "changed",
        "approvedSha256": sha_old,
        "approvedProjectRoot": "E:\\work\\Other",
        "exposure": {
            "schemaVersion": 1,
            "projectRoot": "E:\\work\\ProjA",
            "contextFile": "CHATGPT_PROJECT_CONTEXT.md",
            "statusFile": "CHATGPT_PROJECT_STATUS.md",
            "allowFiles": ["README.md", "x" + chr(0x2028) + "y.md", "p" + chr(0x430) + "ypal.md"],
            "allowDirectories": [{"path": "docs", "recursive": True}, {"path": "notes", "recursive": False}],
            "denyDirectories": [".git", "a,b", "node_modules"],
            "maxDocumentBytes": 524288,
            "gitExposure": {"paths": True, "commitSubjects": False},
            "detailExposure": {"sourceText": True, "diffExcerpts": False, "branchNames": True},
        },
        "changes": ['allowFiles: ["README.md"] -> ["README.md","x' + chr(0x2028) + 'y.md"]', "mystery: 1 -> 2", "壊れた行"],
    }
    forbidden_found = ps_forbidden_fields(sample_report)
    expected_forbidden = ['exposure.allowFiles[1] = "x\\u2028y.md"', 'changes[0] = "allowFiles: [\\"README.md\\"] -> [\\"README.md\\",\\"x\\u2028y.md\\"]"']
    if forbidden_found != expected_forbidden:
        problems.append(f"禁止文字の検出（写した版）が違います: {forbidden_found}")
    nested = {"projectRoot": "ok", "profile": "p" + chr(0x202E), "exposure": {"k" + chr(0x200B): ["fine", {"deep": "v" + chr(0x0A)}]}, "changes": []}
    expected_nested = ['profile = "p\\u202e"', "exposure.k\\u200b（項目名）", 'exposure.k\\u200b[1].deep = "v\\u000a"']
    if ps_forbidden_fields(nested) != expected_nested:
        problems.append(f"入れ子の禁止文字の検出（写した版）が違います: {ps_forbidden_fields(nested)}")
    if ps_forbidden_fields({"projectRoot": "E:\\a", "profile": "p", "exposure": {"allowFiles": ["a" + chr(0x3000) + "b"]}, "changes": []}) != []:
        problems.append("U+0020 以外の空白類（U+3000）を禁止文字として扱っています（S1 では拒否しない）")
    summary = ps_summary(sample_report)
    expected_summary = {
        "CountLine": "公開ファイル 3 件 / 公開ディレクトリ 2 件（うち配下すべて 1 件） / 拒否ディレクトリ 3 件",
        "GitPathsText": "Git のファイル名: 公開",
        "GitCommitSubjectsText": "Git のコミット件名: 非公開",
        "LimitLine": "文書 1 件の上限: 524288 バイト",
        "ShaLine": "公開範囲の指紋（SHA-256）: " + sha_current,
    }
    for key, expected in expected_summary.items():
        if summary[key] != expected:
            problems.append(f"要約（写した版）の {key} が違います: {summary[key]!r}（期待 {expected!r}）")
    odd_summary = ps_summary({"exposureSha256": sha_current, "exposure": {"allowDirectories": [{"path": "x"}, {"path": "y", "recursive": "no"}], "gitExposure": {"paths": 0}, "maxDocumentBytes": "1e9"}})
    if odd_summary["RecursiveDirectoryCount"] != 2 or not odd_summary["GitPathsPublic"] or not odd_summary["GitCommitSubjectsPublic"] or odd_summary["LimitLine"] != '文書 1 件の上限: "1e9" バイト':
        problems.append(f"形式が想定外の値を、広い側（配下すべて・公開）と引用で示していません: {odd_summary}")
    detail = ps_detail_lines(sample_report, forbidden_found)
    for expected_line in (
        "【承認できない項目】2 件（制御文字・行区切り・双方向制御文字・不可視文字を含むため、偽装の可能性があります）",
        '  1. exposure.allowFiles[1] = "x\\u2028y.md"',
        "【前回の承認から変わった項目】3 件",
        '  1. 公開ファイル（allowFiles）: ["README.md"] -> ["README.md","x\\u2028y.md"]',
        "  2. 不明な項目（mystery）: 1 -> 2",
        "  3. 内容: 壊れた行",
        '  プロジェクトルート: "E:\\\\work\\\\ProjA"',
        '  2. "x\\u2028y.md"',
        '  3. "p' + chr(0x430) + 'ypal.md"' + MIXED_SCRIPT_MARK,
        '  1. "docs"（配下すべて）',
        '  2. "notes"（直下だけ）',
        '  2. "a,b"',
        "【詳細取得ツールの公開設定】",
        "  ソースの本文（sourceText）: 公開",
        "  差分の抜粋（diffExcerpts）: 非公開",
        "  ブランチ名（branchNames）: 公開",
        "  Git のファイル名: 公開 / Git のコミット件名: 非公開",
        "  " + sha_current,
        "（一覧はここまでです）",
    ):
        if expected_line not in detail:
            problems.append(f"一覧（写した版）に {ascii(expected_line)} がありません")
    if detail[-1] != "（一覧はここまでです）":
        problems.append("一覧の最後の行が末尾の印ではありません")
    if any(re.search(r"[\u2028\u2029\u202a-\u202e\u2066-\u2069\x00-\x1f\x7f-\x9f]", line) for line in detail):
        problems.append("一覧の行に生の制御文字・行区切り・双方向制御文字が残っています")
    if ps_shape_problems(sample_report) != []:
        problems.append(f"正しい形の公開範囲で形の崩れを報告しています（写した版）: {ps_shape_problems(sample_report)}")
    broken = {"exposure": {"projectRoot": 1, "contextFile": "c", "allowFiles": ["a", 2], "denyDirectories": "x", "allowDirectories": [{"path": "d", "recursive": "yes"}], "maxDocumentBytes": True, "gitExposure": {"paths": False}, "detailExposure": {"sourceText": "yes"}}}
    expected_shape = ["プロジェクトルート（projectRoot）", "状態文書（statusFile）", "公開ファイル（allowFiles）", "拒否ディレクトリ（denyDirectories）", "公開ディレクトリ（allowDirectories）", "文書 1 件の上限（maxDocumentBytes）", "Git の公開設定（gitExposure）", "詳細取得ツールの公開設定（detailExposure）"]
    if ps_shape_problems(broken) != expected_shape:
        problems.append(f"形の崩れの検出（写した版）が違います: {ps_shape_problems(broken)}")
    if ps_shape_problems({"exposure": [1]}) != ["公開範囲（exposure）"] or ps_shape_problems({**sample_report, "exposure": {**sample_report["exposure"], "maxDocumentBytes": -1}}) != ["文書 1 件の上限（maxDocumentBytes）"]:
        problems.append("公開範囲が無い・上限が負のときの形の検出（写した版）が違います")
    reasons = ps_block_reasons(["f1", "f2", "f3", "f4", "f5"], ["s1"])
    if reasons != ["設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。該当項目: f1、f2、f3、ほか 2 件（全件は一覧の先頭）", "公開範囲の形式が想定と違うため承認できません（件数を構造から確かめられません）。該当する欄: s1"]:
        problems.append(f"承認できない理由の文（写した版）が違います: {reasons}")
    if ps_block_reasons([], []) != [] or ps_block_reasons(["only"], []) != ["設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。該当項目: only"]:
        problems.append("承認できない理由が無いとき・1 件のときの文（写した版）が違います")
    if ps_root_text({**sample_report, "projectRoot": "E:\\work\\projA"}) != 'プロジェクトルート: "E:\\\\work\\\\ProjA"（CLI が示したフォルダー: "E:\\\\work\\\\projA"）':
        problems.append(f"CLI のフォルダーが違うときのルートの文（写した版）が違います: {ps_root_text({**sample_report, 'projectRoot': 'E:/work/projA'})}")
    extra_detail = ps_detail_lines({**sample_report, "exposure": {**sample_report["exposure"], "futureField": 3, "note" + chr(0x200B): "x"}}, [])
    if "【その他の項目】2 件" not in extra_detail or "  - futureField: 3" not in extra_detail or '  - note\\u200b: "x"' not in extra_detail:
        problems.append(f"その他の項目（写した版）が出ません: {[line for line in extra_detail if line.startswith('  - ')]}")
    convert_body = body_of("ConvertFrom-ExposureReport")
    if "$report.approvedProjectRoot -isnot [string]) { throw" not in convert_body:
        problems.append("ConvertFrom-ExposureReport が approvedProjectRoot の型（文字列か null）を確かめていません")
    # Ubuntu 版（文字名の LATIN・CYRILLIC・GREEK で判定）との違いの数（範囲で近似しているため。承認は止めず、印だけの違い）。
    # 範囲の方が広い（コプト文字・結合用のキリル文字・修飾文字も印の対象にする）のは許し、文字名では対象なのに範囲で外れる文字があれば FAIL にする。
    name_mismatches = 0
    for code_point in list(range(0x41, 0x2B0)) + list(range(0x370, 0x530)) + list(range(0x1C80, 0x1C90)) + list(range(0x1E00, 0x2000)) + list(range(0x2C60, 0x2C80)) + list(range(0xA640, 0xA6A0)) + list(range(0xA720, 0xA800)):
        if unicodedata.category(chr(code_point)) == "Cn":
            continue
        name = unicodedata.name(chr(code_point), "")
        by_name = "L" if name.startswith("LATIN ") else "C" if name.startswith("CYRILLIC ") else "G" if name.startswith("GREEK ") else ""
        if by_name != ps_script_class(code_point):
            name_mismatches += 1
            if by_name:
                problems.append(f"Ubuntu 版では文字種 {by_name} の U+{code_point:04X} が、範囲の判定で {ps_script_class(code_point) or '対象外'} になります")
    long_line = "x" * 450
    split = ps_split_display("  1. " + long_line)
    if len(split) != 3 or not all(piece.startswith(CONTINUATION_MARK) for piece in split[1:]) or "".join(piece.removeprefix(CONTINUATION_MARK) for piece in split) != "  1. " + long_line:
        problems.append(f"長い行の分け方（写した版）が違います: {[len(piece) for piece in split]}")
    emoji_split = ps_split_display("a" * 199 + chr(0x1F600) + "b")
    if emoji_split[0] != "a" * 199 or emoji_split[1] != CONTINUATION_MARK + chr(0x1F600) + "b":
        problems.append("長い行を分けるとき、サロゲートペアの途中で分けています（写した版）")
    if ps_split_display("") != [""] or ps_split_display("abc") != ["abc"]:
        problems.append("短い行・空の行がそのまま 1 行になりません（写した版）")
    approved_cases = [
        ({"approvalState": "approved", "approvedSha256": sha_current, "exposureSha256": sha_current}, True),
        ({"approvalState": "approved", "approvedSha256": sha_old, "exposureSha256": sha_current}, False),
        ({"approvalState": "approved", "approvedSha256": sha_current.upper(), "exposureSha256": sha_current}, False),
        ({"approvalState": "approved", "approvedSha256": None, "exposureSha256": sha_current}, False),
        ({"approvalState": "Approved", "approvedSha256": sha_current, "exposureSha256": sha_current}, False),
        ({"approvalState": "changed", "approvedSha256": sha_current, "exposureSha256": sha_current}, False),
        ({"approvalState": "unapproved", "approvedSha256": None, "exposureSha256": sha_current}, False),
    ]
    for case, expected in approved_cases:
        if ps_exposure_approved(case) != expected:
            problems.append(f"承認済みの判定（写した版）が違います: {case} → {ps_exposure_approved(case)}")
    overwrite_cases = [
        (dict(sample_report), True),
        ({**sample_report, "approvedProjectRoot": "E:\\work\\ProjA"}, False),
        ({**sample_report, "approvedProjectRoot": "e:\\work\\proja"}, False),
        ({**sample_report, "approvedProjectRoot": "E:\\WORK\\PROJA"}, False),
        ({**sample_report, "approvedProjectRoot": "E:\\work\\ProjB"}, True),
        ({**sample_report, "approvedProjectRoot": None}, False),
        ({key: value for key, value in sample_report.items() if key != "approvedProjectRoot"}, False),
        ({**sample_report, "approvedProjectRoot": 5}, True),
        ({**sample_report, "approvalState": "unapproved"}, False),
        ({**sample_report, "approvalState": "approved"}, False),
        ({**sample_report, "exposure": {"allowFiles": []}, "projectRoot": "E:\\work\\Other"}, False),
        ({**sample_report, "projectRoot": "E:\\work\\Other"}, False),
        ({**sample_report, "projectRoot": 7, "exposure": {"projectRoot": 8}}, True),
        ({**sample_report, "approvedProjectRoot": "E:\\wor" + chr(0x212A) + "\\ProjA"}, True),
        ({**sample_report, "approvedProjectRoot": "E:\\work\\Proj" + chr(0x200B) + "A"}, True),
        ({**sample_report, "projectRoot": "E:\\work\\Caf" + chr(0xE9), "exposure": {"projectRoot": "E:\\work\\Caf" + chr(0xE9)}, "approvedProjectRoot": "E:\\work\\Cafe" + chr(0x301)}, True),
        ({**sample_report, "projectRoot": "E:\\work\\Caf" + chr(0xC9), "exposure": {"projectRoot": "E:\\work\\Caf" + chr(0xC9)}, "approvedProjectRoot": "e:\\work\\caf" + chr(0xE9)}, False),
    ]
    for case, expected in overwrite_cases:
        if ps_foreign_overwrite(case) != expected:
            problems.append(f"別フォルダーの上書きの判定（写した版）が違います: approvalState={case.get('approvalState')} approvedProjectRoot={case.get('approvedProjectRoot')!r} → {ps_foreign_overwrite(case)}（期待 {expected}）")
    scroll_cases = [
        ((0, 0, 100, 16), True), ((0, 6, 100, 16), True), ((0, 7, 100, 16), False), ((1, 7, 100, 16), True), ((0, 50, 300, 15), False),
        ((30, 50, 300, 15), True), ((29, 50, 300, 15), False), ((0, 5, 100, 0), False), ((0, 5, 0, 16), False), ((0, 1, 15, 16), False), ((0, 1, 16, 16), True),
    ]
    for (top_index, item_count, client_height, item_height), expected in scroll_cases:
        if ps_scrolled_to_end(top_index, item_count, client_height, item_height) != expected:
            problems.append(f"末尾まで表示したかの判定（写した版）が違います: TopIndex={top_index} 行数={item_count} 高さ={client_height} 行の高さ={item_height}")
    allowed_combinations = 0
    for blocked in (False, True):
        for reached in (False, True):
            for read in (False, True):
                for needs in (False, True):
                    for overwrite in (False, True):
                        allowed_combinations += 1
                        expected = (not blocked) and reached and read and ((not needs) or overwrite)
                        if ps_approval_allowed(blocked, reached, read, needs, overwrite) != expected:
                            problems.append(f"承認ボタンの可否（写した版）が違います: 禁止文字={blocked} 末尾={reached} 読了={read} 上書き要={needs} 上書き確認={overwrite}")
    mixed_cases = [
        ("paypal.md", False), ("p" + chr(0x430) + "ypal.md", True), ("docs/p" + chr(0x430) + "ypal", True), ("pay/" + chr(0x430) * 2, False),
        (chr(0x3B1) + chr(0x3B2), False), ("A" + chr(0x3B1), True), ("日本語", False), ("caf" + chr(0xE9), False), (chr(0x3A9) + "mega", True),
        ("test" + chr(0x37E) + "md", True), (chr(0xD7) + chr(0x430), False), (chr(0xF7) + chr(0x3B1), False), ("", False), ("E:\\work\\" + chr(0x41E) + "K", True),
        (chr(0x251) + chr(0x430), True), ("x" + chr(0xA64A), True), (chr(0x2C65) + chr(0x3B1), True),
    ]
    for value, expected in mixed_cases:
        if ps_mixed_script(value) != expected:
            problems.append(f"同形異字の判定（写した版）が違います: {ascii(value)} → {ps_mixed_script(value)}（期待 {expected}）")
    pure_needles = {
        "Test-MixedScriptText": ("$Text.Split([char[]]@('/', '\\'))", "($code -ge 0x41 -and $code -le 0x5A) -or ($code -ge 0x61 -and $code -le 0x7A) -or ($code -ge 0xC0 -and $code -le 0x2AF -and $code -ne 0xD7 -and $code -ne 0xF7) -or ($code -ge 0x1E00 -and $code -le 0x1EFF) -or ($code -ge 0x2C60 -and $code -le 0x2C7F) -or ($code -ge 0xA720 -and $code -le 0xA7FF)", "} elseif (($code -ge 0x400 -and $code -le 0x52F) -or ($code -ge 0x1C80 -and $code -le 0x1C8F) -or ($code -ge 0xA640 -and $code -le 0xA69F)) {", "} elseif (($code -ge 0x370 -and $code -le 0x3FF) -or ($code -ge 0x1F00 -and $code -le 0x1FFF)) {", "if ($hasLatin -and ($hasCyrillic -or $hasGreek)) { return $true }"),
        "Test-ExposureApproved": ("if ($state -isnot [string] -or $state -cne 'approved') { return $false }", "if ($approvedSha -isnot [string] -or $currentSha -isnot [string]) { return $false }", "return ($approvedSha -ceq $currentSha)"),
        "Test-ForeignApprovalOverwrite": ("-cne 'changed') { return $false }", "if ($null -eq $approvedRoot) { return $false }", "if ($approvedRoot -isnot [string]) { return $true }", "(Get-EntryValue -Entry $Report -Name 'projectRoot'),", "(Get-EntryValue -Entry (Get-EntryValue -Entry $Report -Name 'exposure') -Name 'projectRoot')", ") | Where-Object { $_ -is [string] }", "foreach ($currentRoot in @($currentRoots)) {", "if ([string]::Equals($currentRoot, $approvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }", "return $true"),
        "Get-ApprovalRootText": ("$text = 'プロジェクトルート: ' + (Format-DisplayValue -Text $root)", "if ($cliRoot -is [string] -and -not [string]::Equals($cliRoot, $root, [System.StringComparison]::Ordinal)) { $text += '（CLI が示したフォルダー: ' + (ConvertTo-DisplayQuoted -Text $cliRoot) + '）' }"),
        "Get-ExposureShapeProblem": ("if ($exposure -isnot [System.Management.Automation.PSCustomObject]) {", "$names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)", "foreach ($property in $exposure.PSObject.Properties) { [void]$names.Add([string]$property.Name) }", "foreach ($name in @('projectRoot', 'contextFile', 'statusFile')) {", "if (-not $names.Contains($name) -or $exposure.$name -isnot [string])", "foreach ($name in @('allowFiles', 'denyDirectories')) {", "$isValid = $names.Contains($name) -and $exposure.$name -is [System.Collections.IList]", "$directoriesValid = $names.Contains('allowDirectories')", "if ($item -isnot [string]) { $isValid = $false }", "(Get-EntryValue -Entry $rule -Name 'path') -isnot [string] -or (Get-EntryValue -Entry $rule -Name 'recursive') -isnot [bool]", "if (-not (($limit -is [int] -or $limit -is [long]) -and $limit -ge 0))", "(Get-EntryValue -Entry $git -Name 'paths') -isnot [bool] -or (Get-EntryValue -Entry $git -Name 'commitSubjects') -isnot [bool]"),
        "Get-ApprovalBlockReason": ("if ($ForbiddenField.Count -gt 0) {", "if ($ShapeProblem.Count -gt 0) {", "$shownCount = [Math]::Min(3, $ForbiddenField.Count)", "'設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。該当項目: ' + ($ForbiddenField[0..($shownCount - 1)] -join '、')", "$reason += \"、ほか $($ForbiddenField.Count - $shownCount) 件（全件は一覧の先頭）\"", "'公開範囲の形式が想定と違うため承認できません（件数を構造から確かめられません）。該当する欄: ' + ($ShapeProblem -join '、')"),
        "Get-ExposureRootValue": ("Get-EntryValue -Entry (Get-EntryValue -Entry $Report -Name 'exposure') -Name 'projectRoot'", "if ($exposureRoot -is [string]) { return $exposureRoot }"),
        "Add-ForbiddenField": ("if ($Depth -gt 16) {", "if ($Value -is [string]) {", "if (Test-ForbiddenCharacter -Text $Value) { $Found.Add($Path + ' = ' + (ConvertTo-DisplayQuoted -Text $Value)) }", "if ($Value -is [System.Management.Automation.PSCustomObject]) {", "$childPath = $Path + '.' + (ConvertTo-DisplayEscaped -Text $propertyName)", "$Found.Add($childPath + '（項目名）')", "if ($Value -is [System.Collections.IList]) {", "-Path ($Path + '[' + $itemIndex + ']')"),
        "Get-ForbiddenFieldList": ("@('projectRoot', 'profile', 'exposure', 'changes')",),
        "Get-ApprovalSummary": ("$recursiveCount = @($directories | Where-Object { Test-EntryNotFalse -Entry $_ -Name 'recursive' }).Count", "Test-EntryNotFalse -Entry $git -Name 'paths'", "Test-EntryNotFalse -Entry $git -Name 'commitSubjects'", "if ($limitText -cnotmatch '^[0-9]{1,12}\\z') { $limitText = ConvertTo-DisplayQuoted -Text $limitText }", 'CountLine = "公開ファイル $($files.Count) 件 / 公開ディレクトリ $($directories.Count) 件（うち配下すべて $($recursiveCount) 件） / 拒否ディレクトリ $($denied.Count) 件"'),
        "Test-EntryNotFalse": ("return (-not ($value -is [bool] -and $value -eq $false))",),
        "Get-ExposureChangeText": ("'\\A([A-Za-z]+): (.*)\\z', [System.Text.RegularExpressions.RegexOptions]::Singleline", "return '内容: ' + (ConvertTo-DisplayEscaped -Text $Change)", "if ($label -eq '') { $label = '不明な項目' }", "return $label + '（' + $fieldName + '）: ' + (ConvertTo-DisplayEscaped -Text $changeMatch.Groups[2].Value)"),
        "Get-ApprovalDetailLine": ('$lines.Add("【形式が想定と違う欄】$($ShapeProblem.Count) 件（件数を構造から確かめられないため、承認できません）")', "$lines.Add('  ' + (Get-ApprovalRootText -Report $Report))", "$knownNames = [System.Collections.Generic.HashSet[string]]::new([string[]]$script:KnownExposureFields, [System.StringComparer]::Ordinal)", "if (-not $knownNames.Contains([string]$property.Name)) { [string]$property.Name }", "$extraJson = ConvertTo-Json -InputObject $exposure.$extraName -Depth 20 -Compress", "$lines.Add('  - ' + (ConvertTo-DisplayEscaped -Text $extraName) + ': ' + (ConvertTo-DisplayEscaped -Text $extraJson))", '$lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$file)))', '$lines.Add("  $($number). " + (Format-DisplayValue -Text (Get-EntryText -Entry $rule -Name \'path\') -Suffix $scope))', '$lines.Add("  $($number). " + (Format-DisplayValue -Text ([string]$deniedDirectory)))', "$lines.Add('（一覧はここまでです）')", "foreach ($piece in @(Split-DisplayLine -Text $line)) { $result.Add([string]$piece) }"),
        "Split-DisplayLine": ("if ($Width -lt 2) { $Width = 2 }", "if ($Text.Length -le $Width) { return $Text }", "if (($position + $length) -lt $Text.Length -and [char]::IsHighSurrogate($Text[$position + $length - 1])) { $length-- }", "if ($isFirst) { $piece } else { $script:ContinuationMark + $piece }"),
        "Test-ListScrolledToEnd": ("if ($ItemCount -le 0) { return $true }", "if ($ItemHeight -le 0) { return $false }", "$visibleCount = [int][Math]::Floor($ClientHeight / $ItemHeight)", "return (($TopIndex + $visibleCount) -ge $ItemCount)"),
        "Test-ApprovalAllowed": ("if ($Blocked) { return $false }", "if (-not ($ReachedEnd -and $ReadChecked)) { return $false }", "if ($NeedsOverwriteConfirm -and -not $OverwriteChecked) { return $false }"),
        "Format-DisplayValue": ("$display = (ConvertTo-DisplayQuoted -Text $Text) + $Suffix", "if (Test-MixedScriptText -Text $Text) { $display += $script:MixedScriptMark }"),
    }
    # フォルダーの比較は [string]::Equals と OrdinalIgnoreCase で行う。-eq・-ieq・-cne・-inotcontains などはカルチャの比較で、
    # NFC と NFD・ゼロ幅文字・ケルビン記号だけが違う別のフォルダーを同じと見なすため使わない（$null との比較は除く）。
    overwrite_tail = body_of("Test-ForeignApprovalOverwrite").split("$approvedRoot = ")[1] if "$approvedRoot = " in body_of("Test-ForeignApprovalOverwrite") else ""
    if re.search(r"-[ci]?(?:eq|ne|contains|notcontains|in|notin)\b", overwrite_tail.replace("$null -eq ", "")):
        problems.append("別フォルダーの上書きの判定が、カルチャに依存する比較演算子でフォルダーを比べています（[string]::Equals と OrdinalIgnoreCase にする）")
    for function_name, needles in pure_needles.items():
        body = body_of(function_name)
        if not body:
            problems.append(f"{function_name} がありません")
            continue
        for needle in needles:
            if needle not in body:
                problems.append(f"{function_name} の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    for name, expected in (("MixedScriptMark", MIXED_SCRIPT_MARK), ("ContinuationMark", CONTINUATION_MARK), ("CliOutputMark", CLI_OUTPUT_MARK)):
        if f"$script:{name} = '{expected}'" not in source:
            problems.append(f"$script:{name} が写した版と違います")
    if f"$script:DisplayLineWidth = {DISPLAY_LINE_WIDTH}" not in source:
        problems.append("$script:DisplayLineWidth が写した版と違います")
    for label, function_name in sorted(EXPOSURE_FIELD_LABELS.items()):
        if f"'{label}' {{ return '{function_name}' }}" not in body_of("Get-ExposureFieldLabel"):
            problems.append(f"Get-ExposureFieldLabel の {label} が写した版と違います")
    for function_name in ("Format-EscapedText", "Test-ForbiddenCharacter", "Test-MixedScriptText", "Get-ForbiddenFieldList", "Add-ForbiddenField", "Get-ApprovalSummary", "Get-ApprovalDetailLine", "Test-ListScrolledToEnd", "Test-ApprovalAllowed", "Test-ForeignApprovalOverwrite", "Test-ExposureApproved", "Split-DisplayLine", "ConvertTo-ConsoleHelperSplat", "Format-LogLine"):
        if re.search(r"System\.Windows\.Forms|System\.Drawing|\$script:Ui\b", body_of(function_name)):
            problems.append(f"{function_name} が WinForms や画面の状態に依存しています（純粋関数にする）")
    report.check(f"15. 承認ダイアログの中身を作る純粋関数（禁止文字の検出・要約・一覧・上書き {len(overwrite_cases)} 件・承認済み {len(approved_cases)} 件・末尾の判定 {len(scroll_cases)} 件・承認ボタン {allowed_combinations} 通り・同形異字 {len(mixed_cases)} 件。範囲が Ubuntu 版の文字名による判定より広い {name_mismatches} 文字は参考）", problems)

    # 16. 承認ダイアログの構造（ListBox・固定の見出しと要約・禁止文字で承認無効・別フォルダー上書きの追加チェック・読了の確認）。
    problems = []
    dialog_needles = (
        "$forbiddenFields = Get-ForbiddenFieldList -Report $Report",
        "$needsOverwriteConfirm = [bool](Test-ForeignApprovalOverwrite -Report $Report)",
        "$summary = Get-ApprovalSummary -Report $Report",
        "New-GuiControl -TypeName 'ListBox'",
        "HorizontalScrollbar = $true",
        "SelectionMode = [System.Windows.Forms.SelectionMode]::None",
        "IntegralHeight = $false",
        "[void]$listBox.Items.Add($detailLine)",
        "Text = $summary.CountLine",
        "Text = $summary.GitPathsText",
        "Text = '/ ' + $summary.GitCommitSubjectsText",
        "Text = $summary.LimitLine",
        "Text = $summary.ShaLine",
        "if ($summary.GitPathsPublic) {",
        "if ($summary.GitCommitSubjectsPublic) {",
        "ForeColor = [System.Drawing.Color]::Red",
        "$shapeProblems = Get-ExposureShapeProblem -Report $Report",
        "$blockReasons = @(Get-ApprovalBlockReason -ForbiddenField $forbiddenFields.ToArray() -ShapeProblem $shapeProblems.ToArray())",
        "$blocked = [bool]($blockReasons.Count -gt 0)",
        "foreach ($blockReason in $blockReasons) {",
        "Text = $blockReason",
        "Text = '別のフォルダーの承認を上書きしてよいことを理解しました'",
        "Text = '内容を読みました'",
        "Text = 'この内容で承認'",
        "$timer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 150 })",
        "$timer.Tag = $state",
        "Update-ApprovalReadGate -State $this.Tag",
        "Update-ApprovalButtonState -State $this.Tag",
        "$dialog.Controls.Add($listBox)",
        "$dialog.Controls.Add($footerPanel)",
        "$dialog.Controls.Add($headerPanel)",
        "Text = '承認状態: ' + (Get-ApprovalHeaderStateText -Report $Report)",
        "Text = (Get-ApprovalRootText -Report $Report)",
        "Text = 'プロファイル（承認の保存先の名前）: ' + (Format-DisplayValue -Text (Get-EntryText -Entry $Report -Name 'profile'))",
        "Text = (ConvertTo-SafeLogLine -Text $Title)",
    )
    for needle in dialog_needles:
        if needle not in approval_dialog:
            problems.append(f"承認ダイアログに {needle} がありません")
    if "'TextBox'" in approval_dialog or "Multiline" in approval_dialog:
        problems.append("承認ダイアログに複数行の TextBox が残っています（ListBox にする）")
    if "Get-ExposureSummaryText" in source:
        problems.append("値の文字列から本文を作る古い Get-ExposureSummaryText が残っています")
    # 読了の確認・承認ボタンの初期値（Enabled = $false）が、それぞれのコントロールの定義の中にあること。
    for control_name in ("$readCheck", "$approveButton"):
        definition = re.search(re.escape(control_name) + r" = New-GuiControl .*?\}\)", approval_dialog, re.DOTALL)
        if definition is None or "Enabled = $false" not in definition.group(0):
            problems.append(f"{control_name} が無効（Enabled = $false）で作られていません")
    # 一覧（Fill）・下（Bottom）・上（Top）の Dock の指定。
    for variable, dock in (("$listBox", "Fill"), ("$footerPanel", "Bottom"), ("$headerPanel", "Top")):
        definition = re.search(re.escape(variable) + r" = New-GuiControl .*?\}\)", approval_dialog, re.DOTALL)
        if definition is None or f"Dock = [System.Windows.Forms.DockStyle]::{dock}" not in definition.group(0):
            problems.append(f"{variable} の Dock が {dock} ではありません")
    # 固定の要約と承認できない理由・上書きの警告は、一覧（ListBox）ではなく下の固定部分（$footerPanel）に置く。
    for variable in ("$countLabel", "$gitPanel", "$limitLabel", "$shaLabel", "$readPanel", "$buttonPanel"):
        if f"$footerPanel.Controls.Add({variable})" not in approval_dialog:
            problems.append(f"{variable} が固定の部分（$footerPanel）に置かれていません")
    for variable in ("$blockLabel", "$overwriteLabel", "$overwriteCheck"):
        if f"$footerPanel.Controls.Add({variable})" not in approval_dialog:
            problems.append(f"{variable} が固定の部分（$footerPanel）に置かれていません")
    for variable in ("$stateLabel", "$rootLabel", "$profileLabel", "$noteLabel", "$warningLabel"):
        if f"$headerPanel.Controls.Add({variable})" not in approval_dialog:
            problems.append(f"{variable} が固定の見出し（$headerPanel）に置かれていません")
    gate_body = body_of("Update-ApprovalReadGate")
    for needle in ("Test-ListScrolledToEnd -TopIndex $listBox.TopIndex -ItemCount $listBox.Items.Count -ClientHeight $listBox.ClientSize.Height -ItemHeight $listBox.ItemHeight", "$State.ReachedEnd = $true", "$State.ReadCheck.Enabled = $true", "$State.Timer.Stop()", "Update-ApprovalButtonState -State $State"):
        if needle not in gate_body:
            problems.append(f"Update-ApprovalReadGate に {needle} がありません")
    button_body = body_of("Update-ApprovalButtonState")
    if "$State.ApproveButton.Enabled = Test-ApprovalAllowed -Blocked $State.Blocked -ReachedEnd $State.ReachedEnd -ReadChecked ([bool]$State.ReadCheck.Checked) -NeedsOverwriteConfirm $State.NeedsOverwriteConfirm -OverwriteChecked $overwriteChecked" not in button_body:
        problems.append("Update-ApprovalButtonState が Test-ApprovalAllowed で承認ボタンを決めていません")
    for function_name in ("Complete-ExposureStep", "Complete-HubExposureStep"):
        body = body_of(function_name)
        if "if (Test-ExposureApproved -Report $report) {" not in body:
            problems.append(f"{function_name} が承認済みの判定に Test-ExposureApproved を使っていません")
        if re.search(r"approvalState\s*-c?eq\s*'approved'", body):
            problems.append(f"{function_name} に approvalState だけで承認済みとする判定が残っています")
    if "-ForbiddenField $forbiddenFields.ToArray() -ShapeProblem $shapeProblems.ToArray()" not in approval_dialog:
        problems.append("一覧に承認できない項目（禁止文字・形の崩れ）を渡していません")
    if "if (-not $State.Blocked) { $State.ReadHint.Text" not in gate_body:
        problems.append("承認できないときも「末尾まで表示しました」の案内に変えています")
    # 高 DPI で画面に収まらない問題: 表示の前に作業領域へ収め、最大化を許し、幅を変えたら文とボタンの並びの幅を合わせ直す（ボタンが右端で隠れない）。
    for needle in (
        "MaximizeBox = $true",
        "Resize-FormToWorkingArea -Form $dialog -WorkingArea (Get-DisplayWorkingArea -Owner $script:Ui.Form)",
        "$textWidth = Get-ApprovalTextWidth -ClientWidth $dialog.ClientSize.Width",
        "$dialog.Add_Resize({",
        "Update-ApprovalDialogWidth -State $this.Tag",
        "Dialog = $dialog",
        "WrapLabels = $wrapLabels",
        "ButtonPanel = $buttonPanel",
    ):
        if needle not in approval_dialog:
            problems.append(f"承認ダイアログに {needle} がありません")
    if "MaximizeBox = $false" in approval_dialog:
        problems.append("承認ダイアログの最大化を禁じています（狭い画面で一覧を広げられない）")
    for variable in ("$stateLabel", "$rootLabel", "$profileLabel", "$noteLabel", "$warningLabel", "$blockLabel", "$overwriteLabel", "$countLabel", "$limitLabel", "$shaLabel"):
        if f"$wrapLabels.Add({variable})" not in approval_dialog:
            problems.append(f"{variable} の折り返し幅を、ダイアログの幅に合わせ直していません")
    dialog_width_body = body_of("Update-ApprovalDialogWidth")
    for needle in ("$textWidth = Get-ApprovalTextWidth -ClientWidth $State.Dialog.ClientSize.Width", "$wrapLabel.MaximumSize = [System.Drawing.Size]::new($textWidth, 0)", "$State.ButtonPanel.Width = $textWidth"):
        if needle not in dialog_width_body:
            problems.append(f"Update-ApprovalDialogWidth に {needle} がありません")
    if "return [Math]::Max(200, $ClientWidth - 40)" not in body_of("Get-ApprovalTextWidth"):
        problems.append("Get-ApprovalTextWidth が、ダイアログの中の幅から 40 を引いた幅（既定の大きさで 840）になっていません")
    resize_body = body_of("Resize-FormToWorkingArea")
    for needle in ("$Form.MinimumSize = [System.Drawing.Size]::new([Math]::Min($minimum.Width, $maxWidth), [Math]::Min($minimum.Height, $maxHeight))", "$Form.Size = [System.Drawing.Size]::new([Math]::Min($current.Width, $maxWidth), [Math]::Min($current.Height, $maxHeight))"):
        if needle not in resize_body:
            problems.append(f"Resize-FormToWorkingArea に {needle} がありません")
    if "Resize-FormToWorkingArea -Form $form -WorkingArea (Get-DisplayWorkingArea)" not in body_of("New-BridgeForm"):
        problems.append("主画面を表示する前に、作業領域へ収めていません")
    report.check(f"16. 承認ダイアログの構造（ListBox・固定の見出しと要約・禁止文字で承認無効・別フォルダー上書きの追加チェック・読了の確認。要点 {len(dialog_needles)} 件）", problems)

    # 17. 別のコンソール窓（-ConsoleHelper）と、窓が開いている間の実行ボタン。
    problems = []
    param_match = re.search(r"\[CmdletBinding\(PositionalBinding = \$false\)\]\nparam\((.*?)\n\)", source, re.DOTALL)
    gui_parameters: dict[str, str] = {}
    if param_match is None:
        problems.append("先頭の [CmdletBinding(PositionalBinding = $false)] と param ブロックが見つかりません")
    else:
        gui_parameters = {name: kind for kind, name in re.findall(r"\[(switch|string)\]\$(\w+)", param_match.group(1))}
    helper_table = read_script_table(source, "ConsoleHelperParameters")
    helper_switches = read_script_array(source, "ConsoleHelperSwitches")
    key_actions = read_script_array(source, "KeyConsoleActions")
    if sorted(key_actions) != ["AddProject", "HubAdd", "SaveKey"]:
        problems.append(f"$script:KeyConsoleActions が想定と違います: {key_actions}")
    if sorted(helper_table) != sorted(key_actions):
        problems.append(f"$script:ConsoleHelperParameters の Action が、キーを聞く Action と違います: {sorted(helper_table)}")
    flag_options = {pascal_name(name) for name, option in help_data["options"].items() if option.get("kind") == "flag"}
    for action_name, allowed_names in helper_table.items():
        entry = help_data["actions"].get(kebab_by_pascal.get(action_name, ""), {})
        expected_names = {pascal_name(option) for option in entry.get("options", []) if platform_option_allowed(entry, option) and pascal_name(option) in cli_parameters}
        if set(allowed_names) != expected_names:
            problems.append(f"{action_name} の補助役のパラメーターが、説明データの options と違います: {sorted(allowed_names)}（期待 {sorted(expected_names)}）")
        for name in allowed_names:
            expected_kind = "switch" if name in flag_options else "string"
            if gui_parameters.get(name) != expected_kind:
                problems.append(f"補助役のパラメーター {name} が、GUI の param に [{expected_kind}] で宣言されていません")
            if (name in helper_switches) != (name in flag_options):
                problems.append(f"補助役のチェックの一覧（$script:ConsoleHelperSwitches）と、説明データの flag が {name} で食い違います")
    for name in ("StaRelaunched", "ConsoleHelper"):
        if gui_parameters.get(name) != "switch":
            problems.append(f"GUI の param に [switch]${name} がありません")
    helper_union = {name for names in helper_table.values() for name in names}
    extra_parameters = set(gui_parameters) - helper_union - {"StaRelaunched", "ConsoleHelper", "Action"}
    if extra_parameters:
        problems.append(f"GUI の param に、補助役で使わないパラメーターがあります: {sorted(extra_parameters)}")
    # 補助役の引数の検査を、写した版で確かめる（依頼の規則どおりの期待と比べる）。
    forced = read_script_array(source, "ForcedNoStartActions")
    valid_hub = {"ConsoleHelper": True, "Action": "HubAdd", "ProjectRoot": "E:\\作業 フォルダー\\ProjA", "ProjectName": "ProjA", "NoStart": True, "ExposureSha256": sha_current}
    helper_cases = [
        (valid_hub, {"Action": "HubAdd", "ProjectRoot": "E:\\作業 フォルダー\\ProjA", "ProjectName": "ProjA", "NoStart": True, "ExposureSha256": sha_current}),
        ({"ConsoleHelper": True, "Action": "SaveKey", "ProjectRoot": "E:\\p", "ReplaceKey": False}, {"Action": "SaveKey", "ProjectRoot": "E:\\p"}),
        ({key: value for key, value in valid_hub.items() if key != "NoStart"}, None),
        ({**valid_hub, "NoStart": False}, None),
        ({"ConsoleHelper": True, "Action": "SaveKey", "ProjectRoot": "E:\\p", "HubName": "x"}, None),
        ({"ConsoleHelper": True, "Action": "Start", "ProjectRoot": "E:\\p"}, None),
        ({"ConsoleHelper": True, "Action": "hubadd", "NoStart": True}, None),
        ({"ConsoleHelper": True, "Action": "SaveKey"}, {"Action": "SaveKey"}),
        ({"ConsoleHelper": True}, None),
        ({**valid_hub, "StaRelaunched": True}, None),
        ({**valid_hub, "ProjectName": "-x"}, None),
        ({**valid_hub, "ProjectName": "\u2013x"}, None),
        ({**valid_hub, "ProjectName": "a" + chr(0x202E) + "b"}, None),
        ({**valid_hub, "ProjectName": "  "}, None),
        ({**valid_hub, "ExposureSha256": sha_current.upper()}, None),
        ({**valid_hub, "ExposureSha256": sha_current[:63]}, None),
        ({**valid_hub, "ExposureSha256": sha_current + chr(0x0A)}, None),
        ({**valid_hub, "Force": True}, None),
        ({**valid_hub, "NoBrowser": "yes"}, None),
        ({"Action": "SaveKey"}, None),
    ]
    for bound, expected in helper_cases:
        try:
            actual = ps_console_splat(bound, key_actions, helper_table, helper_switches, forced)
        except ValueError:
            actual = None
        if actual != expected:
            problems.append(f"補助役の引数の検査（写した版）が違います: {ascii(bound)} → {ascii(actual)}（期待 {ascii(expected)}）")
    splat_body = body_of("ConvertTo-ConsoleHelperSplat")
    for needle in (
        "if (-not $BoundParameters.Contains('ConsoleHelper')) { throw",
        "if ($BoundParameters.Contains('StaRelaunched')) { throw",
        "if ($actionName -isnot [string] -or $script:KeyConsoleActions -cnotcontains $actionName) { throw",
        "$allowed = $script:ConsoleHelperParameters[$actionName]",
        "if ($allowed -cnotcontains $name) { throw",
        "if ($script:ConsoleHelperSwitches -ccontains $name) {",
        "if ($isOn) { $splat[$name] = $true }",
        "if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw",
        "if (Test-DashLeadingValue -Value $value) { throw",
        "if (Test-ForbiddenCharacter -Text $value) { throw",
        "if ($name -ceq 'ExposureSha256' -and $value -cnotmatch '^[0-9a-f]{64}\\z') { throw",
        "if ($script:ForcedNoStartActions -ccontains $actionName -and -not $splat.ContainsKey('NoStart')) { throw",
    ):
        if needle not in splat_body:
            problems.append(f"ConvertTo-ConsoleHelperSplat に {needle} がありません")
    helper_body = body_of("Invoke-ConsoleHelper")
    for needle in ("$splat = ConvertTo-ConsoleHelperSplat -BoundParameters $BoundParameters", "$global:LASTEXITCODE = 0", "& $script:CliPath @splat | Out-Host", "$exitCode = [int]$global:LASTEXITCODE", "Wait-ConsoleEnter -ExitCode $exitCode", "exit $exitCode", "『Runtime API Key』の入力待ちになったときだけ貼り付けてください。入力した内容は表示されません。"):
        if needle not in helper_body:
            problems.append(f"Invoke-ConsoleHelper に {needle} がありません")
    # CLI の exit の終了コードを拾う（呼ぶ前に 0 にし、呼んだ後の $LASTEXITCODE を使う。0 と決め打ちしない）。
    if not (0 <= helper_body.find("$global:LASTEXITCODE = 0") < helper_body.find("& $script:CliPath @splat | Out-Host") < helper_body.find("$exitCode = [int]$global:LASTEXITCODE")):
        problems.append("Invoke-ConsoleHelper が、CLI を呼ぶ前に $LASTEXITCODE を 0 にし、呼んだ後の値を終了コードにしていません")
    if re.search(r"Out-Host\n\s*\$exitCode = 0\b", helper_body):
        problems.append("Invoke-ConsoleHelper が CLI の終了コードを拾わず 0 と決め打ちしています")
    # CLI が正常に終わったときは、途中で呼んだ外部コマンドの終了コードが $LASTEXITCODE に残っていても 0 にする（pwsh -File で起動したときと同じ結果）。
    if "$succeeded = $?" not in helper_body or "if ($succeeded) { $exitCode = 0 }" not in helper_body:
        problems.append("Invoke-ConsoleHelper が、CLI が正常に終わったときの終了コードを 0 にしていません（途中の外部コマンドの終了コードが残る）")
    wait_body = body_of("Wait-ConsoleEnter")
    for needle in ("while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }", "$keyInfo = [Console]::ReadKey($true)", "if ($keyInfo.Key -eq [System.ConsoleKey]::Enter) { break }", "Enter キーで閉じます。"):
        if needle not in wait_body:
            problems.append(f"Wait-ConsoleEnter に {needle} がありません")
    if re.search(r"ReadKey\(\s*\$false\s*\)|ReadKey\(\s*\)|ReadLine\(", source):
        problems.append("入力を表示する ReadKey($false)・ReadKey()・ReadLine() があります（貼り付けたキーを表示しない）")
    for function_name in ("Invoke-ConsoleHelper", "Wait-ConsoleEnter", "Write-ConsoleText", "ConvertTo-ConsoleHelperSplat"):
        if re.search(r"System\.Windows\.Forms|Add-Type|Start-BridgeGui|New-Gui", body_of(function_name)):
            problems.append(f"補助役の {function_name} が WinForms や画面を使っています")
    entry_match = re.search(r"if \(\$MyInvocation\.InvocationName -ne '\.'\) \{\n    if \(\$script:IsConsoleHelper\) \{\n        Invoke-ConsoleHelper -BoundParameters \$script:LaunchParameters\n    \} else \{\n        try \{\n            Assert-GuiLaunchParameter -BoundParameters \$script:LaunchParameters\n            Start-BridgeGui\n        \} catch \{\n            Show-StartupError -ErrorRecord \$_\n            exit 1\n        \}\n    \}\n\}", source)
    if entry_match is None:
        problems.append("入口が「補助役なら Invoke-ConsoleHelper、そうでなければ try の中で Assert-GuiLaunchParameter と Start-BridgeGui、例外なら Show-StartupError と exit 1」になっていません（ランチャーはコンソールを隠すため、起動の例外が見えない）")
    if "if ([string]$key -cne 'StaRelaunched') { throw" not in body_of("Assert-GuiLaunchParameter"):
        problems.append("Assert-GuiLaunchParameter が -StaRelaunched 以外の引数を拒んでいません")
    if "foreach ($launchEntry in $PSBoundParameters.GetEnumerator())" not in source:
        problems.append("起動時の引数（$PSBoundParameters）を写していません")
    # 窓が開いている間は、何も書き換えない Action だけを押せること。
    read_only = set(read_script_array(source, "ReadOnlyActions"))
    if read_only != {"Test", "Doctor", "Status", "ShowExposure", "HubList", "HubDoctor", "HubStatus", "HubPermissions"}:
        problems.append(f"$script:ReadOnlyActions が想定と違います: {sorted(read_only)}")
    for action_name in sorted(read_only):
        effect = str(help_data["actions"].get(kebab_by_pascal.get(action_name, ""), {}).get("effect", ""))
        if not any(word in effect for word in ("書き換えません", "書き込みません", "読み取り専用")):
            problems.append(f"{action_name} の effect が「書き換えない」ことを示していません: {effect}")
    for action_name in ("HubAdd", "HubRemove", "HubStart", "HubRestart", "HubStop", "AddProject", "SaveKey", "ConfigureTunnel", "Approve", "HubServiceInstall", "HubServiceUninstall", "Init", "Update", "Start", "ExportSkill", "ExportBundle", "UpdateLock", "SetPermission"):
        if action_name in read_only:
            problems.append(f"設定を変える Action {action_name} が、窓が開いている間も押せる一覧にあります")
    if not auxiliary <= read_only:
        problems.append("補助の Action が、何も書き換えない Action の一覧に含まれていません")
    enabled_body = body_of("Test-RunButtonEnabled")
    if "if ($ConsoleRunning -and $script:ReadOnlyActions -notcontains $ActionName) { return $false }" not in enabled_body:
        problems.append("Test-RunButtonEnabled が、別のコンソール窓が開いている間の制限を持っていません")
    console_combinations = 0
    for action_name in sorted(kebab_by_pascal):
        for busy in (False, True):
            for foreground_running in ((False,) if not busy else (False, True)):
                for auxiliary_running in (False, True):
                    for console_running in (False, True):
                        console_combinations += 1
                        mine = (False if console_running and action_name not in read_only else run_button_enabled(action_name, busy, foreground_running, auxiliary_running, auxiliary))
                        expected = expected_enabled(action_name, busy, foreground_running, auxiliary_running) and (not console_running or action_name in {"Test", "Doctor", "Status", "ShowExposure", "HubList", "HubDoctor", "HubStatus", "HubPermissions"})
                        if mine != expected:
                            problems.append(f"窓が開いている間の実行ボタンの可否が違います: {action_name} 窓={console_running}")
    for needle, function_name in (
        ("-ConsoleRunning $consoleRunning", "Update-ButtonState"),
        ("-ConsoleRunning $consoleRunning", "Invoke-ActionCard"),
        ("Update-ConsoleState", "Update-CliJobState"),
        ("if ($script:Ui.Jobs.Count -eq 0 -and $null -eq $script:Ui.ConsoleProcess) { $script:Ui.Timer.Stop() }", "Update-CliJobState"),
        ("$script:Ui.ConsoleProcess = $null", "Update-ConsoleState"),
        ("Update-HubListView", "Update-ConsoleState"),
        ("Update-HubListView", "Complete-Flow"),
        ("Update-HubListView", "Clear-AuxiliaryJob"),
        ("Update-ButtonState", "Update-ConsoleState"),
        ("$consoleRunning = [bool](Test-ConsoleProcessRunning)", "Confirm-WindowClose"),
        ("この画面を閉じても、その窓の CLI は止めません。", "Confirm-WindowClose"),
        ("if (Test-ConsoleProcessRunning) { throw", "Start-KeyConsole"),
        ("『Runtime API Key』の入力待ちになったときだけ", "Start-KeyConsole"),
    ):
        if needle not in body_of(function_name):
            problems.append(f"{function_name} に {needle} がありません")
    if re.search(r"Stop-JobProcessTree[^\n]*ConsoleProcess|ConsoleProcess[^\n]*\.Kill\(", source):
        problems.append("閉じるときに別のコンソール窓を止めています（止めずに知らせるだけにする）")
    report.check(f"17. 別のコンソール窓（-ConsoleHelper。補助役の引数の検査 {len(helper_cases)} 件・窓が開いている間の可否 {console_combinations} 通り）", problems)

    # 18. ログ欄の行の無害化（CLI の出力の印・禁止文字の置換・書く入口が 1 つ）。
    problems = []
    appends = [line_of(code, match.start()) for match in re.finditer(r"\.AppendText\(", code)]
    log_body = body_of("Add-LogLine")
    if len(appends) != 1 or ".AppendText(" not in log_body:
        problems.append(f"ログ欄へ書く AppendText が Add-LogLine の 1 か所ではありません: {appends} 行")
    if "foreach ($formatted in @(Format-LogLine -Line $Line -LinePrefix $LinePrefix -FromCli:$FromCli)) {" not in log_body:
        problems.append("Add-LogLine が全ての行を Format-LogLine で無害化していません")
    format_body = body_of("Format-LogLine")
    for needle in ("$mark = if ($FromCli) { $script:CliOutputMark } else { '' }", "foreach ($piece in @(Split-LogText -Text $Line)) {", "$LinePrefix + $mark + (ConvertTo-SafeLogLine -Text $piece)"):
        if needle not in format_body:
            problems.append(f"Format-LogLine に {needle} がありません")
    if 'return ($Text -split "`r?`n")' not in body_of("Split-LogText"):
        problems.append("Split-LogText が CR LF と LF で分けていません")
    if re.search(r"\.Text\s*=\s*\$commandText\b", source) or "$script:Ui.CommandBox.Text = ConvertTo-SafeLogLine -Text $commandText" not in body_of("Set-CommandDisplay"):
        problems.append("「実行されるコマンド」欄を無害化せずに出しています")
    if body_of("Receive-ExposureReport").count("-FromCli") != 2:
        problems.append("ShowExposure の生の出力に CLI の印を付けていません")
    if "ConvertTo-SafeLogLine -Text $project.Name" not in body_of("Update-HubListView") or "ConvertTo-SafeLogLine -Text $project.Root" not in body_of("Update-HubListView"):
        problems.append("登録一覧（hub.json の値）を無害化せずに出しています")
    log_cases = [
        (("out" + chr(0x0D) + "fake", "", True), ["│ out\\x0dfake"]),
        (("a" + chr(0x0D) + chr(0x0A) + "b" + chr(0x0A) + "c", "", False), ["a", "b", "c"]),
        (("x" + chr(0x2028) + "y", "[HubStatus] ", True), ["[HubStatus] │ x\\u2028y"]),
        (("", "", False), [""]),
        (("終了コード 0", "", False), ["終了コード 0"]),
    ]
    for (line, prefix, from_cli), expected in log_cases:
        if ps_format_log(line, prefix, from_cli) != expected:
            problems.append(f"ログの行（写した版）が違います: {ascii(line)} → {ascii(ps_format_log(line, prefix, from_cli))}（期待 {ascii(expected)}）")
    report.check(f"18. ログ欄の行の無害化（CLI の出力に「│ 」・禁止文字を \\x / \\u・書く入口は Add-LogLine だけ。写した版 {len(log_cases)} 件）", problems)

    # 19. 引数の組み立て（パラメーター名は名前全体の一致・GUI が決めるパラメーター・正規表現の末尾は \z・真偽値の型）。
    problems = []
    managed_parameters = read_script_array(source, "GuiManagedParameters")
    if sorted(managed_parameters) != ["Action", "ExposureSha256", "Service"]:
        problems.append(f"$script:GuiManagedParameters が想定と違います: {managed_parameters}")
    resolve_cases = [
        ("project-root", "ProjectRoot"), ("hub-name", "HubName"), ("no-start", "NoStart"), ("exposure-sha256", None), ("exposure-sha-256", None),
        ("service", None), ("action", None), ("proj", None), ("project", None), ("exposure", None), ("Project-Root", None), ("project--root", None),
        ("project-root-", None), ("", None), ("no-enable", None),
    ]
    for option, expected in resolve_cases:
        if ps_resolve_parameter(option, cli_parameters, managed_parameters) != expected:
            problems.append(f"パラメーター名の照合（写した版）が違います: {option!r} → {ps_resolve_parameter(option, cli_parameters, managed_parameters)}（期待 {expected}）")
    resolve_body = body_of("Resolve-CliParameterName")
    for needle in ("if ($OptionName -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*\\z') { throw", "if ($script:GuiManagedParameters -contains $parameterName) { throw", "if (@($CliParameters) -cnotcontains $parameterName) { throw"):
        if needle not in resolve_body:
            problems.append(f"Resolve-CliParameterName に {needle} がありません")
    if re.search(r"-like|StartsWith|-match\s+\"\^\$\(", resolve_body):
        problems.append("Resolve-CliParameterName が前方一致などで照合しています")
    for needle in ("$parameterName = Resolve-CliParameterName -OptionName $optionName -CliParameters $CliParameters", "$arguments.Add('-' + (Resolve-CliParameterName -OptionName $flag -CliParameters $CliParameters))", "if (Test-ForbiddenCharacter -Text $value) { throw"):
        if needle not in argument_body:
            problems.append(f"New-CliArgumentList に {needle} がありません")
    if re.search(r"ConvertTo-PascalName", argument_body):
        problems.append("New-CliArgumentList が照合せずに ConvertTo-PascalName の結果を使っています")
    approval_argument_body = body_of("Add-ApprovedExposureArgument")
    if "$Approval.ApprovedByUser -isnot [bool]" not in approval_argument_body or "$Approval.Sha256 -isnot [string]" not in approval_argument_body:
        problems.append("Add-ApprovedExposureArgument が承認の結果の型（[bool]・[string]）を確かめていません")
    for match in re.finditer(r"-c?i?(?:not)?match\s+'([^']*)'", source):
        if match.group(1).endswith("$"):
            problems.append(f"正規表現の末尾が $ です（末尾の改行を許すため \\z にする）: {line_of(source, match.start())} 行: {match.group(0)}")
    for match in re.finditer(r"\[regex\]::Match\([^,]+,\s*'([^']*)'", source):
        if match.group(1).endswith("$"):
            problems.append(f"正規表現の末尾が $ です: {line_of(source, match.start())} 行")
    report.check(f"19. 引数の組み立て（パラメーター名は名前全体の一致 {len(resolve_cases)} 件・GUI が決めるパラメーター・正規表現の末尾 \\z・承認の結果の型）", problems)

    # 20. pwsh を起動する全ての箇所に -NoProfile があること。
    problems = []
    if "    $arguments.Add('-NoProfile')\n" not in argument_body:
        problems.append("New-CliArgumentList が -NoProfile を常に加えていません")
    for match in re.finditer(r"Start-CliJob\s+-ArgumentList\s+\$(\w+)", code):
        owner = enclosing_function(ranges, match.start())
        if f"${match.group(1)} = New-CliArgumentList" not in body_of(owner):
            problems.append(f"Start-CliJob へ New-CliArgumentList で作っていない引数を渡しています: {line_of(code, match.start())} 行（{owner}）")
    start_process = [(line_of(code, match.start()), enclosing_function(ranges, match.start())) for match in re.finditer(r"Start-Process\b", code)]
    for line_number, owner in start_process:
        line_text = lines[line_number - 1]
        if owner == "Start-BridgeGui":
            if "'-NoProfile'" not in line_text:
                problems.append(f"STA の起動し直しに -NoProfile がありません: {line_number} 行")
        elif owner == "Start-KeyConsole":
            key_body = body_of(owner)
            if "$arguments = New-CliArgumentList" not in key_body or "$commandLine = Join-CommandLine -ArgumentList $arguments.ToArray()" not in key_body or "-ArgumentList $commandLine" not in line_text:
                problems.append(f"別のコンソール窓の起動が New-CliArgumentList（-NoProfile 付き）の引数を使っていません: {line_number} 行")
        else:
            problems.append(f"想定外の場所の Start-Process: {line_number} 行（{owner or '外側'}）")
    if len(start_process) != 2:
        problems.append(f"Start-Process が STA の起動し直しと別のコンソール窓の 2 か所ではありません: {start_process}")
    for pattern, expected_owner in ((r"ProcessStartInfo\]::new", "Start-CliJob"), (r"Diagnostics\.Process\]::Start\(", "Start-CliJob")):
        owners = {enclosing_function(ranges, match.start()) for match in re.finditer(pattern, code)}
        if owners != {expected_owner}:
            problems.append(f"{pattern} が {expected_owner} の外にあります: {owners}")
    if "foreach ($argument in $ArgumentList) { $startInfo.ArgumentList.Add($argument) }" not in body_of("Start-CliJob"):
        problems.append("Start-CliJob が、受け取った引数配列（New-CliArgumentList の結果）だけを渡していません")
    report.check(f"20. pwsh を起動する全ての箇所（子プロセス・別のコンソール窓・STA の起動し直し。Start-Process {len(start_process)} 箇所）に -NoProfile があること", problems)

    # 21. ソースの文字（生の特殊文字が無いこと）と、二重引用符の文字列の中の変数名。
    problems = []
    for path, text in ((GUI_PATH, source), (Path(__file__).resolve(), Path(__file__).resolve().read_text(encoding="utf-8").removeprefix("\ufeff"))):
        for line_number, line_text in enumerate(text.split("\n"), start=1):
            for character in line_text:
                category = unicodedata.category(character)
                if (category in FORBIDDEN_CATEGORIES and character not in "\r") or (category == "Zs" and character != " "):
                    problems.append(f"{path.name} の {line_number} 行に生の特殊文字 U+{ord(character):04X}（{category}）があります（[char]0x… や chr() で組み立てる）")
    scopes = {"script", "global", "local", "private", "using", "env", "variable", "function"}
    for token in lexed.strings:
        if token.kind == "single":
            continue
        for match in re.finditer(r"\$([^\W\d]\w*)(:?)", token.content):
            name, colon = match.group(1), match.group(2)
            if not name.isascii():
                problems.append(f"{token.line} 行: 文字列の中の変数名に日本語が続いています（${name}。$() で区切る）")
            if colon and name.lower() not in scopes:
                problems.append(f"{token.line} 行: 文字列の中の ${name}: が変数名の一部として読まれます（$() で区切る）")
    report.check("21. ソースに生の特殊文字（制御・書式・行区切り・U+0020 以外の空白類）が無く、文字列の中の変数名が日本語や : を取り込まないこと", problems)

    # 22. Ubuntu 版とそろえた振る舞い（上書き系のチェックを実行の始めにオフ・パスの欄の整え方・ハブの起動前の確認・ツールチップの折り返し・起動の失敗の表示）。
    problems = []
    reset_body = body_of("Reset-DangerousOption")
    for needle in ("if (-not (Test-EntryFlag -Entry $option -Name 'dangerous')) { continue }", "$checkBox.Checked = $false", "は、この実行にだけ付けます（チェックはオフに戻しました）。"):
        if needle not in reset_body:
            problems.append(f"Reset-DangerousOption に {needle} がありません")
    flags_position = invoke_body.find("$flags = @(Get-CardFlag -Card $Card)")
    flow_position = invoke_body.find("$script:Ui.Flow = @{")
    reset_position = invoke_body.find("Reset-DangerousOption -Card $Card")
    if not (0 <= flags_position < flow_position < reset_position):
        problems.append("Invoke-ActionCard が、チェックを集めて操作を始めたあとに Reset-DangerousOption を呼んでいません（上書き系のチェックが実行後もオンのまま残る）")
    # 画面に欄を出す上書き系のオプションは、オフに戻せるチェック（flag）であること。この画面が決めるオプション（exposure-sha256 など）は欄を出さないので対象外。
    for option_name, option in help_data["options"].items():
        if option.get("dangerous") is True and option.get("kind") != "flag" and option_name not in gui_managed:
            problems.append(f"上書き系のオプション {option_name} がチェック（flag）ではありません")
    if "次の 1 回の実行だけに効き、実行を始めるとオフに戻ります" not in body_of("Show-DangerConfirmDialog"):
        problems.append("上書き系の確認ダイアログの本文が「次の 1 回の実行だけ」になっていません（Ubuntu 版と同じ扱い）")
    # パスの欄の値（ps1 の ConvertTo-InputPath を写した版と、Windows で確かめた例）。
    def input_path(text: str, home: str) -> str:
        value = text.strip()
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1].strip()
        if not home.strip():
            return value
        if value == "~":
            return home
        if value.startswith("~\\") or value.startswith("~/"):
            return home.rstrip("\\/") + "\\" + value[2:].lstrip("\\/").replace("/", "\\")
        return value
    home_example = "C:\\Users\\テスト ユーザー"
    path_cases = [
        ('  "C:\\Work\\ProjA"  ', "C:\\Work\\ProjA"), ('"C:\\Work\\Proj A"', "C:\\Work\\Proj A"), ("C:\\Work\\ProjA", "C:\\Work\\ProjA"),
        ("~", home_example), ("~\\ProjA", home_example + "\\ProjA"), ("~/ProjA/sub", home_example + "\\ProjA\\sub"), ('"~\\ProjA"', home_example + "\\ProjA"),
        ("~user\\ProjA", "~user\\ProjA"), ("ProjA", "ProjA"), ('"', '"'), ('""', ""), ('"C:\\a', '"C:\\a'), ("", ""),
        ("~" + chr(0x200B), "~" + chr(0x200B)), (chr(0x200B) + '"C:\\a"', chr(0x200B) + '"C:\\a"'),
        ('" C:\\Work\\ProjA "', "C:\\Work\\ProjA"), ('" ~\\ProjA "', home_example + "\\ProjA"), ('" "', ""),
    ]
    for value, expected in path_cases:
        if input_path(value, home_example) != expected:
            problems.append(f"パスの欄の整え方（写した版）が違います: {ascii(value)} → {ascii(input_path(value, home_example))}（期待 {ascii(expected)}）")
    input_body = body_of("ConvertTo-InputPath")
    for needle in (
        "$value = ([string]$Text).Trim()",
        "if ($value.Length -ge 2 -and $value.StartsWith([char]'\"') -and $value.EndsWith([char]'\"')) { $value = $value.Substring(1, $value.Length - 2).Trim() }",
        "if ([string]::IsNullOrWhiteSpace($HomePath)) { return $value }",
        "if ([string]::Equals($value, '~', [System.StringComparison]::Ordinal)) { return $HomePath }",
        "if ($value.StartsWith('~\\', [System.StringComparison]::Ordinal) -or $value.StartsWith('~/', [System.StringComparison]::Ordinal)) { return (Join-Path $HomePath $value.Substring(2)) }",
    ):
        if needle not in input_body:
            problems.append(f"ConvertTo-InputPath の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    card_value_body = body_of("Get-CardValue")
    if "if ($Card.Kinds[$optionName] -eq 'path') {" not in card_value_body or "$values[$optionName] = ConvertTo-InputPath -Text ([string]$control.Text) -HomePath $env:USERPROFILE" not in card_value_body:
        problems.append("Get-CardValue が、パスの欄の値を ConvertTo-InputPath で整えていません（足場の判定と CLI への引数が同じ値にならない）")
    if "ConvertTo-InputPath -Text ([string]$textBox.Text) -HomePath $env:USERPROFILE" not in body_of("Select-PathForInput"):
        problems.append("Select-PathForInput が、選択画面の始まりの場所を実行のときと同じ形で決めていません")
    # ハブの起動前の確認（hub.json を読めなければ中止・プロファイル名を求められない登録は承認しない）。
    hub_flow_body = body_of("Start-HubApprovalFlow")
    catch_start = hub_flow_body.find("} catch {")
    catch_part = hub_flow_body[catch_start : hub_flow_body.find("$flow.HubQueue = ")] if catch_start >= 0 else ""
    if "Complete-Flow" not in catch_part or "return" not in catch_part or "Start-NextHubExposure" in catch_part or "Show-GuiMessage" not in catch_part:
        problems.append("Start-HubApprovalFlow が、hub.json を読めないときに知らせて中止していません（確認を飛ばして -Service の起動へ進む）")
    next_body = body_of("Start-NextHubExposure")
    if "if ($profileName -eq '') {" not in next_body or next_body.count("$flow.HubUnverifiable.Add([string]$project.Name)") != 2:
        problems.append("Start-NextHubExposure が、フォルダーやプロファイル名を求められない登録を「確かめられない」として飛ばしていません")
    if "$values = [ordered]@{ 'project-root' = $project.Root; 'profile' = $profileName }" not in next_body:
        problems.append("Start-NextHubExposure が、承認ファイル名から求めたプロファイル名で公開範囲を確かめていません")
    hub_step_body = body_of("Complete-HubExposureStep")
    if "$values = [ordered]@{ 'project-root' = $project.Root; 'profile' = $profileName }" not in hub_step_body or "[string]::Equals((Get-EntryText -Entry $report -Name 'profile'), $profileName, [System.StringComparison]::Ordinal)" not in hub_step_body:
        problems.append("Complete-HubExposureStep が、承認ファイル名から求めたプロファイル名だけで承認を確かめて保存していません")
    if "HubUnverifiable = [System.Collections.Generic.List[string]]::new()" not in invoke_body:
        problems.append("Invoke-ActionCard の操作の状態に HubUnverifiable がありません")
    # ツールチップの折り返し（Ubuntu 版の wrap_display_text と同じ規則・同じ幅）。
    ps_columns_match = re.search(r"^\$script:ToolTipColumns = (\d+) ", source, re.M)
    ps_break_match = re.search(r"^\$script:WrapBreakAfter = '([^']*)'", source, re.M)
    ps_no_start_match = re.search(r"^\$script:WrapNoLineStart = '([^']*)'", source, re.M)
    ranges_match = re.search(r"^\$script:WideCharacterRanges = @\((.*?)\)", source, re.M | re.S)
    if ps_columns_match is None or ps_break_match is None or ps_no_start_match is None or ranges_match is None:
        problems.append("ps1 に $script:ToolTipColumns・$script:WrapBreakAfter・$script:WrapNoLineStart・$script:WideCharacterRanges のどれかがありません")
    ps_columns = int(ps_columns_match.group(1)) if ps_columns_match else 0
    ps_break_after = ps_break_match.group(1) if ps_break_match else ""
    ps_no_line_start = ps_no_start_match.group(1) if ps_no_start_match else ""
    wide_numbers = [int(value, 16) for value in re.findall(r"0x([0-9A-Fa-f]+)", ranges_match.group(1))] if ranges_match else []
    wide_ranges = list(zip(wide_numbers[0::2], wide_numbers[1::2]))
    if len(wide_numbers) % 2 != 0 or any(start > end for start, end in wide_ranges) or any(wide_ranges[index][1] >= wide_ranges[index + 1][0] for index in range(len(wide_ranges) - 1)):
        problems.append("$script:WideCharacterRanges が「開始, 終了」の組の、重ならない昇順の並びではありません（Get-DisplayCharacterWidth は昇順を前提に途中で打ち切る）")
    if wide_ranges and wide_ranges[0][0] != 0x1100:
        problems.append("$script:WideCharacterRanges の最初の範囲が U+1100 から始まっていません（Get-DisplayCharacterWidth の U+1100 未満は 1 の近道と合いません）")
    gui_module, gui_module_error = load_ubuntu_gui()
    expected_columns = getattr(gui_module, "TOOLTIP_COLUMNS", 64) if gui_module else 64
    expected_break_after = getattr(gui_module, "BREAK_AFTER", "。、，．）」』】・ /\\") if gui_module else "。、，．）」』】・ /\\"
    expected_no_line_start = getattr(gui_module, "NO_LINE_START", "。、，．）」』】ー：:,.)") if gui_module else "。、，．）」』】ー：:,.)"
    if ps_columns != expected_columns or ps_break_after != expected_break_after or ps_no_line_start != expected_no_line_start:
        problems.append(f"折り返しの定数が Ubuntu 版と違います: 幅 {ps_columns}（{expected_columns}）、分けてよい文字 {ps_break_after!r}（{expected_break_after!r}）、行頭に置かない文字 {ps_no_line_start!r}（{expected_no_line_start!r}）")

    def ps_display_width(character: str) -> int:
        code_point = ord(character)
        return 2 if any(start <= code_point <= end for start, end in wide_ranges) else 1

    def east_asian_display_width(character: str) -> int:
        return 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1

    # 説明データと ps1 の文字列に出る全ての文字で、範囲による表示幅が Unicode の East Asian Width（W・F は 2）と一致すること。
    shown_characters = set(HELP_PATH.read_text(encoding="utf-8")) | {character for token in lexed.strings for character in token.content}
    width_mismatches = sorted(character for character in shown_characters if ps_display_width(character) != east_asian_display_width(character))
    if width_mismatches:
        problems.append("表示幅の範囲が East Asian Width と違う文字があります: " + "、".join(f"U+{ord(character):04X}" for character in width_mismatches[:10]))

    # ps1 の Get-WrapBreakIndex を写した版（1 要素 1 文字の並び。行末から window 文字の範囲で、分けてよい文字の直後か、英数字の並びの前で分ける）。
    def ps_wrap_break(line: list[str], window: int = 12) -> int:
        lower = max(1, len(line) - window)
        for position in range(len(line) - 1, lower - 1, -1):
            if line[position] in ps_break_after:
                return position + 1
        position = len(line)
        while position > lower:
            code = ord(line[position - 1][0])
            if code >= 0x80 or 0x09 <= code <= 0x0D or 0x1C <= code <= 0x20:
                break
            position -= 1
        if lower < position < len(line):
            return position
        return len(line)

    # ps1 の Format-WrappedText を写した版（既存の改行は残し、CR LF でつなぐ）。width_of で表示幅の数え方を差し替えられる。
    def ps_wrap(text: str, columns: int, width_of) -> str:
        output: list[str] = []
        for paragraph in re.split(r"\r?\n", text):
            line: list[str] = []
            line_width = 0
            for character in paragraph:
                step = width_of(character)
                if line_width + step > columns and line and character not in ps_no_line_start:
                    cut = ps_wrap_break(line)
                    output.append("".join(line[:cut]).rstrip(" "))
                    rest = line[cut:]
                    line = []
                    line_width = 0
                    for rest_character in rest:
                        if not line and rest_character == " ":
                            continue
                        line.append(rest_character)
                        line_width += width_of(rest_character)
                line.append(character)
                line_width += step
            output.append("".join(line))
        return "\r\n".join(output)

    tooltip_texts = [action_tooltip(action)[0] for action in help_data["actions"].values()] + [option_tooltip(option)[0] for option in help_data["options"].values()]
    tooltip_texts += [("あ" * 40), ("あ" * 32) + "。い", ("あ" * 28) + "abc defghij", ("あ" * 30) + "ShowExposure", ("a" * 63) + chr(0x1F600) + "b", "一行目\r\n\r\n三行目"]
    wrap_mismatches = 0
    for text in tooltip_texts:
        mine = ps_wrap(text, ps_columns, ps_display_width)
        if gui_module is not None and hasattr(gui_module, "wrap_display_text"):
            reference = gui_module.wrap_display_text(text.replace("\r\n", "\n"), expected_columns).replace("\n", "\r\n")
        else:
            reference = ps_wrap(text, expected_columns, east_asian_display_width)
        if mine != reference:
            wrap_mismatches += 1
            if wrap_mismatches <= 3:
                problems.append(f"ツールチップの折り返し（写した版）が Ubuntu 版と違います: {ascii(text[:40])}…")
    if ps_wrap(("あ" * 32) + "。い", ps_columns, ps_display_width) != ("あ" * 32) + "。\r\nい":
        problems.append("行頭に置かない文字（。）の前で分けています（写した版）")
    wrap_body = body_of("Format-WrappedText")
    for needle in (
        "foreach ($paragraph in @($Text -split \"`r?`n\")) {",
        "$unitCount = if ([char]::IsSurrogatePair($paragraph, $index)) { 2 } else { 1 }",
        "if (($lineWidth + $step) -gt $Columns -and $line.Count -gt 0 -and -not $script:WrapNoLineStart.Contains($character)) {",
        "$cut = Get-WrapBreakIndex -Line $line",
        "$output.Add((($line.GetRange(0, $cut)) -join '').TrimEnd(' '))",
        "if ($line.Count -eq 0 -and $restCharacter.Equals(' ')) { continue }",
        "return ($output -join \"`r`n\")",
    ):
        if needle not in wrap_body:
            problems.append(f"Format-WrappedText の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    break_body = body_of("Get-WrapBreakIndex")
    for needle in (
        "[int]$Window = 12",
        "$lower = [Math]::Max(1, $Line.Count - $Window)",
        "if ($script:WrapBreakAfter.Contains($Line[$position])) { return $position + 1 }",
        "if ($code -ge 0x80 -or ($code -ge 0x09 -and $code -le 0x0D) -or ($code -ge 0x1C -and $code -le 0x20)) { break }",
        "if ($lower -lt $position -and $position -lt $Line.Count) { return $position }",
    ):
        if needle not in break_body:
            problems.append(f"Get-WrapBreakIndex の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    width_body = body_of("Get-DisplayCharacterWidth")
    for needle in ("if ($codePoint -lt 0x1100) { return 1 }", "if ($codePoint -lt $ranges[$rangeIndex]) { return 1 }", "if ($codePoint -le $ranges[$rangeIndex + 1]) { return 2 }"):
        if needle not in width_body:
            problems.append(f"Get-DisplayCharacterWidth の本体に {needle} がありません")
    if "SetToolTip($control, (Get-WrappedToolTipText -Text (Limit-ToolTipText -Text $ToolTipText)))" not in control_body:
        problems.append("New-GuiControl が、ツールチップの本文を上限で切ってから折り返していません")
    if "ToolTipText = (Get-WrappedToolTipText -Text (Limit-ToolTipText -Text $tabTip))" not in body_of("New-BridgeForm"):
        problems.append("タブの見出しの説明を折り返していません")
    if "$script:ToolTipTextCache = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)" not in source:
        problems.append("折り返した本文を覚える辞書が、大文字小文字を区別する序数の照合ではありません")
    for function_name in ("Format-WrappedText", "Get-WrapBreakIndex", "Get-DisplayCharacterWidth", "ConvertTo-InputPath"):
        if re.search(r"System\.Windows\.Forms|System\.Drawing|\$script:Ui\b", body_of(function_name)):
            problems.append(f"{function_name} が WinForms や画面の状態に依存しています（純粋関数にする）")
    # 起動の失敗を、メッセージボックス（エラーのアイコン）で知らせること。
    startup_body = body_of("Show-StartupError")
    for needle in ("[System.Windows.Forms.MessageBoxIcon]::Error", "[Console]::Error.WriteLine($text)", "foreach ($piece in @(Split-LogText -Text $message)) { $lines.Add((ConvertTo-SafeLogLine -Text $piece)) }"):
        if needle not in startup_body:
            problems.append(f"Show-StartupError に {needle} がありません")
    reference_name = "project-bridge-gui.py の wrap_display_text" if gui_module is not None else f"試験内の写し（project-bridge-gui.py を読めません: {gui_module_error}）"
    report.check(f"22. Ubuntu 版とそろえた振る舞い（上書き系のチェックを実行の始めにオフ・パスの欄 {len(path_cases)} 件・ハブの起動前の確認・ツールチップの折り返し {len(tooltip_texts)} 件（参照: {reference_name}）・表示幅 {len(shown_characters)} 文字・起動の失敗の表示）", problems)

    # 関数の本体のうち、文字列とコメントを空白にしたもの（呼び出しの有無を、コメントの文に惑わされずに調べる）。
    def code_of(name: str) -> str:
        return code[ranges[name][0] : ranges[name][1]] if name in ranges else ""

    # 関数の本体にある文字列リテラルの中身（始まりの行が本体の中にあるもの）。
    def strings_of(name: str) -> list[str]:
        if name not in ranges:
            return []
        first_line = line_of(code, ranges[name][0])
        last_line = line_of(code, ranges[name][1])
        return [token.content for token in lexed.strings if first_line <= token.line <= last_line]

    cli_source = CLI_PATH.read_text(encoding="utf-8").removeprefix("\ufeff").replace("\r\n", "\n")
    cli_ranges = function_ranges(lex_powershell(cli_source).code)

    # CLI の関数の本体（ソースの文字列）を返す。無ければ空文字。
    def cli_body_of(name: str) -> str:
        return cli_source[cli_ranges[name][0] : cli_ranges[name][1]] if name in cli_ranges else ""

    # 23. ハブの稼働表示（どのタブでも見える帯。3 秒ごとの専用のタイマー。読み取りだけ）。
    problems = []
    for function_name in HUB_FUNCTIONS:
        if function_name not in ranges:
            problems.append(f"{function_name} がありません")
    # 画面の文（Ubuntu 版と同じ）。帯の 4 つの状態・詳細の文・2 つのラベルの説明・「確認の 5 段階」の説明。
    if f"$script:HubStatusToolTip = '{HUB_STATUS_TOOLTIP}'" not in source:
        problems.append("$script:HubStatusToolTip が、決めた説明の文と違います")
    if len(HUB_STATUS_TOOLTIP) > TOOLTIP_LIMIT:
        problems.append(f"帯の説明が上限を超えます: {len(HUB_STATUS_TOOLTIP)} 文字")
    if f"-ToolTipText '{HUB_STAGE_TOOLTIP}'" not in body_of("Add-EasyTabHeader"):
        problems.append("「確認の 5 段階」の説明に、帯の表示の意味（3 の Tunnel Client のプロセスの有無だけ）の文がありません")
    status_body = body_of("Get-HubStatusText")
    for needle in (
        "'Tunnel ID: ' + (ConvertTo-SafeLogLine -Text ([string]$Status.TunnelId)) + ' / プロファイル: ' + (ConvertTo-SafeLogLine -Text ([string]$Status.ProfileName)) + ' / 登録 ' + [string][int]$Status.ProjectCount + ' 件'",
        "StateText = \"ハブ: ● 実行中（PID $([int]$Status.ProcessId)）\"; DetailText = $summaryText; IsRunning = $true",
        "StateText = 'ハブ: ○ 停止中'; DetailText = $summaryText + '。「ハブを起動」で起動します。'; IsRunning = $false",
        "StateText = 'ハブ: 未設定'; DetailText = 'Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。'; IsRunning = $false",
        "StateText = 'ハブ: 確認できません'; DetailText = $reasonText; IsRunning = $false",
        "ForEach-Object { ConvertTo-SafeLogLine -Text $_.Trim() }",
        "[string]::Equals($state, 'Running', [System.StringComparison]::Ordinal)",
        "[string]::Equals($state, 'Stopped', [System.StringComparison]::Ordinal)",
        "[string]::Equals($state, 'Unset', [System.StringComparison]::Ordinal)",
    ):
        if needle not in status_body:
            problems.append(f"Get-HubStatusText の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    sample_tunnel = "tunnel_" + "0123456789abcdef" * 2
    status_cases = [
        ({"State": "Running", "ProcessId": 1234, "TunnelId": sample_tunnel, "ProfileName": "chatgpt-hub-1a2b3c4d", "ProjectCount": 3, "Reason": ""}, ("ハブ: ● 実行中（PID 1234）", "Tunnel ID: " + sample_tunnel + " / プロファイル: chatgpt-hub-1a2b3c4d / 登録 3 件", True)),
        ({"State": "Stopped", "ProcessId": 0, "TunnelId": sample_tunnel, "ProfileName": "chatgpt-hub-1a2b3c4d", "ProjectCount": 0, "Reason": ""}, ("ハブ: ○ 停止中", "Tunnel ID: " + sample_tunnel + " / プロファイル: chatgpt-hub-1a2b3c4d / 登録 0 件。「ハブを起動」で起動します。", False)),
        ({"State": "Unset", "ProcessId": 0, "TunnelId": "", "ProfileName": "", "ProjectCount": 0, "Reason": ""}, ("ハブ: 未設定", "Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。", False)),
        ({"State": "Unknown", "ProcessId": 0, "TunnelId": "", "ProfileName": "", "ProjectCount": 0, "Reason": "読めません" + chr(0x202E) + "x" + chr(0x0D) + chr(0x0A) + "  2 行目  " + chr(0x0A)}, ("ハブ: 確認できません", "読めません\\u202ex 2 行目", False)),
        ({"State": "Unknown", "ProcessId": 0, "TunnelId": "", "ProfileName": "", "ProjectCount": 0, "Reason": ""}, ("ハブ: 確認できません", "理由を取得できませんでした。", False)),
        ({"State": "Stopped", "ProcessId": 0, "TunnelId": "t" + chr(0x1B) + "x", "ProfileName": "p" + chr(0x2028), "ProjectCount": 12, "Reason": ""}, ("ハブ: ○ 停止中", "Tunnel ID: t\\x1bx / プロファイル: p\\u2028 / 登録 12 件。「ハブを起動」で起動します。", False)),
    ]
    for status, expected in status_cases:
        if ps_hub_status_text(status) != expected:
            problems.append(f"帯の文（写した版）が違います: {status['State']} → {ascii(ps_hub_status_text(status))}（期待 {ascii(expected)}）")
    band_body = body_of("New-HubStatusBand")
    if band_body.count("New-GuiControl -TypeName 'Label' -ToolTipText $script:HubStatusToolTip") != 2:
        problems.append("帯の 2 つのラベル（状態・詳細）に、決めた説明（$script:HubStatusToolTip）を付けていません")
    for needle in ("Dock = [System.Windows.Forms.DockStyle]::Top", "$script:Ui.HubStateLabel = $stateLabel", "$script:Ui.HubDetailLabel = $detailLabel", "return $band"):
        if needle not in band_body:
            problems.append(f"New-HubStatusBand に {needle} がありません")
    form_body = body_of("New-BridgeForm")
    band_positions = [form_body.find(needle) for needle in ("$hubBand = New-HubStatusBand", "$form.Controls.Add($tabControl)", "$form.Controls.Add($bottomPanel)", "$form.Controls.Add($hubBand)")]
    if min(band_positions) < 0 or band_positions[1:] != sorted(band_positions[1:]):
        problems.append("主画面に帯を、タブ（Fill）・下部（Bottom）の後に追加していません（どのタブでも見える上端に置くため、最後に追加する）")
    for match in re.finditer(r"\.Controls\.Add\(\$hubBand\)", code):
        if not lines[line_of(code, match.start()) - 1].strip().startswith("$form.Controls.Add("):
            problems.append(f"帯を主画面の直下以外（タブのページなど）に置いています: {line_of(code, match.start())} 行")
    # 専用のタイマー（3 秒ごと。New-GuiComponent で作り、表示時に始め、主画面を閉じるときに止める）。主タイマー（150ms）は変えない。
    gui_body = body_of("Start-BridgeGui")
    for needle in (
        "    $script:Ui.Timer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{ Interval = 150 })\n",
        f"    $script:Ui.HubTimer = New-GuiComponent -TypeName 'Timer' -Property ([ordered]@{{ Interval = {HUB_INTERVAL} }})\n",
        "    $script:Ui.HubTimer.Add_Tick({\n            try { Update-HubStatusBand } catch { Write-GuiError -ErrorRecord $_ }\n        })\n",
        "        $script:Ui.HubTimer.Stop()\n        $script:Ui.HubTimer.Dispose()\n",
        "        $script:Ui.Timer.Stop()\n        $script:Ui.Timer.Dispose()\n",
    ):
        if needle not in gui_body:
            problems.append(f"Start-BridgeGui に {needle.strip()} がありません")
    if gui_body.find("} finally {") < 0 or gui_body.find("$script:Ui.HubTimer.Stop()") < gui_body.find("} finally {"):
        problems.append("Start-BridgeGui が、画面を閉じたあと（finally）で専用のタイマーを止めていません")
    closed_handler = re.search(r"\$form\.Add_FormClosed\(\{\n\s*try \{\n\s*if \(\$null -ne \$script:Ui\.HubTimer\) \{ \$script:Ui\.HubTimer\.Stop\(\) \}\n\s*\} catch \{\n\s*Write-GuiError -ErrorRecord \$_\n\s*\}\n\s*\}\)", form_body)
    if closed_handler is None:
        problems.append("主画面を閉じたとき（FormClosed）に、専用のタイマーを止めていません")
    shown_handler = re.search(r"\$form\.Add_Shown\(\{\n(.*?)\n        \}\)", form_body, re.DOTALL)
    shown_text = shown_handler.group(1) if shown_handler else ""
    for needle in ("if ($null -ne $script:Ui.HubTimer) { $script:Ui.HubTimer.Start() }", "Update-HubListView", "Update-ButtonState", "} catch {", "Write-GuiError -ErrorRecord $_"):
        if needle not in shown_text:
            problems.append(f"主画面の表示時（Shown）の処理に {needle} がありません")
    timer_starts = [(line_of(code, match.start()), enclosing_function(ranges, match.start())) for match in re.finditer(r"HubTimer\.Start\(\)", code)]
    if [owner for _line, owner in timer_starts] != ["New-BridgeForm"]:
        problems.append(f"専用のタイマーを始める箇所が、主画面の表示時（New-BridgeForm の Shown）の 1 か所ではありません: {timer_starts}")
    if re.search(r"HubTimer\.Interval\s*=", code) or len(re.findall(r"\$script:Ui\.HubTimer\s*=", code)) != 1:
        problems.append("専用のタイマーを作る箇所が 1 つではない、または間隔を後から変えています")
    # 3 秒ごとに行うのは稼働表示だけ。自動入力と登録一覧の作り直しはしない（入力中の欄を書き換えないため）。
    band_update_code = code_of("Update-HubStatusBand")
    for forbidden in ("Set-KnownInputValue", "Set-AutoFilledText", "Update-HubListView", "Add-LogLine", "Show-GuiMessage"):
        if forbidden in band_update_code:
            problems.append(f"3 秒ごとに呼ぶ Update-HubStatusBand が {forbidden} を呼んでいます")
    for needle in (
        "if ($null -eq $stateLabel -or $null -eq $detailLabel) { return }",
        "if ($script:Ui.InHubUpdate) { return }",
        "$display = Get-HubStatusText -Status (Get-HubRunState)",
        "if (-not [string]::Equals([string]$stateLabel.Text, [string]$display.StateText, [System.StringComparison]::Ordinal)) { $stateLabel.Text = [string]$display.StateText }",
        "if (-not [string]::Equals([string]$detailLabel.Text, [string]$display.DetailText, [System.StringComparison]::Ordinal)) { $detailLabel.Text = [string]$display.DetailText }",
        "$stateLabel.ForeColor = if ($display.IsRunning) { [System.Drawing.Color]::DarkGreen } else { [System.Drawing.SystemColors]::ControlText }",
        "$script:Ui.InHubUpdate = $false",
    ):
        if needle not in body_of("Update-HubStatusBand"):
            problems.append(f"Update-HubStatusBand に {needle} がありません")
    # 登録一覧を読み直す 5 か所（表示時・操作の終了・補助の終了・別のコンソール窓が閉じたとき・「一覧を更新」）で、稼働表示と自動入力も行う。
    list_body = body_of("Update-HubListView")
    list_positions = [list_body.find(needle) for needle in ("Update-HubStatusBand", "Set-KnownInputValue", "$listView = $script:Ui.HubListView")]
    if min(list_positions) < 0 or list_positions != sorted(list_positions):
        problems.append("Update-HubListView が、登録一覧を作り直す前に稼働表示（Update-HubStatusBand）と自動入力（Set-KnownInputValue）を行っていません")
    list_callers = sorted(enclosing_function(ranges, match.start()) for match in re.finditer(r"(?<![\w-])Update-HubListView\b", code) if not lines[line_of(code, match.start()) - 1].lstrip().startswith("function "))
    if list_callers != ["Add-EasyTabHeader", "Clear-AuxiliaryJob", "Complete-Flow", "New-BridgeForm", "Update-ConsoleState"]:
        problems.append(f"Update-HubListView を呼ぶ箇所が想定の 5 か所ではありません: {list_callers}")
    band_callers = sorted(enclosing_function(ranges, match.start()) for match in re.finditer(r"(?<![\w-])Update-HubStatusBand\b", code) if not lines[line_of(code, match.start()) - 1].lstrip().startswith("function "))
    if band_callers != ["Start-BridgeGui", "Update-HubListView"]:
        problems.append(f"Update-HubStatusBand を呼ぶ箇所が、専用のタイマーと Update-HubListView の 2 か所ではありません: {band_callers}")
    # 画面の状態の表（$script:Ui）に、使うキーが先に作ってあること（StrictMode では、無いキーの参照が例外になる）。
    ui_block = re.search(r"\$script:Ui = @\{\n(.*?)\n\}", source, re.DOTALL)
    ui_keys = set(re.findall(r"(?m)^    (\w+) = ", ui_block.group(1))) if ui_block else set()
    for key in ("HubStateLabel", "HubDetailLabel", "HubTimer", "HubProbe", "InHubUpdate", "AutoFilled"):
        if key not in ui_keys:
            problems.append(f"$script:Ui の表に {key} がありません")
    used_keys = set(re.findall(r"\$script:Ui\.(\w+)", lexed.expandable))
    if used_keys - ui_keys:
        problems.append(f"$script:Ui の表に無いキーを使っています: {sorted(used_keys - ui_keys)}")
    # 稼働の判定は読み取りだけ。子プロセスを起動せず、通信もせず、全プロセスの列挙や WMI の問い合わせを毎回はしない。
    launch_pattern = re.compile(r"Start-CliJob|Start-Process|Start-Job|Start-ThreadJob|New-CliArgumentList|Stop-Process|\.Kill\(|Invoke-\w+|ProcessStartInfo|Runspace|New-CimSession|Set-CimInstance|Remove-CimInstance|-ComputerName|-CimSession|Get-WmiObject|System\.Net|Sockets|Test-Connection|Test-NetConnection|Resolve-DnsName|Register-\w+Event|\$script:CliPath|PwshPath", re.IGNORECASE)
    for function_name in HUB_FUNCTIONS:
        for match in launch_pattern.finditer(code_of(function_name)):
            problems.append(f"{function_name} に、プロセスの起動・停止や通信にあたる {match.group(0)} があります（読み取りだけにする）")
    # 本体の直前のコメントは対象にしない（説明の文に Get-Process などの語が出るため、文字列とコメントを空白にした本体で調べる）。
    for function_name in HUB_PURE_FUNCTIONS:
        if re.search(r"System\.Windows\.Forms|System\.Drawing|\$script:Ui\b|Get-Process|Get-CimInstance|Get-Content|Get-Item|Test-Path", code_of(function_name)):
            problems.append(f"{function_name} が画面・ファイル・プロセスに依存しています（純粋関数にする）")
    cim_calls = [(line_of(code, match.start()), enclosing_function(ranges, match.start())) for match in re.finditer(r"Get-CimInstance\b", code)]
    if [owner for _line, owner in cim_calls] != ["Get-ProcessCommandLine"]:
        problems.append(f"WMI の問い合わせ（Get-CimInstance）が Get-ProcessCommandLine の 1 か所ではありません: {cim_calls}")
    if "Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = $($ProcessId)\" -Property ProcessId, CommandLine -ErrorAction Stop" not in body_of("Get-ProcessCommandLine"):
        problems.append("Get-ProcessCommandLine が、PID を指定した 1 件だけの問い合わせになっていません（全プロセスを列挙しない）")
    command_line_callers = sorted(enclosing_function(ranges, match.start()) for match in re.finditer(r"(?<![\w-])Get-ProcessCommandLine\b", code) if not lines[line_of(code, match.start()) - 1].lstrip().startswith("function "))
    if command_line_callers != ["Test-HubProcessRunning"]:
        problems.append(f"Get-ProcessCommandLine を呼ぶ箇所が Test-HubProcessRunning の 1 か所ではありません: {command_line_callers}")
    running_body = body_of("Test-HubProcessRunning")
    running_order = [running_body.find(needle) for needle in (
        "if ($ProcessId -le 0) { return $false }",
        "$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue",
        "if (-not (Test-HubProcessMatch -ProcessName $processName -CommandLine '' -ProfileName $ProfileName)) { return $false }",
        "$probeKey = \"$($ProcessId)|$($startMark)|$($ProfileName)\"",
        "if ($null -ne $probe -and [string]::Equals([string]$probe.ProbeKey, $probeKey, [System.StringComparison]::Ordinal)) { return [bool]$probe.IsMatch }",
        "$commandLine = Get-ProcessCommandLine -ProcessId $ProcessId",
        "if ($null -eq $commandLine) { return $false }",
        "$script:Ui.HubProbe = @{ ProbeKey = $probeKey; IsMatch = $isMatch }",
    )]
    if min(running_order) < 0 or running_order != sorted(running_order):
        problems.append("Test-HubProcessRunning が「PID のプロセスの有無と名前 → 覚えた結果 → 変わったときだけコマンドラインの問い合わせ」の順になっていません（3 秒ごとに WMI へ問い合わせない）")
    for function_name in HUB_FUNCTIONS:
        for match in re.finditer(r"Get-Process\b(?!\s+-Id\s)", code_of(function_name)):
            problems.append(f"{function_name} が PID を指定せずに Get-Process を呼んでいます（全プロセスを列挙しない）")
    # hub.json は Read-HubProjectList と同じ安全策（リンクやジャンクションは読まない）で読み、PID ファイルは CLI と同じ場所を見る。
    summary_body = body_of("Read-HubSummary")
    for needle in (
        "if (-not (Test-Path -LiteralPath $HubPath -PathType Leaf)) { return $null }",
        "if (($hubItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw",
        "$hub = Get-Content -LiteralPath $HubPath -Raw -Encoding UTF8 | ConvertFrom-Json",
        "if ($hub -isnot [System.Management.Automation.PSCustomObject]) { throw",
        "TunnelId = if (Test-HubTunnelId -Value $tunnelId) { $tunnelId } else { '' }",
        "ProfileName = if (Test-HubProfileName -Value $profileName) { $profileName } else { '' }",
        "ProjectCount = @(Get-EntryList -Entry $hub -Name 'projects').Count",
    ):
        if needle not in summary_body:
            problems.append(f"Read-HubSummary に {needle} がありません")
    if "if (($hubItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw" not in body_of("Read-HubProjectList"):
        problems.append("Read-HubProjectList の安全策（リンクやジャンクションは読まない）がありません")
    if f"return ([string]$Value -cmatch '{HUB_TUNNEL_PATTERN}')" not in body_of("Test-HubTunnelId") or f"-cnotmatch '{HUB_TUNNEL_PATTERN}'" not in cli_source:
        problems.append("Tunnel ID の形式（Test-HubTunnelId）が、CLI の正規表現と違います")
    if f"return ([string]$Value -cmatch '{HUB_PROFILE_PATTERN}')" not in body_of("Test-HubProfileName") or f"-cnotmatch '{HUB_PROFILE_PATTERN}'" not in cli_body_of("Assert-ProfileName"):
        problems.append("プロファイル名の形式（Test-HubProfileName）が、CLI の Assert-ProfileName の正規表現と違います")
    pid_path_body = body_of("Get-HubPidFilePath")
    if "if (-not (Test-HubProfileName -Value $ProfileName)) { throw" not in pid_path_body or "return Join-Path (Join-Path $env:APPDATA 'tunnel-client\\runtime') ($ProfileName + '.pid')" not in pid_path_body:
        problems.append("Get-HubPidFilePath が、形式に合うプロファイル名だけで %APPDATA%\\tunnel-client\\runtime\\<名前>.pid を指していません")
    cli_start_body = cli_body_of("Start-ProfileTunnel")
    for needle in ("$runtimeDirectory = Join-Path $env:APPDATA 'tunnel-client\\runtime'", "$pidPath = Join-Path $runtimeDirectory \"$profileName.pid\"", "--pid.file $pidPath", "\"Name = 'tunnel-client.exe'\"", "$_.CommandLine -match \"--profile\\s+$([regex]::Escape($profileName))(?:\\s|$)\""):
        if needle not in cli_start_body:
            problems.append(f"CLI の Start-ProfileTunnel に {needle} がありません（PID ファイルの場所か、プロセスの照合が変わった可能性。GUI の稼働表示を合わせる）")
    pid_read_body = body_of("Read-HubProcessId")
    for needle in ("if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return 0 }", "if (($pidItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 0 }", "if ($pidItem.Length -gt 64) { return 0 }", "ConvertTo-HubProcessId -Text ([string](Get-Content -LiteralPath $PidPath -Raw -Encoding UTF8))"):
        if needle not in pid_read_body:
            problems.append(f"Read-HubProcessId に {needle} がありません")
    for needle in ("$trimmed = ([string]$Text).Trim()", "if ($trimmed -cnotmatch '^[0-9]{1,9}\\z') { return 0 }", "return [int]$trimmed"):
        if needle not in body_of("ConvertTo-HubProcessId"):
            problems.append(f"ConvertTo-HubProcessId の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    pid_cases = [
        ("1234", 1234), ("1234" + chr(0x0D) + chr(0x0A), 1234), (" 42 ", 42), ("", 0), (None, 0), ("abc", 0), ("12a", 0), ("-5", 0), ("1234567890", 0),
        ("999999999", 999999999), ("0", 0), (chr(0xFF11) + chr(0xFF12), 0), ("12" + chr(0x0A) + "34", 0), ("1.5", 0), ("0x10", 0), ("+7", 0),
    ]
    for value, expected in pid_cases:
        if ps_hub_process_id(value) != expected:
            problems.append(f"PID ファイルの中身の読み方（写した版）が違います: {ascii(value)} → {ps_hub_process_id(value)}（期待 {expected}）")
    match_body = body_of("Test-HubProcessMatch")
    for needle in (
        "if (-not [string]::Equals([string]$ProcessName, 'tunnel-client', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }",
        "if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $true }",
        "$pattern = '--profile\\s+' + [regex]::Escape($ProfileName) + '(?:\\s|\\z)'",
        "return [regex]::IsMatch($CommandLine, $pattern, ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant))",
    ):
        if needle not in match_body:
            problems.append(f"Test-HubProcessMatch の本体に {needle} がありません（Pythonへ写した規則と違う可能性）")
    tab = chr(0x09)
    line_feed = chr(0x0A)
    match_cases = [
        (("tunnel-client", "C:\\x\\tunnel-client.exe run --profile hubp --pid.file C:\\a.pid", "hubp"), True),
        (("tunnel-client", "tunnel-client.exe run --profile hubp", "hubp"), True),
        (("tunnel-client", "tunnel-client.exe run --profile hubp2 --x", "hubp"), False),
        (("tunnel-client", "tunnel-client.exe run --profile  hubp" + line_feed, "hubp"), True),
        (("tunnel-client", "tunnel-client.exe run --profile" + tab + "hubp" + tab + "--x", "hubp"), True),
        (("tunnel-client", "tunnel-client.exe run --profile other", "hubp"), False),
        (("TUNNEL-CLIENT", "TUNNEL-CLIENT.EXE RUN --PROFILE hubp ", "hubp"), True),
        (("pwsh", "pwsh.exe --profile hubp ", "hubp"), False),
        (("tunnel-client-helper", "x --profile hubp ", "hubp"), False),
        (("tunnel-client.exe", "x --profile hubp ", "hubp"), False),
        (("tunnel-client", "", "hubp"), True),
        (("tunnel-client", None, "hubp"), True),
        (("tunnel-client", "   ", "hubp"), True),
        (("", "", "hubp"), False),
        (("tunnel-client", "x --profile aXb ", "a.b"), False),
        (("tunnel-client", "x --profile a.b ", "a.b"), True),
        (("tunnel-client", "x --profile=hubp ", "hubp"), False),
        (("tunnel-client", "x --profile \"hubp\" ", "hubp"), False),
        (("tunnel-client", "x --profile hubp-2 ", "hubp"), False),
    ]
    for (process_name, command_line, profile_name), expected in match_cases:
        if ps_hub_process_match(process_name, command_line, profile_name) != expected:
            problems.append(f"プロセスの照合（写した版）が違います: {ascii((process_name, command_line, profile_name))} → {ps_hub_process_match(process_name, command_line, profile_name)}（期待 {expected}）")
    # 末尾を \z と書いた照合が、CLI の (?:\s|$) と同じ結果になること（乱数のコマンドライン。名前が tunnel-client でコマンドラインがあるとき）。
    generator = random.Random(20261009)
    pieces = ["--profile", "hubp", "hubp2", "a.b", "aXb", " ", "  ", tab, line_feed, "run", "--pid.file", "x", "-", "=", "\"", "HUBP", "--PROFILE"]
    equivalence_checked = 0
    for _ in range(3000):
        command_line = "".join(generator.choice(pieces) for _ in range(generator.randint(1, 8)))
        profile_name = generator.choice(["hubp", "a.b"])
        if not command_line.strip():
            continue
        equivalence_checked += 1
        if ps_hub_process_match("tunnel-client", command_line, profile_name) != cli_profile_match(command_line, profile_name):
            problems.append(f"乱数のコマンドラインで、CLI の照合と結果が違います: {ascii(command_line)}（プロファイル {profile_name}）")
            break
    report.check(f"23. ハブの稼働表示（どのタブでも見える帯・状態の文 {len(status_cases)} 件・{HUB_INTERVAL}ms の専用のタイマーを閉じるときに止める・読み取りだけで WMI は PID が変わったときだけ・PID {len(pid_cases)} 件・プロセスの照合 {len(match_cases)} 件・CLI との一致 乱数 {equivalence_checked} 件）", problems)

    # 24. 分かっている値の自動入力（対象は 2 つだけ・入力済みの値は書き換えない）と、HubAdd の Tunnel ID を従来方式の欄と共有しないこと。
    problems = []
    unshared = read_script_table(source, "UnsharedInputOptions")
    if unshared != {"HubAdd": ["tunnel-id"]}:
        problems.append(f"$script:UnsharedInputOptions が「HubAdd の tunnel-id」だけではありません: {unshared}")
    shared_body = body_of("Test-SharedInputOption")
    for needle in ("if (-not $script:UnsharedInputOptions.ContainsKey($ActionName)) { return $true }", "return (@($script:UnsharedInputOptions[$ActionName]) -cnotcontains $OptionName)"):
        if needle not in shared_body:
            problems.append(f"Test-SharedInputOption に {needle} がありません")
    register_calls = [lines[line_of(code, match.start()) - 1].strip() for match in re.finditer(r"(?<![\w-])Register-SharedInput\b", code) if not lines[line_of(code, match.start()) - 1].lstrip().startswith("function ")]
    if register_calls != ["if (Test-SharedInputOption -ActionName $actionName -OptionName $optionName) { Register-SharedInput -OptionName $optionName -Control $inputControl }"]:
        problems.append(f"入力欄を共有の一覧へ登録する箇所が、Test-SharedInputOption で確かめる 1 か所ではありません: {register_calls}")
    if len(re.findall(r"SharedInputs\[[^\]]+\]\.Add\(", code)) != 1 or "$script:Ui.SharedInputs[$OptionName].Add($Control)" not in body_of("Register-SharedInput"):
        problems.append("共有の一覧へ欄を足す箇所が Register-SharedInput の 1 か所ではありません")
    sync_body = body_of("Sync-SharedInput")
    sync_order = [sync_body.find(needle) for needle in ("if (-not $script:Ui.SharedInputs.ContainsKey($optionName)) { return }", "if (-not $script:Ui.SharedInputs[$optionName].Contains($Source)) { return }", "$script:Ui.SyncingInput = $true", "foreach ($other in $script:Ui.SharedInputs[$optionName]) {")]
    if min(sync_order) < 0 or sync_order != sorted(sync_order):
        problems.append("Sync-SharedInput が、共有の一覧に無い欄（HubAdd の Tunnel ID）の値を写さない確認を、写す前に行っていません")
    # 説明データから、Windows の画面に Tunnel ID 欄・Tunnel Client の場所の欄が出るカードを求め、共有の組を確かめる。
    tunnel_cards = sorted(pascal_name(kebab) for kebab, names in visible.items() if "tunnel-id" in names)
    shared_tunnel_cards = sorted(name for name in tunnel_cards if "tunnel-id" not in unshared.get(name, []))
    if tunnel_cards != ["AddProject", "ConfigureTunnel", "HubAdd"] or shared_tunnel_cards != ["AddProject", "ConfigureTunnel"]:
        problems.append(f"Tunnel ID 欄を互いに共有するカードが ConfigureTunnel と AddProject の 2 つではありません: 欄のあるカード {tunnel_cards}、共有 {shared_tunnel_cards}")
    client_cards = sorted(pascal_name(kebab) for kebab, names in visible.items() if "tunnel-client-path" in names)
    if len(client_cards) != 8 or any("tunnel-client-path" in unshared.get(name, []) for name in client_cards):
        problems.append(f"Tunnel Client の場所の欄を共有するカードが 8 枚ではありません: {client_cards}")
    for action_name, option_names in unshared.items():
        if action_name not in cli_actions or any(option not in help_data["options"] for option in option_names):
            problems.append(f"$script:UnsharedInputOptions に、CLI や説明データに無い名前があります: {action_name} {option_names}")
    # 自動入力の対象は、HubAdd の Tunnel ID と Tunnel Client の場所の 2 つだけ（フォルダー・プロジェクト名・ハブ内の名前・プロファイル名は入れない）。
    known_body = body_of("Set-KnownInputValue")
    option_literals = sorted({content for content in strings_of("Set-KnownInputValue") if content in help_data["options"]})
    if option_literals != ["tunnel-client-path", "tunnel-id"]:
        problems.append(f"Set-KnownInputValue が扱う欄が tunnel-id と tunnel-client-path の 2 つではありません: {option_literals}")
    for needle in (
        "if ([string]::Equals([string]$card.ActionName, 'HubAdd', [System.StringComparison]::Ordinal) -and $card.Inputs.ContainsKey('tunnel-id')) { $tunnelBox = $card.Inputs['tunnel-id'] }",
        "$summary = Read-HubSummary -HubPath (Get-HubConfigPath)",
        "if ($null -ne $summary) { $hubTunnelId = [string]$summary.TunnelId }",
        "Set-AutoFilledText -SlotName 'HubAdd:tunnel-id' -TextBox $tunnelBox -Candidate $hubTunnelId",
        "$clientPath = [string](Find-TunnelClientPath)",
        "Set-AutoFilledText -SlotName 'tunnel-client-path' -TextBox $script:Ui.SharedInputs['tunnel-client-path'][0] -Candidate $clientPath",
    ):
        if needle not in known_body:
            problems.append(f"Set-KnownInputValue に {needle} がありません")
    if len(re.findall(r"(?<![\w-])Set-AutoFilledText\b", code_of("Set-KnownInputValue"))) != 2:
        problems.append("Set-KnownInputValue が値を入れる欄が 2 つではありません")
    for function_name, expected_callers in (("Set-KnownInputValue", ["Update-HubListView"]), ("Set-AutoFilledText", ["Set-KnownInputValue", "Set-KnownInputValue"]), ("Test-AutoFillAllowed", ["Set-AutoFilledText"]), ("Find-TunnelClientPath", ["Set-KnownInputValue"]), ("Read-HubSummary", ["Get-HubRunState", "Set-KnownInputValue"])):
        callers = sorted(enclosing_function(ranges, match.start()) for match in re.finditer(r"(?<![\w-])" + re.escape(function_name) + r"\b", code) if not lines[line_of(code, match.start()) - 1].lstrip().startswith("function "))
        if callers != expected_callers:
            problems.append(f"{function_name} を呼ぶ箇所が想定と違います: {callers}（期待 {expected_callers}）")
    fill_body = body_of("Set-AutoFilledText")
    fill_order = [fill_body.find(needle) for needle in (
        "$lastFilled = if ($script:Ui.AutoFilled.ContainsKey($SlotName)) { [string]$script:Ui.AutoFilled[$SlotName] } else { '' }",
        "if (-not (Test-AutoFillAllowed -Current ([string]$TextBox.Text) -Candidate $Candidate -LastFilled $lastFilled)) { return }",
        "$TextBox.Text = $Candidate",
        "$script:Ui.AutoFilled[$SlotName] = $Candidate",
    )]
    if min(fill_order) < 0 or fill_order != sorted(fill_order):
        problems.append("Set-AutoFilledText が、Test-AutoFillAllowed で確かめてから値を入れ、入れた値を覚える順になっていません")
    allowed_body = body_of("Test-AutoFillAllowed")
    allowed_order = [allowed_body.find(needle) for needle in (
        "if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }",
        "if (Test-ForbiddenCharacter -Text $Candidate) { return $false }",
        "if (Test-DashLeadingValue -Value $Candidate) { return $false }",
        "if ([string]::Equals([string]$Current, [string]$Candidate, [System.StringComparison]::Ordinal)) { return $false }",
        "if ([string]::IsNullOrWhiteSpace($Current)) { return $true }",
        "if ([string]::IsNullOrEmpty($LastFilled)) { return $false }",
        "return [string]::Equals([string]$Current, [string]$LastFilled, [System.StringComparison]::Ordinal)",
    )]
    if min(allowed_order) < 0 or allowed_order != sorted(allowed_order):
        problems.append("Test-AutoFillAllowed の本体が、Pythonへ写した規則（入れたい値の検査 → 同じ値 → 空 → 前回入れた値のまま）と違います")
    old_path = "C:\\old\\tunnel-client.exe"
    new_path = "C:\\Tools\\tunnel-client.exe"
    fill_cases = [
        (("", "A", ""), True), (("  ", "A", ""), True), (("B", "A", ""), False), (("A", "A", ""), False), (("A", "C", "A"), True), (("B", "C", "A"), False),
        (("", "", ""), False), (("", "   ", ""), False), (("", "-x", ""), False), (("", " -x", ""), False), (("", chr(0x2013) + "x", ""), False),
        (("", "a" + chr(0x202E) + "b", ""), False), (("", "a" + chr(0x0A) + "b", ""), False), (("", "a" + chr(0x200B), ""), False), (("a", "C", "A"), False), (("A", "A", "A"), False),
        (("", new_path, old_path), True), ((old_path, new_path, old_path), True), (("C:\\mine\\tc.exe", new_path, old_path), False), ((old_path, new_path, ""), False),
        (("", "a" + chr(0x3000) + "b", ""), True),
    ]
    for (current, candidate, last_filled), expected in fill_cases:
        if ps_auto_fill_allowed(current, candidate, last_filled) != expected:
            problems.append(f"自動入力の可否（写した版）が違います: {ascii((current, candidate, last_filled))} → {ps_auto_fill_allowed(current, candidate, last_filled)}（期待 {expected}）")
    # Tunnel Client の場所を探す順番が、CLI の Find-TunnelClient と同じ（PATH → 既知の 3 か所）であること。
    candidate_pattern = re.compile(r"Join-Path \$env:(\w+) '([^']*tunnel-client\.exe)'")
    cli_candidates = candidate_pattern.findall(cli_body_of("Find-TunnelClient"))
    find_body = body_of("Find-TunnelClientPath")
    gui_candidates = candidate_pattern.findall(find_body)
    if len(cli_candidates) != 3 or gui_candidates != cli_candidates:
        problems.append(f"Tunnel Client の場所の候補が、CLI の Find-TunnelClient と同じ並びではありません: GUI {gui_candidates} / CLI {cli_candidates}")
    command_position = find_body.find("Get-Command -Name 'tunnel-client' -CommandType Application -ErrorAction SilentlyContinue")
    if command_position < 0 or (gui_candidates and command_position > find_body.find("Join-Path $env:" + gui_candidates[0][0])):
        problems.append("Find-TunnelClientPath が、既知の候補より先に PATH（Get-Command tunnel-client）を調べていません")
    if "Get-Command tunnel-client -ErrorAction SilentlyContinue" not in cli_body_of("Find-TunnelClient"):
        problems.append("CLI の Find-TunnelClient が PATH（Get-Command tunnel-client）を先に調べる形ではなくなっています（GUI の自動入力を合わせる）")
    for needle in ("if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).ProviderPath }", "return ''"):
        if needle not in find_body:
            problems.append(f"Find-TunnelClientPath に {needle} がありません")
    report.check(f"24. 分かっている値の自動入力（対象は HubAdd の Tunnel ID と Tunnel Client の場所だけ・可否 {len(fill_cases)} 件・探す順番は CLI と同じ {len(gui_candidates)} か所）と、HubAdd の Tunnel ID を従来方式の欄（{'・'.join(shared_tunnel_cards)}）と共有しないこと", problems)

    # 25. 権限（ソースの読み取り・Claude Code の起動）の確認・切り替え（2.8.0。かんたんタブの一覧の列とボタン）。
    problems = []
    permission_functions = (
        "Get-StandardHubApprovalPath", "Test-HubApprovalFileStandard", "Get-HubPermissionSourceReadText", "Get-HubPermissionClaudeCodeText",
        "Get-HubPermissionApprovalText", "Get-HubPermissionKindLabel", "Get-HubPermissionToggleDirection", "ConvertFrom-HubPermissionReport",
        "Update-HubPermissionColumn", "Clear-HubPermissionJob", "Start-HubPermissionCheckJob", "Complete-HubPermissionCheckJob",
        "Invoke-HubPermissionToggle", "Resume-HubPermissionToggle", "Start-HubPermissionConfirmJob", "Complete-HubPermissionConfirmJob",
        "Start-HubPermissionApplyJob", "Complete-HubPermissionApplyJob",
    )  # 2.8.0 で足した関数。
    for function_name in permission_functions:
        body = body_of(function_name)
        if not body:
            problems.append(f"{function_name} がありません")
            continue
        for label, pattern in WRITE_COMMANDS:
            if pattern.search(body):
                problems.append(f"{function_name} に書き込み命令 {label} があります（設定・承認・hub.json を書くのは CLI だけ）")
        if re.search(r"\$script:Ui\.Flow\s*=", body):
            problems.append(f"{function_name} が $script:Ui.Flow を書き換えています（カードの操作とは別に、PermissionJob・PermissionToggle で状態を持つ）")
    # 標準の承認ファイルの場所（Get-StandardHubApprovalPath）は、CLI の Get-ApprovalPath と同じ組み立てにする。
    standard_path_line = 'return Join-Path $env:APPDATA "chatgpt-project-bridge\\approvals\\$ProfileName.json"'
    if standard_path_line not in body_of("Get-StandardHubApprovalPath"):
        problems.append("Get-StandardHubApprovalPath が、CLI の Get-ApprovalPath と同じ場所を組み立てていません")
    if standard_path_line not in cli_body_of("Get-ApprovalPath"):
        problems.append("CLI の Get-ApprovalPath が、写した場所と違う場所へ承認を書くようになっています（Get-StandardHubApprovalPath を直す必要があります）")
    if "[System.StringComparison]::OrdinalIgnoreCase" not in body_of("Test-HubApprovalFileStandard"):
        problems.append("Test-HubApprovalFileStandard が大文字小文字を無視して比べていません（Windows のパスのため）")
    # 切り替え後の方向（ソース: on→off、ほかはon。Claude Code: on→off、ほかはon）。
    direction_body = body_of("Get-HubPermissionToggleDirection")
    for needle in (
        "if ((Get-EntryText -Entry $Permission -Name 'sourceRead') -ceq 'on') { return 'off' }",
        "if ((Get-EntryText -Entry $Permission -Name 'claudeCode') -ceq 'on') { return 'off' }",
    ):
        if needle not in direction_body:
            problems.append(f"Get-HubPermissionToggleDirection に {needle} がありません")
    # 一覧の列（権限を確認するまで「（未確認）」）の言い回し。
    for function_name, cases in (
        ("Get-HubPermissionSourceReadText", ("'on' { return 'On' }", "'off' { return 'Off' }", "'partial' { return '一部のみ（使えません）' }", "default { return '（未確認）' }")),
        ("Get-HubPermissionClaudeCodeText", ("'off' { return 'Off' }", "'unset' { return '設定なし' }", "default { return '（未確認）' }")),
        ("Get-HubPermissionApprovalText", ("if ($State -eq '') { return '（未確認）' }", "if ($State -ceq 'unavailable') {", "return Get-ApprovalStateText -State $State")),
    ):
        body = body_of(function_name)
        for needle in cases:
            if needle not in body:
                problems.append(f"{function_name} に {needle} がありません")
    # 権限確認（HubPermissions）の出力の検証（ConvertFrom-ExposureReport と同じ考え方）。
    report_body = body_of("ConvertFrom-HubPermissionReport")
    for needle in (".TrimStart([char]0xFEFF).Trim()", "if ($null -eq $report.PSObject.Properties['projects']) { throw", "foreach ($name in @('name', 'root', 'approvalState')) {"):
        if needle not in report_body:
            problems.append(f"ConvertFrom-HubPermissionReport に {needle} がありません")
    # ハブの一覧のボタン 3 つ（ツールチップ付き・押すと権限の確認・切り替えを呼ぶ）。
    easy_body = body_of("Add-EasyTabHeader")
    if "承認状態はここには出しません" in easy_body:
        problems.append("登録一覧の説明が、承認の列を追加したあとも「承認状態はここには出しません」のままです")
    for header in ("'ソースの読み取り', 120", "'Claude Code', 150", "'承認', 190"):
        if f"Columns.Add({header})" not in easy_body:
            problems.append(f"登録一覧に列 {header} がありません")
    for variable, text, click_needle, ui_key in (
        ("$permissionCheckButton", "権限を確認", "Start-HubPermissionCheckJob", "PermissionCheckButton"),
        ("$permissionSourceButton", "ソースの読み取りを切り替え", "Invoke-HubPermissionToggle -Kind 'SourceRead'", "PermissionSourceButton"),
        ("$permissionClaudeButton", "Claude Code の起動を切り替え", "Invoke-HubPermissionToggle -Kind 'ClaudeCode'", "PermissionClaudeButton"),
    ):
        definition = re.search(re.escape(variable) + r" = New-GuiControl .*?\}\)", easy_body, re.DOTALL)
        if definition is None or "-ToolTipText" not in definition.group(0) or f"Text = '{text}'" not in definition.group(0):
            problems.append(f"{variable} がツールチップ付きで作られていません")
        if click_needle not in easy_body:
            problems.append(f"{variable} の Click が {click_needle} を呼んでいません")
        if f"$script:Ui.{ui_key} = {variable}" not in easy_body:
            problems.append(f"{variable} が $script:Ui.{ui_key} に登録されていません")
    # 登録一覧（Update-HubListView）が、権限・承認の列を「（未確認）」で作り、行の状態（Tag）を持つこと。
    list_body = body_of("Update-HubListView")
    for needle in (
        "[void]$projectItem.SubItems.Add('（未確認）') # ソースの読み取り（「権限を確認」を押すまでの初期値）。",
        "[void]$projectItem.SubItems.Add('（未確認）') # Claude Code の起動（「権限を確認」を押すまでの初期値）。",
        "[void]$projectItem.SubItems.Add('（未確認）') # 承認（「権限を確認」を押すまでの初期値）。",
        "Permission = $null # HubPermissions が返した、このプロジェクトの権限（未確認なら $null）。",
    ):
        if needle not in list_body:
            problems.append(f"Update-HubListView に {needle} がありません")
    # 権限の子プロセス（PermissionCheck・PermissionConfirm・PermissionApply）は、HubStop・Auxiliary と同じく Flow の外で終わる。
    complete_body = body_of("Complete-CliJob")
    dispatch_positions = [complete_body.find(needle) for needle in (
        "if ($Job.Kind -eq 'HubStop') {",
        "if ($Job.Kind -eq 'Auxiliary') {",
        "if ($Job.Kind -eq 'PermissionCheck') {",
        "if ($Job.Kind -eq 'PermissionConfirm') {",
        "if ($Job.Kind -eq 'PermissionApply') {",
        "$flow = $script:Ui.Flow # 実行中の操作。",
    )]
    if min(dispatch_positions) < 0 or dispatch_positions != sorted(dispatch_positions):
        problems.append("Complete-CliJob が、権限の確認・切り替えを $script:Ui.Flow の判定より先に特別扱いしていません")
    if "Clear-HubPermissionJob -Job $job" not in body_of("Update-CliJobState"):
        problems.append("Update-CliJobState の後始末が、権限の子プロセスを Clear-HubPermissionJob で戻していません")
    # 権限ボタンの可否（Update-ButtonState）。
    button_state_body = body_of("Update-ButtonState")
    for needle in (
        "$script:Ui.PermissionCheckButton.Enabled = ($null -eq $script:Ui.PermissionJob)",
        "$script:Ui.PermissionSourceButton.Enabled = $permissionToggleEnabled",
        "$script:Ui.PermissionClaudeButton.Enabled = $permissionToggleEnabled",
    ):
        if needle not in button_state_body:
            problems.append(f"Update-ButtonState に {needle} がありません")
    # 切り替えの適用で指紋を加えるのは Add-ApprovedExposureArgument だけ（文字列 '-ExposureSha256' を自分で書かない）。
    if "Add-ApprovedExposureArgument -ArgumentList $arguments -Approval $Approval" not in body_of("Start-HubPermissionApplyJob"):
        problems.append("Start-HubPermissionApplyJob が Add-ApprovedExposureArgument で指紋を加えていません")
    # 承認ダイアログの注記（ExtraNote）は、呼び出し元が渡したときだけ出す（既存の $IsHub の警告と同じ仕組み）。
    approval_dialog_25 = body_of("Show-ApprovalDialog")
    for needle in (
        "[AllowEmptyString()][string]$ExtraNote = ''",
        "if (-not [string]::IsNullOrWhiteSpace($ExtraNote)) {",
        "Text = $ExtraNote",
    ):
        if needle not in approval_dialog_25:
            problems.append(f"Show-ApprovalDialog に {needle} がありません")
    if "-ExtraNote 'この承認で、プロジェクトの設定ファイル（.chatgpt-project-bridge.json）も書き換わります。キャンセルすると何も変わりません。'" not in body_of("Complete-HubPermissionConfirmJob"):
        problems.append("Complete-HubPermissionConfirmJob が、設定ファイルも書き換わる注記を承認ダイアログに渡していません")
    report.check(f"25. 権限（ソースの読み取り・Claude Code の起動）の確認・切り替え（かんたんタブの一覧の列・ボタン 3 つ・関数 {len(permission_functions)} 個）", problems)

    if report.failures:
        print(f"PROJECT_BRIDGE_GUI_WINDOWS_STATIC FAIL（{report.failures} 項目）")
        return 1
    print("PROJECT_BRIDGE_GUI_WINDOWS_STATIC PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
