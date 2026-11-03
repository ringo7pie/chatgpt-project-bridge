#!/usr/bin/env python3
"""Ubuntu 向け ChatGPT Project Bridge 管理画面（GTK 3）。

既存の CLI（project-bridge.py）を argv 配列の子プロセスで呼ぶだけの画面。パス検査・指紋照合・
キー検査・上書き確認は CLI に任せ、この画面では再実装しない。Runtime API Key は別の端末窓で
CLI が直接受け取り、この画面のプロセスは値を読まない・持たない・ログに出さない。

  python3 project-bridge-gui.py
      管理画面を開く。
  python3 -u project-bridge-gui.py --terminal-helper -- <action> [CLI のオプション…]
      画面が端末窓の中で使う内部用のヘルパー。CLI を実行し、終了コードを表示して Enter を待つ。
      受け付けるのはキーを入力する Action と、その Action のオプションだけ。画面の部品（PyGObject）は読み込まない。

画面の構成と説明文は assets/gui-help.ja.json（Windows 版と共有）から作る。純粋な処理（説明データの
読み込み・引数配列の組み立て・承認 JSON の解釈・承認ダイアログの内容（要約・詳細・禁止文字・上書きの警告）・
表示用の引用・ツールチップ文・端末コマンド・hub.json の読み取り・ハブの稼働の判定・Tunnel Client の探索）は
GTK に依存しない関数にしてあり、このファイルを import しただけでは PyGObject を読み込まない。
"""

from __future__ import annotations

import errno
import importlib.util
import json
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import termios
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping


SCRIPT_DIRECTORY = Path(__file__).resolve().parent  # このファイルと CLI の置き場所。
GUI_PATH = Path(__file__).resolve()  # 端末窓のヘルパーとして自分自身を呼ぶときのパス。
CLI_PATH = SCRIPT_DIRECTORY / "project-bridge.py"  # 子プロセスで呼ぶ CLI。
HELP_PATH = SCRIPT_DIRECTORY.parent / "assets" / "gui-help.ja.json"  # 画面の構成と説明文の共有データ。
CONFIG_NAME = ".chatgpt-project-bridge.json"  # プロジェクトの足場（設定ファイル）の名前。
HUB_DIRECTORY_NAME = "chatgpt-project-bridge"  # XDG_CONFIG_HOME の下のハブ設定の置き場所。
HUB_FILE_NAME = "hub.json"  # ハブ設定のファイル名（この画面は読み取るだけ）。
STATE_DIRECTORY_NAME = "tunnel-client"  # XDG_STATE_HOME の下の、Tunnel Client が PID ファイルを書く場所（この画面は読み取るだけ）。
PROCESS_DIRECTORY = "/proc"  # プロセスごとの情報（cmdline）の置き場所（試験では一時フォルダーに差し替える）。
TUNNEL_CLIENT_NAME = "tunnel-client"  # Tunnel Client の実行ファイルの名前。
TUNNEL_CLIENT_CANDIDATES = ("~/.local/bin/tunnel-client", "~/bin/tunnel-client")  # PATH に無いときに探す場所（CLI の find_tunnel_client と同じ順）。
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")  # 公開範囲の指紋（小文字 16 進 64 桁）。
PROFILE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")  # CLI と同じプロファイル名の形式。
TUNNEL_PATTERN = re.compile(r"^tunnel_[0-9a-f]{32}$")  # CLI と同じ Tunnel ID の形式（tunnel_ に小文字 16 進 32 桁）。
PID_TEXT_PATTERN = re.compile(r"[0-9]{1,7}")  # PID ファイルの中身として受け付ける形（半角の数字だけ）。
PID_LIMIT = 4194304  # Linux の PID の上限（2 の 22 乗）。これより大きい数は PID とみなさない。
PID_FILE_LIMIT_BYTES = 64  # PID ファイルとして読む大きさの上限。
COMMAND_LINE_LIMIT_BYTES = 64 * 1024  # /proc/<PID>/cmdline として読む大きさの上限。
HUB_POLL_SECONDS = 3  # ハブの稼働表示を調べ直す間隔（秒）。
APPROVAL_STATES = ("approved", "unapproved", "changed")  # show-exposure が返す承認状態。
GROUP_ORDER = ("easy", "hub", "legacy", "maintainer")  # タブの並び。
HIDDEN_OPTIONS = frozenset({"exposure-sha256"})  # 入力欄として出さないオプション（承認ダイアログだけが渡す）。
NEVER_FROM_INPUT = frozenset({"exposure-sha256", "verified"})  # 入力値やチェックからは引数にしないオプション。
FORCED_FLAGS = {
    "add-project": ("no-start",),
    "hub-add": ("no-start",),
    "hub-start": ("service",),
    "hub-restart": ("service",),
}  # この画面からは常に付けるフラグ。起動は起動用のボタンで別に行い、承認は起動の前に画面で済ませる。
PLATFORM = "ubuntu"  # 説明データの platformOnly で、この画面が対象とする OS の値。
AUXILIARY_ACTIONS = frozenset({"status", "hub-status", "hub-list", "hub-permissions"})  # 起動中（終わらない子が動いている間）も実行できる、読み取り専用の短い操作。
HUB_APPROVAL_ACTIONS = frozenset({"hub-add", "hub-start", "hub-restart"})  # 承認ダイアログにハブの影響範囲の警告を出す操作。
STOPPABLE_ACTIONS = frozenset({"start", "hub-start", "hub-restart"})  # 終わらない子プロセスを画面が持ち、停止ボタンを出す操作。
HUB_STOP_ACTIONS = frozenset({"hub-start", "hub-restart"})  # 停止に hub-stop を使う操作。
HUB_TUNNEL_BUFFER = "hub-add:tunnel-id"  # 「プロジェクトを追加」（hub-add）の Tunnel ID 欄だけが使う、入力欄の中身の鍵。
TUNNEL_CLIENT_OPTION = "tunnel-client-path"  # Tunnel Client の場所のオプション名（全カードで共有する入力欄の中身の鍵でもある）。
SEPARATE_BUFFERS = {("hub-add", "tunnel-id"): HUB_TUNNEL_BUFFER}  # 全カードでの共有から外す入力欄（Action, オプション）と、その中身の鍵。ハブの Tunnel ID を、従来方式（プロジェクトごとに別の Tunnel）の必須欄へ入れないため。
TERMINAL_CANDIDATES = (
    ("x-terminal-emulator", ("-e",)),
    ("gnome-terminal", ("--wait", "--")),
    ("ptyxis", ("--new-window", "--")),
    ("konsole", ("-e",)),
    ("xfce4-terminal", ("-x",)),
    ("xterm", ("-e",)),
)  # 端末を探す順と、「後ろに続く引数配列をそのままコマンドとして実行する」ための引数。
KNOWN_TERMINAL_TARGETS = frozenset({
    "gnome-terminal.wrapper", "gnome-terminal", "konsole", "xfce4-terminal", "xfce4-terminal.wrapper", "xterm", "ptyxis",
})  # x-terminal-emulator の実体（realpath の名前）として使ってよい既知の端末。これ以外なら、コピー用の案内に回す。
HELPER_EXTRA_OPTIONS = ("exposure-sha256", "no-start")  # 端末窓のヘルパーが、Action の options のほかに受け付けるオプション。
TOOLTIP_COLUMNS = 64  # ツールチップ本文を改行する表示幅（半角 1・全角 2 で数える）。
LOG_LINE_LIMIT = 10000  # 出力ログ欄に残す最大行数。
LOG_LINE_CHARACTERS = 20000  # 出力ログ欄の 1 行に出す最大の文字数（超えた分は切り詰めて印を付ける）。
LOG_READ_BYTES = LOG_LINE_CHARACTERS * 4 + 4  # 子プロセスの出力を 1 行として読む最大のバイト数（UTF-8 の 1 文字は最大 4 バイト。超えた分は読み捨てる）。
LOG_TRUNCATED_MARK = f"…（長すぎるため、先頭の {LOG_LINE_CHARACTERS} 文字だけを表示しました）"  # 切り詰めた行の末尾の印。
CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024  # まとめて読む標準出力（show-exposure の JSON など）の上限。超えたら中止してエラーにする。
RAW_OUTPUT_LINES = 200  # 読めなかった確認結果をログへ出すときの最大行数。
HUB_FILE_LIMIT_BYTES = 1024 * 1024  # hub.json として読む大きさの上限。
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})  # 表示や承認の対象に含めてはいけない文字の一般カテゴリ（共通仕様 S1）。
FORBIDDEN_MESSAGE = "設定に制御文字・行区切り・双方向制御文字・不可視文字が含まれているため承認できません（偽装の可能性）。"  # 禁止文字があるときの承認ダイアログの表示。
SHAPE_MESSAGE = "公開範囲の形式が想定と違うため承認できません（件数を構造から確かめられません）。"  # 公開範囲の欄の形が崩れているときの表示。
BLOCKER_FINDINGS = 5  # 承認できない理由に並べる該当項目の最大数（残りは件数だけ出す）。
BLOCKER_VALUE_CHARACTERS = 160  # 該当項目の値（引用後）を表示する最大の文字数。
UNDISPLAYABLE_VALUE = "（表示できない値）"  # 入れ子が深すぎるなど、JSON の表記にできない値の表示。
UNDISPLAYABLE_MESSAGE = "表示できない項目があるため承認できません（入れ子が深すぎるなど）。"  # その他の項目を表示できないときの表示。
CLAUDE_CODE_WARNING = (
    "警告: この承認で、ChatGPT から Claude Code を起動し、このプロジェクトの作業ツリーのファイルを書き換えさせ、"
    "次のコマンドを確認なしで実行させられるようになります（git の commit・push はできません。Claude Code の利用枠を消費します）。"
    "許可したコマンドがプロジェクト内のスクリプトを実行する場合、Claude Code はそのスクリプトを書き換えてから実行できるため、実質的に任意のコードを実行できます。"
)  # claudeCode.enabled が true のときに、承認ダイアログで必ず出す警告（文言は固定）。
SUMMARY_SHA_HEADING = "公開範囲の指紋（SHA-256）:"  # 要約の指紋の見出し（64 桁は別の欄で、折り返して全桁を見せる）。
MIXED_SCRIPT_MARK = "⚠ 混在した文字種"  # 同形異字の疑い（1 区切りの中でラテン文字とキリル文字・ギリシャ文字が混ざる）の印。
SCRIPT_PREFIXES = (("LATIN ", "ラテン文字"), ("CYRILLIC ", "キリル文字"), ("GREEK ", "ギリシャ文字"))  # Unicode の文字名の先頭と、文字種の表示名。
DANGER_COLOR = "#c01c28"  # 警告と「公開」の強調に使う赤。
BREAK_AFTER = "。、，．）」』】・ /\\"  # この文字の直後なら行を分けてよい。
NO_LINE_START = "。、，．）」』】ー：:,.)"  # 行頭に置かない文字。
SUCCESS_MESSAGE = "CLI の処理は成功しました（ChatGPT からの呼び出しの確認は別の段階です）"  # 終了コード 0 のときの表示。
FAILURE_MESSAGE = "失敗しました"  # 終了コードが 0 以外のときの表示。
TERMINAL_OPENED_MESSAGE = "端末窓を開きました。キーはその窓に貼り付けてください（この画面には入力しません）。終わったら『一覧を更新』を押してください"  # 端末を開いたあとの案内。
CLOSE_FOREGROUND_MESSAGE = "ハブ（または Tunnel Client）が止まります。閉じますか?"  # 起動中に閉じるときの確認。
HUB_WARNING_FALLBACK = "ハブ方式では、このアプリを使うどのチャットからも、承認済みの全プロジェクトを読めます。"  # 説明データに注意書きが無いときの警告。
ACTION_SECTIONS = (
    ("when", "いつ使う"),
    ("requires", "事前に必要"),
    ("effect", "実行すると"),
    ("next", "次にすること"),
    ("caution", "注意"),
)  # Action の説明の項目と見出し。
OPTION_SECTIONS = (
    ("example", "入力例"),
    ("default", "既定"),
    ("caution", "注意"),
)  # オプションの説明の項目と見出し。
GUI_ACTION_NOTES = {
    "approve": "先に公開範囲を確認します（show-exposure）。未承認・変更ありなら承認ダイアログを出し、「この内容で承認」を押したときだけ、表示した指紋を CLI へ渡します。承認済みならダイアログは出しません。",
    "start": "先に公開範囲を確認し、未承認・変更ありなら承認ダイアログを出します。「停止」ボタンは、CLI と Tunnel Client のプロセスグループへ SIGTERM を送ります。起動中も「稼働状態を表示」などの読み取り専用の操作は実行できます。",
    "add-project": "足場（.chatgpt-project-bridge.json）が無ければ先に「プロジェクトを初期化」（init）を実行し、公開範囲の承認ダイアログを出します。そのあと別の端末窓で CLI を --no-start 付きで実行します。キーはその端末窓に入力します。起動は「Tunnel を起動」で別に行います。",
    "hub-add": "足場（.chatgpt-project-bridge.json）が無ければ先に「プロジェクトを初期化」（init）を実行し、公開範囲の承認ダイアログを出します。そのあと別の端末窓で CLI を --no-start 付きで実行します。キーを求められたら、その端末窓に入力します。起動は「ハブを起動」で別に行います。",
    "hub-start": "hub.json の登録プロジェクトごとに公開範囲を確認し、未承認・変更ありのものは承認ダイアログを出します（承認したものだけ approve で保存）。そのあと --service 付きで起動します。承認を断ったプロジェクトは公開されず、ほかのプロジェクトで起動します。「停止」ボタンは hub-stop を実行します。起動中も「ハブの稼働状態」「登録一覧を表示」は実行できます。",
    "hub-restart": "hub.json の登録プロジェクトごとに公開範囲を確認し、未承認・変更ありのものは承認ダイアログを出します（承認したものだけ approve で保存）。そのあと --service 付きで再起動します。承認を断ったプロジェクトは公開されず、ほかのプロジェクトで起動します。「停止」ボタンは hub-stop を実行します。起動中も「ハブの稼働状態」「登録一覧を表示」は実行できます。",
    "save-key": "別の端末窓で CLI を実行します。キーはその端末窓に入力します（この画面には入力しません）。",
    "hub-service-install": "「起動しない」（no-start）は Windows 専用のため、この画面には出しません。ユニットファイルを書くだけにするときは「有効化しない」を使います。",
    "hub-remove": "「プロジェクトのフォルダー」と「ハブ内の名前」の両方が空のときは実行しません（CLI では、この画面を起動したフォルダーが対象になるため）。",
}  # この画面での動きの補足（画面側の事実だけ）。
GUI_OPTION_NOTES = {
    ("add-project", "no-start"): "この画面からは常に付けます。起動は「Tunnel を起動」で別に行います。",
    ("hub-add", "no-start"): "この画面からは常に付けます。起動は「ハブを起動」で別に行います。",
    ("hub-start", "service"): "この画面からは常に付けます。未承認・変更ありのプロジェクトは、起動の前にこの画面の承認ダイアログで確認します。承認しなかったプロジェクトは公開されません。",
    ("hub-restart", "service"): "この画面からは常に付けます。未承認・変更ありのプロジェクトは、再起動の前にこの画面の承認ダイアログで確認します。承認しなかったプロジェクトは公開されません。",
}  # 常に付けるフラグの補足。
GROUP_TOOLTIPS = {
    "easy": "ハブ方式で、プロジェクトの追加・起動・停止・状態の確認をする、よく使う操作です。",
    "hub": "ハブ方式の残りの操作です（ハブから外す・再起動・診断・自動起動の登録と解除）。",
    "legacy": "1 プロジェクトに専用の Tunnel を割り当てる従来方式の操作と、公開範囲の確認・承認です。",
    "maintainer": "署名鍵や gh（GitHub CLI）を使う、配布物の作成者向けの操作です。",
}  # タブの説明。
MAINTAINER_WARNING = "署名鍵や gh（GitHub CLI）を使う、配布物の作成者向けの操作です"  # 保守者向けタブの先頭の警告。
EASY_INTRO_LINES = (
    "このタブでできること:",
    "・プロジェクトをハブに追加します（公開範囲の承認はこの画面、キーは別の端末窓で入力します）。",
    "・ハブを起動・停止して、ChatGPT から読める状態を切り替えます。",
    "・登録一覧とハブの稼働状態を確かめます。",
)  # かんたんタブの先頭の説明（見出し＋3 行）。
EASY_RECOVERY_TEMPLATE = "・画面が異常終了した場合は、「{status}」で確かめ、残っていれば「{stop}」を押してください。"  # 異常終了（SIGKILL・クラッシュ）でハブが残りうることの案内。{status}・{stop} は説明データの表示名。
STAGE_NOTE = "このツールが確かめるのは前の 3 つまでです。\n後ろの 2 つは ChatGPT 側で確認が必要です。"  # 5 段階の下の注記。
HUB_STATE_RUNNING = "ハブ: ● 実行中（PID {pid}）"  # 稼働表示（実行中）。{pid} は Tunnel Client の PID。
HUB_STATE_STOPPED = "ハブ: ○ 停止中"  # 稼働表示（停止中）。
HUB_STATE_UNSET = "ハブ: 未設定"  # 稼働表示（Tunnel ID がまだ登録されていない）。
HUB_STATE_UNKNOWN = "ハブ: 確認できません"  # 稼働表示（hub.json を読めないなど、確かめられない）。
HUB_DETAIL_TEMPLATE = "Tunnel ID: {tunnel} / プロファイル: {profile} / 登録 {count} 件"  # 稼働表示の詳細（実行中・停止中に共通）。
HUB_DETAIL_STOPPED_SUFFIX = "。「ハブを起動」で起動します。"  # 停止中の詳細の末尾に足す案内。
HUB_DETAIL_UNSET = "Tunnel ID がまだ登録されていません。「プロジェクトを追加」で登録します。"  # 未設定の詳細。
HUB_DETAIL_NO_PROFILE = "ハブ設定（hub.json）のプロファイル名（profileName）が無いか、形式が正しくないため、稼働を確かめられません。"  # Tunnel ID はあるのにプロファイル名を使えないときの詳細。
HUB_RUNNING_COLOR = "#26a269"  # 「実行中」の文字色（緑）。
HUB_STATE_TOOLTIP = (
    "この PC のハブ（Tunnel Client）のプロセスが動いているかを、3 秒ごとに調べて表示します。"
    "調べるのは、Tunnel Client が書く PID ファイルと、その PID のプロセスだけです（読み取りだけで、通信はしません。ハブ設定も読むだけです）。"
    "この画面の外（別の端末や自動起動）で起動したハブも表示します。"
    "「実行中」が示すのは、5 段階のうち 3 の「Tunnel Client の稼働」だけです。"
    "OpenAI とつながっているかは「ハブの稼働状態」で、ChatGPT から読めるかは ChatGPT の画面で確かめます。"
    "起動したときと「一覧を更新」のときには、分かっている値（「プロジェクトを追加」の Tunnel ID と、Tunnel Client の場所）を空の入力欄に入れます。"
    "入力済みの値は書き換えません。"
)  # 稼働表示の帯（状態と詳細の 2 つのラベル）の説明。
STAGE_TITLE_TOOLTIP = "ChatGPT から読めるまでの確認は 5 段階に分かれます。1 つの成功表示で、全部が済んだことにはなりません。"  # 「確認の 5 段階」の枠の説明。
STAGE_HUB_NOTE = "画面の上の「ハブ」の表示が示すのは、3 の Tunnel Client のプロセスの有無だけです。"  # 5 段階の枠の説明の末尾に足す、稼働表示の帯の注記。
PERMISSION_UNKNOWN_TEXT = "（未確認）"  # 一覧の列（ソースの読み取り・Claude Code・承認）の、まだ hub-permissions を実行していないときの表示。
PERMISSION_SOURCE_LABELS = {"on": "On", "off": "Off", "partial": "一部のみ（使えません）"}  # 一覧に出す、sourceRead の表示名。
PERMISSION_CLAUDE_LABELS = {"off": "Off", "unset": "設定なし"}  # 一覧に出す、claudeCode の表示名（on は許可コマンドの件数を見て別に組み立てる）。
PERMISSION_APPROVAL_LABELS = {"approved": "承認済み", "changed": "変更あり（再承認が必要）", "unapproved": "未承認", "unavailable": "確認できません"}  # 一覧に出す、承認状態の表示名。
PERMISSION_STATE_FIELDS = {"source-read": "sourceRead", "claude-code": "claudeCode"}  # 切り替えのオプション名から、hub-permissions の結果の欄名への対応。
PERMISSION_OPTION_LABELS = {"source-read": "ソースの読み取り", "claude-code": "Claude Code の起動"}  # 切り替えのオプション名から、ログに出す項目名への対応。
PERMISSION_TOGGLE_NOTE = "この承認で、プロジェクトの設定ファイル（.chatgpt-project-bridge.json）も書き換わります。キャンセルすると何も変わりません。"  # 権限の切り替えの承認ダイアログの上部に出す注記。
PERMISSION_CHECK_TOOLTIP = (
    "ハブに登録した全プロジェクトについて、ChatGPT からソースの本文を読めるか、Claude Code を起動できるかと、承認の状態を、"
    "一覧の列（ソースの読み取り・Claude Code・承認）へ表示します（hub-permissions を実行します）。読み取り専用で、hub.json・承認ファイル・"
    "プロジェクトの設定のどれにも書き込みません。プロジェクトの数に応じて数秒かかります。"
)  # 「権限を確認」ボタンの説明。
PERMISSION_TOGGLE_TOOLTIPS = {
    "source-read": (
        "一覧で選んだプロジェクトの「ソースの読み取り」を、いまと反対の値（On ⇔ Off）へ切り替えます。まだ権限を確認していなければ、先に確認します。"
        "変更後の公開範囲を確認し、承認ダイアログで「この内容で承認」を押したときだけ、設定ファイル（.chatgpt-project-bridge.json）と承認を書き換えます"
        "（キャンセルすれば何も変わりません）。"
    ),
    "claude-code": (
        "一覧で選んだプロジェクトの「Claude Code の起動」を、いまと反対の値（On ⇔ Off）へ切り替えます。まだ権限を確認していなければ、先に確認します。"
        "変更後の公開範囲を確認し、承認ダイアログで「この内容で承認」を押したときだけ、設定ファイル（.chatgpt-project-bridge.json）と承認を書き換えます"
        "（キャンセルすれば何も変わりません）。On にすると、承認ダイアログに Claude Code の警告も出ます。"
    ),
}  # 2 つの切り替えボタンの説明。


class HelpDataError(RuntimeError):
    """説明データ（gui-help.ja.json）や CLI の定義を読めないときのエラー。"""


@dataclass(frozen=True)
class ApprovalGrant:
    """利用者が承認ダイアログで「この内容で承認」を押した結果。指紋はこの形でだけ CLI へ渡す。"""

    requested_root: str  # show-exposure に渡したプロジェクトのフォルダー（入力どおり）。
    requested_profile: str | None  # show-exposure に渡したプロファイル名（無ければ None）。
    sha256: str  # 表示した公開範囲の指紋。


@dataclass(frozen=True)
class HubProject:
    """hub.json に登録されたプロジェクト 1 件（読み取った値）。"""

    name: str  # ハブ内の名前。
    root: str  # プロジェクトのフォルダー。
    approval_file: str  # 承認ファイルのパス。
    profile: str | None  # 承認ファイル名から求めたプロファイル名（所定の場所の <プロファイル名>.json と一致するときだけ。それ以外は None）。
    approval_problem: str | None = None  # 承認状態を確かめられない理由（確かめられるなら None）。


@dataclass(frozen=True)
class HubListing:
    """hub.json の読み取り結果。"""

    path: str  # hub.json の場所。
    exists: bool  # ファイルがあったか。
    projects: tuple[HubProject, ...]  # 登録プロジェクト。
    error: str | None  # 読めなかったときの理由。
    tunnel_id: str | None = None  # 記録済みの Tunnel ID（tunnel_ に小文字 16 進 32 桁の形式に合うときだけ。それ以外は None）。
    profile_name: str | None = None  # ハブ用のプロファイル名（プロファイル名の形式に合うときだけ。それ以外は None）。


# ---------------------------------------------------------------------------
# 説明データと CLI の定義
# ---------------------------------------------------------------------------


# 説明データを読み、画面の組み立てに要る最小限の形を確かめて返す。
def load_help_data(path: Path = HELP_PATH) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise HelpDataError(f"説明データを読めません: {path}: {error}") from error
    if not isinstance(data, dict) or not all(isinstance(data.get(name), dict) for name in ("groups", "actions", "options")):
        raise HelpDataError(f"説明データの形式が不正です: {path}")
    for action, info in data["actions"].items():
        if not isinstance(info, dict) or not all(isinstance(info.get(name), list) for name in ("options", "required", "interactive")):
            raise HelpDataError(f"説明データの Action の形式が不正です: {action}")
        if not all(isinstance(data["options"].get(option), dict) for option in info["options"]):
            raise HelpDataError(f"説明データの Action が、定義の無いオプションを参照しています: {action}")
    return data


# argparse の定義から、--action・--help を除く長いオプション名（先頭の -- を外した形）を返す。
def parser_option_names(parser) -> frozenset[str]:
    names: set[str] = set()  # 長いオプション名。
    for definition in parser._actions:
        for text in definition.option_strings:
            if text.startswith("--"):
                names.add(text[2:])
    return frozenset(names - {"action", "help"})


# CLI を import して build_parser() の長いオプション名を集める。import では CLI の処理は動かない。
def load_cli_option_names(cli_path: Path = CLI_PATH) -> frozenset[str]:
    spec = importlib.util.spec_from_file_location("project_bridge_cli_for_gui", cli_path)
    if spec is None or spec.loader is None:
        raise HelpDataError(f"CLI を読み込めません: {cli_path}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode  # 元の設定。
    sys.dont_write_bytecode = True  # 導入先のフォルダーに __pycache__ を作らない。
    try:
        spec.loader.exec_module(module)
        return parser_option_names(module.build_parser())
    except Exception as error:  # CLI の構文エラーなども、起動時の案内にまとめる。
        raise HelpDataError(f"CLI のオプション定義を読めません: {cli_path}: {error}") from error
    finally:
        sys.dont_write_bytecode = previous


# Action の platformOnly（オプション名から "ubuntu" / "windows" への対応）を返す。無ければ空。
def platform_only(help_data: dict, action: str) -> dict:
    value = help_data["actions"][action].get("platformOnly")
    return value if isinstance(value, dict) else {}


# Action のカードに出すオプション名を、説明データの並び順で返す。
# 他の OS 専用（platformOnly の値が ubuntu 以外）のものと、Ubuntu の CLI（build_parser）が持たないものは出さない。
def visible_options(help_data: dict, action: str, cli_options: frozenset[str]) -> list[str]:
    platforms = platform_only(help_data, action)  # OS 専用のオプション。
    return [
        name for name in help_data["actions"][action]["options"]
        if name not in HIDDEN_OPTIONS and platforms.get(name, PLATFORM) == PLATFORM and name in cli_options and name in help_data["options"]
    ]


# オプションの種類（text・path・flag・number）を返す。
def option_kind(help_data: dict, option: str) -> str:
    return str(help_data["options"][option].get("kind") or "text")


# 入力欄の値が空（空白だけを含む）かを返す。
def is_blank(value: object) -> bool:
    return value is None or not str(value).strip()


# 必須欄のうち空のものを、画面の欄の名前で返す。形式の検査はしない（CLI に任せる）。
def missing_required(help_data: dict, action: str, values: Mapping[str, str]) -> list[str]:
    info = help_data["actions"][action]
    missing = [str(help_data["options"][name]["label"]) for name in info["required"] if name not in HIDDEN_OPTIONS and is_blank(values.get(name))]
    if action == "hub-remove" and is_blank(values.get("project-root")) and is_blank(values.get("hub-name")):
        missing.append("「プロジェクトのフォルダー」または「ハブ内の名前」（両方が空だと、この画面を起動したフォルダーが対象になるため）")
    return missing


# CLI の呼び出しの先頭（python・-u・CLI のパス）を返す。
def cli_prefix() -> list[str]:
    return [sys.executable, "-u", str(CLI_PATH)]


# オプションと値を引数配列の形にする。値が - で始まるときは、オプションと取り違えられないよう = でつなぐ。
def option_pair(name: str, value: str) -> list[str]:
    return [f"--{name}={value}"] if value.startswith("-") else [f"--{name}", value]


# 空の値を None にそろえる（プロファイル名の比較用）。
def blank_to_none(value: object) -> str | None:
    return None if is_blank(value) else str(value)


# CLI の引数配列を組む。値が空のオプションは出さず、フラグはオンのものだけ出す。指紋は承認ダイアログの結果からだけ付ける。
def build_cli_arguments(help_data: dict, action: str, values: Mapping[str, str], flags: set[str] | frozenset[str], cli_options: frozenset[str], grant: ApprovalGrant | None = None) -> list[str]:
    info = help_data["actions"][action]
    arguments = [*cli_prefix(), action]  # 組み立て中の引数配列。
    forced = FORCED_FLAGS.get(action, ())  # 常に付けるフラグ。
    for name in visible_options(help_data, action, cli_options):
        if name in NEVER_FROM_INPUT:
            continue
        if option_kind(help_data, name) == "flag":
            if name in forced or name in flags:
                arguments.append(f"--{name}")
            continue
        value = values.get(name)
        if is_blank(value):
            continue
        arguments.extend(option_pair(name, str(value)))
    if grant is not None:
        if "exposure-sha256" not in info["options"]:  # 承認が要る Action（approve・start・add-project・hub-add）と、権限の切り替え（set-permission。2.8.0）だけが指紋を持つ。
            raise ValueError(f"{action} には公開範囲の指紋を渡せません。")
        if grant.requested_root != values.get("project-root") or grant.requested_profile != blank_to_none(values.get("profile")):
            raise ValueError("承認したプロジェクト（フォルダー・プロファイル）と、実行する内容が一致しません。")
        if not SHA256_PATTERN.fullmatch(grant.sha256):
            raise ValueError("公開範囲の指紋の形式が不正です。")
        arguments.extend(["--exposure-sha256", grant.sha256])
    return arguments


# 公開範囲の確認（読み取り専用）の引数配列を組む。
def build_show_exposure_arguments(project_root: str, profile: str | None) -> list[str]:
    arguments = [*cli_prefix(), "show-exposure", *option_pair("project-root", project_root)]  # 組み立て中の引数配列。
    if not is_blank(profile):
        arguments.extend(option_pair("profile", str(profile)))
    return arguments


# 足場の作成（init）の引数配列を組む。
def build_init_arguments(project_root: str, project_name: str) -> list[str]:
    return [*cli_prefix(), "init", *option_pair("project-root", project_root), *option_pair("project-name", project_name)]


# ハブの登録プロジェクトを承認する引数配列を組む。指紋は承認ダイアログの結果からだけ付ける。
def build_approve_arguments(project_root: str, profile: str | None, grant: ApprovalGrant) -> list[str]:
    if grant.requested_root != project_root or grant.requested_profile != blank_to_none(profile):
        raise ValueError("承認したプロジェクト（フォルダー・プロファイル）と、保存する内容が一致しません。")
    if not SHA256_PATTERN.fullmatch(grant.sha256):
        raise ValueError("公開範囲の指紋の形式が不正です。")
    arguments = [*cli_prefix(), "approve", *option_pair("project-root", project_root)]  # 組み立て中の引数配列。
    if not is_blank(profile):
        arguments.extend(option_pair("profile", str(profile)))
    return [*arguments, "--exposure-sha256", grant.sha256]


# 停止ボタンから呼ぶ hub-stop の引数配列を組む。「ハブを停止」のカードと同じ組み立てを使い、起動に使った Tunnel Client の場所を渡す。
def build_hub_stop_arguments(help_data: dict, cli_options: frozenset[str], tunnel_client_path: str | None) -> list[str]:
    return build_cli_arguments(help_data, "hub-stop", {"tunnel-client-path": tunnel_client_path or ""}, set(), cli_options)


# 子プロセスへ渡す環境変数。元の環境に PYTHONIOENCODING だけを足し、それ以外は足さない。
def child_environment(base: Mapping[str, str]) -> dict[str, str]:
    environment = dict(base)  # 元の環境の写し。
    environment["PYTHONIOENCODING"] = "utf-8"
    return environment


# 子プロセス（CLI）と端末を動かす作業ディレクトリ（HOME。使えなければ /）を返す。画面を起動したフォルダーに左右されないようにする。
def working_directory(environment: Mapping[str, str]) -> str:
    home = str(environment.get("HOME") or "")  # 利用者のホーム。
    return home if os.path.isabs(home) and os.path.isdir(home) else "/"


# 入力欄のパス（~ を含む・相対）を、実行前に絶対パスへそろえる。空ならそのまま返す。
def absolute_input_path(value: str) -> str:
    return value if is_blank(value) else os.path.abspath(os.path.expanduser(value))


# 引数配列を、表示用の 1 行に整える（実行にはこの文字列を使わない）。
def display_command(arguments: list[str]) -> str:
    return shlex.join([str(item) for item in arguments])


# 出力ログ欄に出す 1 行を整える。制御文字（TAB 以外。ESC・DEL・C1 を含む）は \xNN、そのほかの禁止文字（書式文字・行区切りなど）は \uXXXX の
# 見える形にし、LOG_LINE_CHARACTERS 文字を超える分は切り詰めて印を付ける。
def sanitize_log_line(text: str) -> str:
    text = str(text)
    parts: list[str] = []  # 整えた文字。
    for character in text[:LOG_LINE_CHARACTERS]:
        code = ord(character)
        if character == "\t" or not is_forbidden_character(character):
            parts.append(character)
        elif code < 0x100:
            parts.append(f"\\x{code:02x}")
        else:
            parts.append(escape_character(character))
    if len(text) > LOG_LINE_CHARACTERS:
        parts.append(LOG_TRUNCATED_MARK)
    return "".join(parts)


# 読めなかった出力を、ログへ出す行の並びにする（最大 RAW_OUTPUT_LINES 行。残りは行数だけ出す）。
def raw_output_lines(output: str) -> list[str]:
    if not output.strip():
        return ["（出力なし）"]
    lines = output.rstrip("\n").split("\n")  # 出力の行（改行 LF だけで分ける。行区切り U+2028 などは各行の中で見える形にする）。
    if len(lines) <= RAW_OUTPUT_LINES:
        return lines
    return [*lines[:RAW_OUTPUT_LINES], f"（以下 {len(lines) - RAW_OUTPUT_LINES} 行を省略しました）"]


# 子プロセスの終了を、ログに出す行の並びにする。
def exit_code_lines(code: int | None, stopped_by_user: bool) -> list[str]:
    if code is None:
        return ["子プロセスを起動できませんでした。", FAILURE_MESSAGE]
    head = f"終了コード {code}" + (f"（シグナル {-code} で終了）" if code < 0 else "")  # 終了コードの行。
    lines = [head, SUCCESS_MESSAGE if code == 0 else FAILURE_MESSAGE]
    if stopped_by_user:
        lines.append("（停止ボタンによる終了です）")
    return lines


# ---------------------------------------------------------------------------
# 承認（show-exposure の JSON の解釈とダイアログの本文）
# ---------------------------------------------------------------------------


REPORT_FIELDS = {
    "schemaVersion": (int,),
    "projectRoot": (str,),
    "profile": (str,),
    "exposureSha256": (str,),
    "approvalState": (str,),
    "approvedSha256": (str, type(None)),
    "exposure": (dict,),
    "changes": (list,),
}  # show-exposure の JSON に必要な欄と型。


# show-exposure の標準出力を解釈する。読めない・欄が欠ける・形が違うときは (None, 理由) を返し、例外は投げない。
# 入れ子が深すぎる JSON（RecursionError）や大きすぎる JSON（MemoryError）も、理由付きで返す。
def parse_exposure_report(text: object) -> tuple[dict | None, str | None]:
    try:
        report = json.loads(text if isinstance(text, str) else "")
    except (ValueError, TypeError) as error:
        return None, f"JSON として読めません: {error}"
    except RecursionError:
        return None, "JSON の入れ子が深すぎるため読めません。"
    except MemoryError:
        return None, "JSON が大きすぎるため読めません。"
    if not isinstance(report, dict):
        return None, "JSON の最上位が object ではありません。"
    for name, types in REPORT_FIELDS.items():
        if name not in report:
            return None, f"欄 {name} がありません。"
        value = report[name]
        if isinstance(value, bool) or not isinstance(value, types):
            return None, f"欄 {name} の型が不正です。"
    if report["schemaVersion"] != 1:
        return None, f"未対応の schemaVersion です: {report['schemaVersion']}"
    if not SHA256_PATTERN.fullmatch(report["exposureSha256"]):
        return None, "公開範囲の指紋（exposureSha256）の形式が不正です。"
    if report["approvalState"] not in APPROVAL_STATES:
        return None, f"未対応の承認状態です: {report['approvalState']}"
    if report["approvedSha256"] is not None and not SHA256_PATTERN.fullmatch(report["approvedSha256"]):
        return None, "承認済みの指紋（approvedSha256）の形式が不正です。"
    if not all(isinstance(line, str) for line in report["changes"]):
        return None, "欄 changes に文字列以外が含まれています。"
    if not isinstance(report.get("approvedProjectRoot"), (str, type(None))):
        return None, "欄 approvedProjectRoot の型が不正です。"
    return report, None


# 承認ダイアログが必要かを返す。承認済みで指紋も一致するときだけ不要とする（迷うときは確認する側へ倒す）。
def approval_needed(report: dict) -> bool:
    return not (report.get("approvalState") == "approved" and report.get("approvedSha256") == report.get("exposureSha256"))


# 承認ダイアログの結果から、CLI へ渡す承認を作る。利用者が承認したときだけ返し、承認済みなら何も渡さない。
# 承認できない内容（禁止文字・形の崩れ）なら返さない。別のフォルダーの承認を上書きするときは、その確認（override_acknowledged）も要る。
def grant_from_confirmation(report: dict, requested_root: str, requested_profile: str | None, confirmed: bool, override_acknowledged: bool = False) -> ApprovalGrant | None:
    if confirmed is not True or not approval_needed(report):
        return None
    if approval_blockers(report):
        return None
    if override_warning_text(report) is not None and override_acknowledged is not True:
        return None
    sha256 = report.get("exposureSha256")
    if not isinstance(sha256, str) or not SHA256_PATTERN.fullmatch(sha256):
        return None
    return ApprovalGrant(requested_root=requested_root, requested_profile=blank_to_none(requested_profile), sha256=sha256)


# hub-add の注意書きから、ハブの影響範囲の警告（最初の 2 文）を取り出す。
def hub_warning_text(help_data: dict) -> str:
    caution = str(help_data.get("actions", {}).get("hub-add", {}).get("caution") or "")  # hub-add の注意書き。
    sentences = [part.strip() + "。" for part in caution.split("。") if part.strip()]  # 文ごとに分けたもの。
    text = "".join(sentences[:2])  # 警告とその対処。
    return text if "ハブ方式" in text else HUB_WARNING_FALLBACK + text


# 文字が、表示や承認の対象に含めてはいけない文字（共通仕様 S1: 制御・書式・行区切り・段落区切り・対にならないサロゲート）かを返す。
def is_forbidden_character(character: str) -> bool:
    return unicodedata.category(character) in FORBIDDEN_CATEGORIES


# 文字列に、共通仕様 S1 の禁止文字が含まれるかを返す。
def has_forbidden_character(text: str) -> bool:
    return any(is_forbidden_character(character) for character in str(text))


# 1 文字を表示用のエスケープにする（BMP は \uXXXX、BMP 外は \UXXXXXXXX。16 進は小文字）。
def escape_character(character: str) -> str:
    code = ord(character)
    return f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}"


# 表示で見える形に変える文字（S1 の禁止文字と、U+0020 以外の空白）かを返す。
def needs_display_escape(character: str) -> bool:
    category = unicodedata.category(character)
    return category in FORBIDDEN_CATEGORIES or (category == "Zs" and character != " ")


# 値を共通仕様 S2 の形で表示用に引用する（二重引用符で囲み、\ と " をエスケープし、禁止文字と U+0020 以外の空白を \uXXXX にする）。
def quote_for_display(text: str) -> str:
    parts = ['"']  # 引用した文字。
    for character in str(text):
        if character == "\\":
            parts.append("\\\\")
        elif character == '"':
            parts.append('\\"')
        elif needs_display_escape(character):
            parts.append(escape_character(character))
        else:
            parts.append(character)
    parts.append('"')
    return "".join(parts)


# 引用符を付けずに、禁止文字と U+0020 以外の空白だけを \uXXXX にする（JSON の表記など、引用符を足さない値に使う）。
def escape_for_display(text: str) -> str:
    return "".join(escape_character(character) if needs_display_escape(character) else character for character in str(text))


# 値を JSON の表記にする。入れ子が深すぎるなど表記できなければ、その旨の文にする（例外は投げない）。
def json_text(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError, RecursionError):
        return UNDISPLAYABLE_VALUE


# 長い表示を最大 limit 文字に切り詰め、切ったときは末尾に … を付ける。
def shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit - 1] + "…"


CHANGE_LABELS = {
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
}  # CLI の差分の行（project-bridge.py の exposure_change_lines）の項目名から、日本語の名前への対応。


# 差分の値（JSON の表記、または前回に無かったことを示す "(なし)"）として読めるかを返す。
def is_change_value(text: str) -> bool:
    if text == "(なし)":
        return True
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


# CLI の差分の行「name: 前 -> 後」を「日本語名（name）: 前 → 後」にする。値は変えない。読めない行はそのまま返す。
def translate_change_line(line: str) -> str:
    match = re.fullmatch(r"([A-Za-z][A-Za-z0-9_]*): (.*)", line, re.DOTALL)
    if not match:
        return line
    name, rest = match.groups()
    label = f"{CHANGE_LABELS[name]}（{name}）" if name in CHANGE_LABELS else name  # 表示する項目名。
    separator = " -> "  # CLI が前と後の間に置く文字列。
    position = rest.find(separator)
    while position >= 0:
        before, after = rest[:position], rest[position + len(separator):]
        if is_change_value(before) and is_change_value(after):
            return f"{label}: {before} → {after}"
        position = rest.find(separator, position + 1)
    return f"{label}: {rest}"


KNOWN_EXPOSURE_FIELDS = (
    "schemaVersion", "projectRoot", "contextFile", "statusFile", "allowFiles", "allowDirectories", "denyDirectories", "maxDocumentBytes", "gitExposure", "detailExposure", "sourceScope", "claudeCode",
)  # 承認ダイアログが個別に表示する公開範囲の欄（これ以外は「その他の項目」に出す）。


@dataclass(frozen=True)
class DetailLine:
    """承認ダイアログの詳細（スクロールする部分）の 1 行。"""

    text: str  # 表示する 1 行（改行を含まない）。
    heading: bool = False  # 見出しの行か（太字にする）。
    warning: str = ""  # 行の後ろに赤で付ける印（同形異字の疑いなど）。無ければ空。


@dataclass(frozen=True)
class ApprovalSummary:
    """承認ダイアログの固定の要約。件数と真偽値は、公開範囲の構造（配列の長さ・真偽値）から数える。"""

    files: int | None  # 公開ファイルの件数（形が崩れていれば None）。
    directories: int | None  # 公開ディレクトリの件数。
    recursive_directories: int | None  # 公開ディレクトリのうち、配下すべての件数。
    denied: int | None  # 拒否ディレクトリの件数。
    git_paths: bool  # Git のファイル名を公開するか。
    git_subjects: bool  # Git のコミット件名を公開するか。
    max_bytes: int | None  # 文書 1 件の上限（バイト）。
    sha256: str  # 公開範囲の指紋（形式は parse_exposure_report で確かめ済み）。


@dataclass(frozen=True)
class ApprovalView:
    """承認ダイアログに出す内容（GTK に依存しない）。文字列はどれも、改行を含まない 1 行。"""

    state_text: str  # 承認状態（未承認・前回から変更あり）。
    root_text: str  # プロジェクトルート（S2 で引用）。
    profile_text: str  # プロファイル（S2 で引用）。
    hub_warning: str | None  # ハブの影響範囲の警告（従来方式なら None）。
    blockers: tuple[str, ...]  # 承認できない理由（空なら承認できる）。
    override_warning: str | None  # 別のフォルダーの承認を上書きする警告（無ければ None）。
    summary: ApprovalSummary  # 固定の要約。
    details: tuple[DetailLine, ...]  # スクロールする詳細。
    extra_note: str | None = None  # 呼び出し側が足す注記（2.8.0: 権限の切り替えで設定ファイルも書き換わることなど。無ければ None）。


# 公開範囲の欄の表示名（日本語名（識別子））を返す。
def field_label(name: str) -> str:
    return f"{CHANGE_LABELS[name]}（{name}）" if name in CHANGE_LABELS else escape_for_display(name)


# 承認の対象の文字列（projectRoot・profile・exposure・changes）のうち、S1 の禁止文字を含むものを (項目名, 値) の並びで返す。
# 公開範囲の項目名（object のキー）も調べる。入れ子が深くても再帰しない（明示のキューで幅優先にたどる）。
def forbidden_strings(report: dict) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []  # 禁止文字を含む (項目名, 値)。
    pending = deque([
        ("プロジェクトルート（projectRoot）", report.get("projectRoot"), False),
        ("プロファイル（profile）", report.get("profile"), False),
        ("公開範囲（exposure）", report.get("exposure"), True),
        ("前回からの差分（changes）", report.get("changes"), False),
    ])  # たどる (項目名, 値, 公開範囲の最上位か)。
    while pending:
        label, value, top = pending.popleft()
        if isinstance(value, str):
            if has_forbidden_character(value):
                found.append((label, value))
        elif isinstance(value, dict):
            for key, item in value.items():
                name = str(key)  # 項目名。
                if has_forbidden_character(name):
                    found.append((f"{label}の項目名", name))
                pending.append((field_label(name) if top else f"{label}の {escape_for_display(name)}", item, False))
        elif isinstance(value, list):
            for index, item in enumerate(value, start=1):
                pending.append((f"{label}の {index} 番目", item, False))
    return found


# 公開範囲の主な欄の形を確かめ、想定と違う欄の表示名を返す（要約の件数を構造から数えるための前提）。
def exposure_shape_problems(exposure: object) -> list[str]:
    if not isinstance(exposure, dict):
        return ["公開範囲（exposure）"]
    problems: list[str] = []  # 形が想定と違う欄。
    for name in ("projectRoot", "contextFile", "statusFile"):
        if not isinstance(exposure.get(name), str):
            problems.append(field_label(name))
    for name in ("allowFiles", "denyDirectories"):
        value = exposure.get(name)
        if not (isinstance(value, list) and all(isinstance(item, str) for item in value)):
            problems.append(field_label(name))
    directories = exposure.get("allowDirectories")  # 許可ディレクトリの規則。
    if not (isinstance(directories, list) and all(isinstance(rule, dict) and isinstance(rule.get("path"), str) and isinstance(rule.get("recursive"), bool) for rule in directories)):
        problems.append(field_label("allowDirectories"))
    size = exposure.get("maxDocumentBytes")  # 文書 1 件の上限。
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        problems.append(field_label("maxDocumentBytes"))
    git = exposure.get("gitExposure")  # Git の名前の公開設定。
    if not (isinstance(git, dict) and isinstance(git.get("paths"), bool) and isinstance(git.get("commitSubjects"), bool)):
        problems.append(field_label("gitExposure"))
    detail = exposure.get("detailExposure")  # 2.5.0 の詳細取得ツールの公開設定。省略されていれば非公開（検査しない）。
    if detail is not None and not (
        isinstance(detail, dict) and isinstance(detail.get("branchNames"), bool) and isinstance(detail.get("diffExcerpts"), bool) and isinstance(detail.get("sourceText"), bool)
    ):
        problems.append(field_label("detailExposure"))
    scope = exposure.get("sourceScope")  # 2.6.0 のソース読み取り範囲を広げる設定。省略されていれば広げない（検査しない）。
    if scope is not None and not (
        isinstance(scope, dict)
        and isinstance(scope.get("additionalDirectories"), list) and all(isinstance(item, str) for item in scope.get("additionalDirectories"))
        and isinstance(scope.get("logDirectories"), list) and all(isinstance(rule, dict) and isinstance(rule.get("path"), str) and isinstance(rule.get("recursive"), bool) for rule in scope.get("logDirectories"))
    ):
        problems.append(field_label("sourceScope"))
    claude_code = exposure.get("claudeCode")  # 2.7.0 のClaude Codeのジョブ実行を許可する設定。省略されていれば無効（検査しない）。
    if claude_code is not None and not (
        isinstance(claude_code, dict)
        and isinstance(claude_code.get("enabled"), bool)
        and isinstance(claude_code.get("allowedCommands"), list) and all(isinstance(item, str) for item in claude_code.get("allowedCommands"))
        and (claude_code.get("model") is None or isinstance(claude_code.get("model"), str))
        and (claude_code.get("effort") is None or isinstance(claude_code.get("effort"), str))
        and isinstance(claude_code.get("maxMinutes"), int) and not isinstance(claude_code.get("maxMinutes"), bool)
        and (claude_code.get("maxBudgetUsd") is None or (isinstance(claude_code.get("maxBudgetUsd"), (int, float)) and not isinstance(claude_code.get("maxBudgetUsd"), bool)))
    ):
        problems.append(field_label("claudeCode"))
    return problems


# 承認できない理由（禁止文字・公開範囲の形の崩れ）を、1 行ずつの文で返す。空なら承認できる。
def approval_blockers(report: dict) -> list[str]:
    blockers: list[str] = []  # 承認できない理由。
    found = forbidden_strings(report)
    if found:
        shown = [f"{label} = {shorten(quote_for_display(value), BLOCKER_VALUE_CHARACTERS)}" for label, value in found[:BLOCKER_FINDINGS]]  # 表示する該当項目。
        rest = len(found) - len(shown)  # 表示しなかった該当項目の数。
        blockers.append(FORBIDDEN_MESSAGE + "該当項目: " + "、".join(shown) + (f"、ほか {rest} 件" if rest else ""))
    problems = exposure_shape_problems(report.get("exposure"))
    if problems:
        blockers.append(SHAPE_MESSAGE + "該当する欄: " + "、".join(problems))
    exposure = report.get("exposure") if isinstance(report.get("exposure"), dict) else {}  # 承認の対象となる公開範囲。
    hidden = [field_label(str(name)) for name, value in exposure.items() if name not in KNOWN_EXPOSURE_FIELDS and json_text(value) == UNDISPLAYABLE_VALUE]  # 表示できないその他の項目。
    if hidden:
        blockers.append(UNDISPLAYABLE_MESSAGE + "該当する欄: " + "、".join(hidden))
    return blockers


# 別のフォルダーの承認を上書きする危険があれば、その警告文を返す（共通仕様 S4。approvalState が changed で、
# approvedProjectRoot が文字列で、いまのプロジェクトルートと違うとき）。欄が無い（古い CLI）ときは null と同じに扱う。
def override_warning_text(report: dict) -> str | None:
    approved_root = report.get("approvedProjectRoot")  # 承認ファイルに記録されたプロジェクトルート。
    if report.get("approvalState") != "changed" or not isinstance(approved_root, str):
        return None
    exposure = report.get("exposure") if isinstance(report.get("exposure"), dict) else {}  # 現在の公開範囲。
    current = {value for value in (report.get("projectRoot"), exposure.get("projectRoot")) if isinstance(value, str)}  # いまのプロジェクトルート（CLI と公開範囲の表記）。
    if approved_root in current:
        return None
    return f"このプロファイル名は別のフォルダー {quote_for_display(approved_root)} の承認に使われています。承認すると、そのフォルダーの承認が上書きされます。"


# パスの区切りごとに、ラテン文字とキリル文字・ギリシャ文字が混ざっているかを調べ、混ざった文字種の表示名を返す（無ければ空）。
def mixed_scripts(path: str) -> tuple[str, ...]:
    for segment in re.split(r"[/\\]", str(path)):
        found: list[str] = []  # この区切りに現れた文字種。
        for character in segment:
            name = unicodedata.name(character, "")  # Unicode の文字名。
            for prefix, label in SCRIPT_PREFIXES:
                if name.startswith(prefix) and label not in found:
                    found.append(label)
        if SCRIPT_PREFIXES[0][1] in found and len(found) >= 2:
            return tuple(found)
    return ()


# パスの値を、詳細の 1 行（S2 で引用。文字種が混ざっていれば印付き）にする。文字列でなければ JSON の表記を見える形にする。
def path_detail_line(prefix: str, value: object, suffix: str = "") -> DetailLine:
    if not isinstance(value, str):
        return DetailLine(f"{prefix}{escape_for_display(json_text(value))}{suffix}")
    scripts = mixed_scripts(value)  # 混ざった文字種。
    warning = f"{MIXED_SCRIPT_MARK}（{'・'.join(scripts)}）" if scripts else ""  # 行の後ろの印。
    return DetailLine(f"{prefix}{quote_for_display(value)}{suffix}", warning=warning)


# 値が配列ならそのまま、そうでなければ空の配列を返す（件数は形を確かめた配列からだけ数える）。
def list_or_empty(value: object) -> list:
    return value if isinstance(value, list) else []


# 承認ダイアログの固定の要約を、公開範囲の構造（配列の長さ・真偽値）から作る。値の文字列からは作らない。
def approval_summary(report: dict) -> ApprovalSummary:
    exposure = report.get("exposure") if isinstance(report.get("exposure"), dict) else {}  # 承認の対象となる公開範囲。
    files = exposure.get("allowFiles")  # 明示許可のファイル。
    directories = exposure.get("allowDirectories")  # 許可ディレクトリの規則。
    denied = exposure.get("denyDirectories")  # 拒否ディレクトリ。
    git = exposure.get("gitExposure") if isinstance(exposure.get("gitExposure"), dict) else {}  # Git の名前の公開設定。
    size = exposure.get("maxDocumentBytes")  # 文書 1 件の上限。
    return ApprovalSummary(
        files=len(files) if isinstance(files, list) else None,
        directories=len(directories) if isinstance(directories, list) else None,
        recursive_directories=sum(1 for rule in directories if isinstance(rule, dict) and rule.get("recursive") is True) if isinstance(directories, list) else None,
        denied=len(denied) if isinstance(denied, list) else None,
        git_paths=git.get("paths") is True,
        git_subjects=git.get("commitSubjects") is True,
        max_bytes=size if isinstance(size, int) and not isinstance(size, bool) else None,
        sha256=str(report.get("exposureSha256") or ""),
    )


# 件数を表示する（数えられなければ「不明」）。
def count_text(count: int | None) -> str:
    return "不明" if count is None else f"{count} 件"


# 要約の件数の行を返す。
def summary_count_text(summary: ApprovalSummary) -> str:
    return (f"公開ファイル {count_text(summary.files)} / 公開ディレクトリ {count_text(summary.directories)}（うち配下すべて {count_text(summary.recursive_directories)}）"
            f" / 拒否ディレクトリ {count_text(summary.denied)}")


# 公開か非公開かの表示名を返す。
def public_text(public: bool) -> str:
    return "公開" if public else "非公開"


# 要約の Git の行を返す（画面では「公開」を太字・赤で強調する）。
def summary_git_text(summary: ApprovalSummary) -> str:
    return f"Git のファイル名: {public_text(summary.git_paths)} / Git のコミット件名: {public_text(summary.git_subjects)}"


# 要約の文書の上限の行を返す。
def summary_size_text(summary: ApprovalSummary) -> str:
    return f"文書 1 件の上限: {'不明' if summary.max_bytes is None else summary.max_bytes} バイト"


# 承認ダイアログの詳細（スクロールする部分）の行を作る。変更ありなら差分を先頭に、続けて公開ファイル・公開ディレクトリ・
# 拒否ディレクトリ・ソース読み取り範囲（sourceScope があれば）・Claude Code のジョブ（claudeCode があれば）を 1 項目 1 行・番号付き・S2 の引用付きで全件並べる（省略しない）。欄が崩れていても例外にしない。
def approval_detail_lines(report: dict) -> list[DetailLine]:
    exposure = report.get("exposure") if isinstance(report.get("exposure"), dict) else {}  # 承認の対象となる公開範囲。
    lines: list[DetailLine] = []  # 詳細の行。
    if report.get("approvalState") == "changed":
        changes = list_or_empty(report.get("changes"))  # 前回承認との差分（最初に読めるよう先頭に置く）。
        lines.append(DetailLine(f"前回の承認から変わった項目（{len(changes)} 件）:", heading=True))
        lines.extend(DetailLine(f"  {index}. {translate_change_line(escape_for_display(item if isinstance(item, str) else json_text(item)))}") for index, item in enumerate(changes, start=1))
        if not changes:
            lines.append(DetailLine("  （差分の詳細を取得できませんでした）"))
        lines.append(DetailLine(""))
    lines.append(path_detail_line(f"{field_label('contextFile')}: ", exposure.get("contextFile")))
    lines.append(path_detail_line(f"{field_label('statusFile')}: ", exposure.get("statusFile")))
    lines.append(DetailLine(""))
    files = list_or_empty(exposure.get("allowFiles"))  # 明示許可のファイル。
    lines.append(DetailLine(f"公開ファイル（{len(files)} 件）:", heading=True))
    lines.extend(path_detail_line(f"  {index}. ", item) for index, item in enumerate(files, start=1))
    if not files:
        lines.append(DetailLine("  （なし）"))
    lines.append(DetailLine(""))
    directories = list_or_empty(exposure.get("allowDirectories"))  # 許可ディレクトリの規則。
    lines.append(DetailLine(f"公開ディレクトリ（Markdown だけ。{len(directories)} 件）:", heading=True))
    for index, rule in enumerate(directories, start=1):
        if isinstance(rule, dict):
            scope = "（配下すべて）" if rule.get("recursive") is True else "（直下だけ）"  # 規則の範囲。
            lines.append(path_detail_line(f"  {index}. ", rule.get("path"), scope))
        else:
            lines.append(path_detail_line(f"  {index}. ", rule))
    if not directories:
        lines.append(DetailLine("  （なし）"))
    lines.append(DetailLine(""))
    denied = list_or_empty(exposure.get("denyDirectories"))  # 拒否ディレクトリ。
    lines.append(DetailLine(f"拒否ディレクトリ（{len(denied)} 件）:", heading=True))
    lines.extend(path_detail_line(f"  {index}. ", item) for index, item in enumerate(denied, start=1))
    if not denied:
        lines.append(DetailLine("  （なし）"))
    detail_exposure = exposure.get("detailExposure") if isinstance(exposure.get("detailExposure"), dict) else None  # 2.5.0 の詳細取得ツールの公開設定。設定が無ければ None（すべて非公開）で、1行も出さない。
    if detail_exposure is not None:
        lines.append(DetailLine(""))
        lines.append(DetailLine("詳細取得ツールの公開設定:", heading=True))
        lines.append(DetailLine(f"  ブランチ名（branchNames）: {'公開' if detail_exposure.get('branchNames') is True else '非公開'}"))
        lines.append(DetailLine(f"  差分の抜粋（diffExcerpts）: {'公開' if detail_exposure.get('diffExcerpts') is True else '非公開'}"))
        lines.append(DetailLine(f"  ファイル本文（設定・ソース・記録）（sourceText）: {'公開' if detail_exposure.get('sourceText') is True else '非公開'}"))
    scope = exposure.get("sourceScope") if isinstance(exposure.get("sourceScope"), dict) else None  # 2.6.0 のソース読み取り範囲を広げる設定。設定が無ければ None（広げない）で、1行も出さない。
    if scope is not None:
        lines.append(DetailLine(""))
        scope_additional = list_or_empty(scope.get("additionalDirectories"))  # 既定除外のうち明示的に開けるディレクトリ。
        lines.append(DetailLine(f"追加で開けるディレクトリ（{len(scope_additional)} 件）:", heading=True))
        lines.extend(path_detail_line(f"  {index}. ", item) for index, item in enumerate(scope_additional, start=1))
        if not scope_additional:
            lines.append(DetailLine("  （なし）"))
        lines.append(DetailLine(""))
        scope_logs = [rule for rule in list_or_empty(scope.get("logDirectories")) if isinstance(rule, dict)]  # read_test_log が読んでよい場所。
        lines.append(DetailLine(f"ログの読み取り場所（{len(scope_logs)} 件）:", heading=True))
        for index, rule in enumerate(scope_logs, start=1):
            log_scope = "（配下すべて）" if rule.get("recursive") is True else "（直下だけ）"  # 規則の範囲。
            lines.append(path_detail_line(f"  {index}. ", rule.get("path"), log_scope))
        if not scope_logs:
            lines.append(DetailLine("  （なし）"))
    claude_code = exposure.get("claudeCode") if isinstance(exposure.get("claudeCode"), dict) else None  # 2.7.0 のClaude Codeのジョブ実行を許可する設定。設定が無ければ None（無効）で、1行も出さない。
    if claude_code is not None:
        lines.append(DetailLine(""))
        claude_enabled = claude_code.get("enabled") is True  # ChatGPTからClaude Codeのジョブ実行を許可するか。
        claude_commands = list_or_empty(claude_code.get("allowedCommands"))  # 確認なしで実行してよいコマンド。
        claude_model = claude_code.get("model")  # 使うモデル（無指定なら None）。
        claude_effort = claude_code.get("effort")  # 思考の強さ（無指定なら None）。
        claude_budget = claude_code.get("maxBudgetUsd")  # 推定コストの上限（ドル。無指定なら None）。
        lines.append(DetailLine(f"Claude Code のジョブ: {'有効' if claude_enabled else '無効'}", heading=True))
        if claude_enabled:
            lines.append(DetailLine(CLAUDE_CODE_WARNING))
        if claude_commands:
            lines.append(DetailLine(f"コマンドの実行（{len(claude_commands)} 件。確認なしで実行できます）:"))
            lines.extend(path_detail_line(f"  {index}. ", item) for index, item in enumerate(claude_commands, start=1))
        else:
            lines.append(DetailLine("コマンドの実行: なし（ファイルの編集だけ）"))
        lines.append(DetailLine(f"model: {quote_for_display(claude_model) if isinstance(claude_model, str) else '（指定なし）'} / effort: {quote_for_display(claude_effort) if isinstance(claude_effort, str) else '（指定なし）'}"))
        lines.append(DetailLine(f"制限時間: {escape_for_display(json_text(claude_code.get('maxMinutes')))} 分 / 推定コストの上限: {('$' + escape_for_display(json_text(claude_budget))) if claude_budget is not None else '（指定なし）'}"))
    extra = [name for name in sorted(exposure, key=str) if name not in KNOWN_EXPOSURE_FIELDS]  # 上に無い項目（将来の追加分）。
    if extra:
        lines.append(DetailLine(""))
        lines.append(DetailLine("その他の項目:", heading=True))
        lines.extend(DetailLine(f"  - {escape_for_display(name)}: {escape_for_display(json_text(exposure[name]))}") for name in extra)
    return lines


# 承認状態の文を返す。
def approval_state_text(report: dict) -> str:
    state = report.get("approvalState")  # 承認状態。
    if state == "changed":
        return "公開範囲が前回の承認から変わっています。"
    if state == "unapproved":
        return "このプロジェクトはまだ承認されていません。"
    return "承認済みと記録されていますが、指紋が一致しません。"


# show-exposure の結果から、承認ダイアログに出す内容を作る（GTK に依存しない）。欄が欠けても例外にしない。
def approval_view(report: dict, hub_warning: str | None = None, extra_note: str | None = None) -> ApprovalView:
    exposure = report.get("exposure") if isinstance(report.get("exposure"), dict) else {}  # 承認の対象となる公開範囲。
    root = exposure.get("projectRoot") if isinstance(exposure.get("projectRoot"), str) else report.get("projectRoot")  # 承認の対象のプロジェクトルート。
    root_text = "プロジェクトルート: " + (quote_for_display(root) if isinstance(root, str) else "（記載なし）")  # プロジェクトルートの行。
    if isinstance(report.get("projectRoot"), str) and isinstance(root, str) and report["projectRoot"] != root:
        root_text += f"（CLI が示したフォルダー: {quote_for_display(report['projectRoot'])}）"
    profile = report.get("profile")  # 承認の保存先の名前。
    return ApprovalView(
        state_text=approval_state_text(report),
        root_text=root_text,
        profile_text="プロファイル（承認の保存先の名前）: " + (quote_for_display(profile) if isinstance(profile, str) else "（記載なし）"),
        hub_warning=hub_warning or None,
        blockers=tuple(approval_blockers(report)),
        override_warning=override_warning_text(report),
        summary=approval_summary(report),
        details=tuple(approval_detail_lines(report)),
        extra_note=extra_note or None,
    )


# 承認ダイアログに出す文字列を、画面の上から順に 1 行ずつ返す（試験と記録用。画面も同じ内容を出す）。
def approval_view_lines(view: ApprovalView) -> list[str]:
    lines = []  # 画面の上から順の行。
    if view.extra_note:
        lines.append(view.extra_note)
    lines.extend([view.state_text, view.root_text, view.profile_text])  # 固定の見出し。
    if view.hub_warning:
        lines.append(f"警告: {view.hub_warning}")
    lines.extend(view.blockers)
    if view.override_warning:
        lines.append(view.override_warning)
    lines.extend(line.text + (f"  {line.warning}" if line.warning else "") for line in view.details)
    lines.extend([summary_count_text(view.summary), summary_git_text(view.summary), summary_size_text(view.summary), SUMMARY_SHA_HEADING, view.summary.sha256])
    return lines


# 承認ダイアログの内容を、1 つの文（行を改行でつないだもの）にする。欄が欠けても例外にしない。
def approval_dialog_text(report: dict, hub_warning: str | None = None, extra_note: str | None = None) -> str:
    return "\n".join(approval_view_lines(approval_view(report, hub_warning, extra_note)))


# 上書き系のチェックをオンにするときの確認文（見出しと本文）を返す。
def dangerous_confirmation_text(help_data: dict, option: str) -> tuple[str, str]:
    info = help_data["options"][option]
    title = f"「{info['label']}」を有効にしますか?"  # 確認の見出し。
    body = str(info.get("caution") or "").strip() or str(info.get("summary") or "")  # 上書きの対象と影響。
    body += "\n\nこの指定は保存しません（このカードの次の 1 回の実行だけに効き、実行を始めるとオフに戻ります）。"
    return title, body


# ---------------------------------------------------------------------------
# ツールチップの本文
# ---------------------------------------------------------------------------


# 文字の表示幅を返す（全角は 2、それ以外は 1）。
def character_width(character: str) -> int:
    return 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1


# 行を分ける位置を、行末に近い句読点・空白の直後から選ぶ。英数字の並びの途中はなるべく避ける。
def choose_break(line: str, window: int = 12) -> int:
    lower = max(1, len(line) - window)  # これより前では分けない。
    for index in range(len(line) - 1, lower - 1, -1):
        if line[index] in BREAK_AFTER:
            return index + 1
    index = len(line)
    while index > lower and line[index - 1].isascii() and not line[index - 1].isspace():
        index -= 1
    if lower < index < len(line):
        return index
    return len(line)


# 本文に改行を入れて、1 行の表示幅を columns 程度に収める。既存の改行は残す。
def wrap_display_text(text: str, columns: int = TOOLTIP_COLUMNS) -> str:
    output: list[str] = []  # 折り返した行。
    for paragraph in str(text).split("\n"):
        line = ""  # 組み立て中の行。
        width = 0  # 組み立て中の行の表示幅。
        for character in paragraph:
            step = character_width(character)
            if width + step > columns and line and character not in NO_LINE_START:
                cut = choose_break(line)
                output.append(line[:cut].rstrip(" "))
                line = line[cut:].lstrip(" ")
                width = sum(character_width(item) for item in line)
            line += character
            width += step
        output.append(line)
    return "\n".join(output)


# Action の説明を、見出しと本文の組の並びで返す。空の項目は出さない。
def action_tooltip_sections(help_data: dict, action: str) -> list[tuple[str, str]]:
    info = help_data["actions"][action]
    sections = [("", str(info.get("summary") or "").strip())]  # 先頭は見出しなしの概要。
    for key, heading in ACTION_SECTIONS:
        sections.append((heading, str(info.get(key) or "").strip()))
    sections.append(("この画面では", GUI_ACTION_NOTES.get(action, "")))
    return [(heading, body) for heading, body in sections if body]


# オプションの説明を、見出しと本文の組の並びで返す。空の項目は出さない。
def option_tooltip_sections(help_data: dict, option: str, action: str | None = None) -> list[tuple[str, str]]:
    info = help_data["options"][option]
    sections = [("", str(info.get("summary") or "").strip())]  # 先頭は見出しなしの概要。
    for key, heading in OPTION_SECTIONS:
        sections.append((heading, str(info.get(key) or "").strip()))
    if action is not None:
        sections.append(("この画面では", GUI_OPTION_NOTES.get((action, option), "")))
    return [(heading, body) for heading, body in sections if body]


# 見出しと本文の組を、改行を入れた表示用の文に整える（markup ではない）。
def tooltip_plain_text(sections: list[tuple[str, str]], columns: int = TOOLTIP_COLUMNS) -> str:
    blocks = [wrap_display_text(f"【{heading}】{body}" if heading else body, columns) for heading, body in sections]  # 項目ごとの文。
    if not blocks:
        return ""
    if sections[0][0] == "" and len(blocks) > 1:
        return blocks[0] + "\n\n" + "\n".join(blocks[1:])
    return "\n".join(blocks)


# 見出しと本文の組から、GTK のツールチップ用 markup を作る。escape には GLib.markup_escape_text を渡す。
def tooltip_markup(sections: list[tuple[str, str]], escape: Callable[[str], str], columns: int = TOOLTIP_COLUMNS) -> str:
    blocks: list[str] = []  # 項目ごとの markup。
    for heading, body in sections:
        if heading:
            prefix = f"【{heading}】"  # 太字にする見出し。
            wrapped = wrap_display_text(prefix + body, columns)
            blocks.append("<b>" + escape(prefix) + "</b>" + escape(wrapped[len(prefix):]))
        else:
            blocks.append(escape(wrap_display_text(body, columns)))
    if not blocks:
        return ""
    if sections[0][0] == "" and len(blocks) > 1:
        return blocks[0] + "\n\n" + "\n".join(blocks[1:])
    return "\n".join(blocks)


# 確認の 5 段階の見出しと説明を、説明データの effect・next を根拠に組み立てる。
def stage_definitions(help_data: dict) -> list[tuple[str, str]]:
    actions = help_data["actions"]

    # Action の項目の文を返す（無ければ空）。
    def field_text(action: str, key: str) -> str:
        return str(actions.get(action, {}).get(key) or "").strip()

    # Action の表示名を返す。
    def label(action: str) -> str:
        return str(actions.get(action, {}).get("label") or action)

    return [
        ("足場の作成", f"設定ファイル（{CONFIG_NAME}）と文書 2 つを作る段階です。「{label('hub-add')}」と「{label('init')}」で作られます。\n【{label('init')}】{field_text('init', 'effect')}"),
        ("自己試験", f"「{label('test')}」で確かめます。「{label('init')}」と「{label('hub-add')}」の途中でも実行されます。\n【{label('test')}】{field_text('test', 'effect')}\n【注意】{field_text('test', 'caution')}"),
        ("Tunnel Client の稼働", f"「{label('hub-status')}」（従来方式は「{label('status')}」）で確かめます。\n【{label('hub-status')}】{field_text('hub-status', 'effect')}\n【注意】{field_text('hub-status', 'caution')}"),
        ("ChatGPT のツール検出", f"この画面からは確かめられません。ChatGPT 側で確かめます。\n【次にすること】{field_text('hub-status', 'next')}"),
        ("実際のツール呼び出し", f"この画面からは確かめられません。ChatGPT 側で確かめます。\n【次にすること】{field_text('hub-status', 'next')}"),
    ]


# ファイル選択の種類を返す（folder: フォルダーを選ぶ、save: 保存先を指定する、open: 既存のファイルを選ぶ）。
def chooser_mode(action: str, option: str) -> str:
    if option == "project-root":
        return "folder"
    if option == "output-path":
        return "save" if action == "export-skill" else "folder"
    return "open"


# ---------------------------------------------------------------------------
# 端末窓（Runtime API Key の入力はこの画面を通さない）
# ---------------------------------------------------------------------------


# PATH から、空の要素と相対パスの要素を除いた検索経路を返す（カレントディレクトリにある同名の実行ファイルを拾わない）。
def absolute_search_path(environment: Mapping[str, str]) -> str:
    return os.pathsep.join(part for part in str(environment.get("PATH") or "").split(os.pathsep) if part and os.path.isabs(part))


# 端末を決めた順に探し、(名前, 絶対パス) を返す。見つからなければ None。
# which を省くと、PATH の絶対パスの要素だけから探す。絶対パスでない結果は使わない。
# x-terminal-emulator は、実体（realpath）の名前が既知の端末のときだけ使う（それ以外は次の候補へ。無ければコピー用の案内に回る）。
def find_terminal(which: Callable[[str], str | None] | None = None, environment: Mapping[str, str] | None = None) -> tuple[str, str] | None:
    search_path = absolute_search_path(os.environ if environment is None else environment)  # 端末を探す経路。
    lookup = which or (lambda name: shutil.which(name, path=search_path))  # 名前から実行ファイルを探す関数。
    for name, _arguments in TERMINAL_CANDIDATES:
        path = lookup(name)
        if not path or not os.path.isabs(path):
            continue
        if name == "x-terminal-emulator" and os.path.basename(os.path.realpath(path)) not in KNOWN_TERMINAL_TARGETS:
            continue
        return name, path
    return None


# 端末で、後ろに続く引数配列をそのまま実行するコマンド（配列）を組む。
def terminal_command(name: str, path: str, inner: list[str]) -> list[str]:
    prefix = dict(TERMINAL_CANDIDATES)[name]  # その端末の「コマンドを実行する」引数。
    return [path, *prefix, *inner]


# 端末窓の中で動かすヘルパー（このファイル自身）の引数配列を組む。CLI の先頭（python・-u・CLI のパス）はヘルパーが付け直す。
def helper_arguments(cli_arguments: list[str]) -> list[str]:
    if list(cli_arguments[:3]) != cli_prefix() or len(cli_arguments) < 4:
        raise ValueError("端末窓で実行できるのは、この画面が組んだ CLI の引数配列だけです。")
    return [sys.executable, "-u", str(GUI_PATH), "--terminal-helper", "--", *cli_arguments[3:]]


# 端末が見つからないときの案内文（コピーして使うコマンドを含む）。
def terminal_missing_message(cli_arguments: list[str]) -> str:
    names = ", ".join(name for name, _arguments in TERMINAL_CANDIDATES)  # 探した端末。
    return (
        f"Runtime API Key を入力するための端末が見つかりませんでした（探した端末: {names}）。\n"
        "端末を開いて貼り付けて実行してください。キーはその端末に入力します（この画面には入力しません）。\n\n"
        + display_command(cli_arguments)
    )


# 端末窓の中で、終了の表示のあと Enter を待つ。先に入っていた入力（貼り付けたキーの残りなど）を捨て、待ち受けの間は入力を表示しない。
# 標準入力が端末でなければ（試験など）、捨てずに 1 行読むだけにする。
def wait_for_enter() -> None:
    descriptor = None  # 標準入力の番号。
    saved = None  # 元の端末の設定（戻すため）。
    try:
        descriptor = sys.stdin.fileno()
        termios.tcflush(descriptor, termios.TCIFLUSH)
        saved = termios.tcgetattr(descriptor)
        quiet = list(saved)  # 入力を表示しない設定。
        quiet[3] = quiet[3] & ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(descriptor, termios.TCSANOW, quiet)
    except (termios.error, OSError, ValueError, AttributeError):
        saved = None
    try:
        sys.stdin.readline()
    except (EOFError, KeyboardInterrupt, OSError, ValueError, AttributeError):
        pass
    finally:
        if saved is not None:
            try:
                termios.tcsetattr(descriptor, termios.TCSANOW, saved)
            except (termios.error, OSError):
                pass
            print("", flush=True)


# 端末窓のヘルパーが受け取った引数を確かめ、問題があれば理由を返す（無ければ None）。
# Action はキーを入力する操作だけ。オプションはその Action の options と exposure-sha256・no-start だけで、形は --name か --name=値 だけを許す。
# --action・-Action・省略形・未知のオプション・先頭が - の位置引数（値）・同じオプションの重複は拒否する。
def helper_argument_problem(help_data: dict, arguments: list[str]) -> str | None:
    action = arguments[0] if arguments else ""  # 実行する Action。
    info = help_data["actions"].get(action)
    if not isinstance(info, dict) or "key" not in info.get("interactive", []):
        allowed_actions = " / ".join(name for name, value in help_data["actions"].items() if "key" in value.get("interactive", []))  # 許可する Action。
        return f"端末窓のヘルパーは、Runtime API Key を入力する操作（{allowed_actions}）だけを実行します: {quote_for_display(action) if action else '（なし）'}"
    platforms = platform_only(help_data, action)  # OS 専用のオプション。
    allowed = {name for name in [*info["options"], *HELPER_EXTRA_OPTIONS] if platforms.get(name, PLATFORM) == PLATFORM and name in help_data["options"]}  # 受け付けるオプション。
    seen: set[str] = set()  # 出てきたオプション。
    index = 1  # 読んでいる位置。
    while index < len(arguments):
        token = arguments[index]
        if not token.startswith("--") or token == "--":
            return f"オプションの形（--name または --name=値）ではない引数は受け付けません: {quote_for_display(token)}"
        name, has_value, value = token[2:].partition("=")
        if name not in allowed:
            return f"この操作では使えないオプションです: {quote_for_display('--' + name)}"
        if name in seen:
            return f"同じオプションが 2 回あります: {quote_for_display('--' + name)}"
        seen.add(name)
        if option_kind(help_data, name) == "flag":
            if has_value:
                return f"フラグには値を付けられません: {quote_for_display(token)}"
            index += 1
            continue
        if not has_value:
            if index + 1 >= len(arguments):
                return f"値がありません: {quote_for_display(token)}"
            value = arguments[index + 1]
            if value.startswith("-"):
                return f"値が - で始まるときは --{name}=値 の形にしてください: {quote_for_display(value)}"
            index += 1
        if name == "exposure-sha256" and not SHA256_PATTERN.fullmatch(value):
            return "公開範囲の指紋の形式が不正です。"
        index += 1
    return None


# 端末窓の中で CLI を実行し、終了コードを表示して Enter を待つ。画面の部品（PyGObject）は読み込まない。
def run_terminal_helper(arguments: list[str]) -> int:
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    try:
        help_data = load_help_data()
    except HelpDataError as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        wait_for_enter()
        return 2
    problem = helper_argument_problem(help_data, arguments)  # 受け付けない引数の理由。
    if problem is not None:
        print(f"ERROR: {problem}", file=sys.stderr, flush=True)
        print("Enter キーで閉じます", flush=True)
        wait_for_enter()
        return 2
    command = [*cli_prefix(), *arguments]  # 実行する CLI の引数配列。
    print(f"実行するコマンド: {display_command(command)}", flush=True)
    print("キー（Runtime API Key）を求められたら、この窓に貼り付けて Enter を押してください（入力内容は表示されません）。", flush=True)
    print("", flush=True)
    try:
        code = subprocess.run(command, check=False, cwd=working_directory(os.environ)).returncode
    except KeyboardInterrupt:
        code = 130
    except OSError as error:
        print(f"ERROR: CLI を起動できませんでした: {error}", file=sys.stderr, flush=True)
        code = 1
    print("", flush=True)
    print(f"終了コード {code}。Enter キーで閉じます", flush=True)
    wait_for_enter()
    return code


# ---------------------------------------------------------------------------
# hub.json の読み取り（書き込まない・ディレクトリも作らない）
# ---------------------------------------------------------------------------


# 先頭の ~ を、渡された環境の HOME で展開する。
def expand_home(text: str, environment: Mapping[str, str]) -> str:
    if text == "~" or text.startswith("~/"):
        home = environment.get("HOME") or os.path.expanduser("~")  # 利用者のホーム。
        return home + text[1:]
    return text


# hub.json の場所を、CLI と同じ規則（XDG_CONFIG_HOME、無ければ ~/.config）で返す。絶対パスでなければ ValueError。
def hub_file_path(environment: Mapping[str, str]) -> Path:
    base = Path(expand_home(environment.get("XDG_CONFIG_HOME", "~/.config"), environment))  # 設定の置き場所。
    if not base.is_absolute():
        raise ValueError(f"XDG_CONFIG_HOME は絶対パスで指定してください: {base}")
    return base / HUB_DIRECTORY_NAME / HUB_FILE_NAME


# CLI が承認ファイルを置く場所（hub.json と同じ規則の XDG_CONFIG_HOME の下の approvals）を返す。絶対パスでなければ ValueError。
def approval_directory(environment: Mapping[str, str]) -> Path:
    return hub_file_path(environment).parent / "approvals"


# 承認ファイルのパスを確かめ、(プロファイル名, 確かめられない理由) を返す。CLI が置く所定の場所の <プロファイル名>.json と
# 文字列として完全に一致するときだけプロファイル名を返す（それ以外は承認状態を確かめられないので、承認済みとして扱わない）。
def check_approval_file(approval_file: str, environment: Mapping[str, str]) -> tuple[str | None, str | None]:
    if not approval_file.endswith(".json"):
        return None, "承認ファイルの名前が .json で終わっていません。"
    profile = Path(approval_file).stem  # 承認ファイル名から .json を外したもの。
    if not PROFILE_PATTERN.fullmatch(profile):
        return None, "承認ファイルの名前がプロファイル名の形式ではありません。"
    try:
        expected = str(approval_directory(environment) / f"{profile}.json")  # 所定の場所。
    except ValueError as error:
        return None, str(error)
    if approval_file != expected:
        return None, f"承認ファイルが所定の場所 {quote_for_display(expected)} ではありません（{quote_for_display(approval_file)}）。"
    return profile, None


# hub.json を、シンボリックリンク・FIFO などの通常でないファイル・他人のファイル・大きすぎるファイルを避けて読む。
# 読まないときは ValueError（理由）。FIFO でも固まらないよう O_NONBLOCK で開き、中身は上限まで読む。
# PID ファイルと /proc/<PID>/cmdline も、同じ守り方で読む（label は、理由の文に出すファイルの呼び名）。
def read_hub_file_bytes(path: Path, limit: int = HUB_FILE_LIMIT_BYTES, label: str = HUB_FILE_NAME) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        raise
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError(f"{label} がシンボリックリンクのため読みません。") from error
        raise ValueError(f"{label} を開けません: {error.strerror or error}") from error
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise ValueError(f"{label} が通常のファイルではないため読みません（FIFO・デバイスなど）。")
        if details.st_uid != os.getuid():
            raise ValueError(f"{label} の所有者が現在の利用者ではないため読みません。")
        if details.st_size > limit:
            raise ValueError(f"{label} が大きすぎるため読みません（{details.st_size} バイト。上限 {limit} バイト）。")
        chunks: list[bytes] = []  # 読んだ中身。
        total = 0  # 読んだバイト数。
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > limit:
                raise ValueError(f"{label} が大きすぎるため読みません（上限 {limit} バイト）。")
            chunks.append(chunk)
    finally:
        os.close(descriptor)


# 値が文字列で、形式（正規表現の全体）に合うときだけ返す。それ以外は None。
def matched_text(value: object, pattern: re.Pattern) -> str | None:
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


# hub.json を読み取り、登録プロジェクトと、形式に合う Tunnel ID・プロファイル名を返す。ファイルが無くても作らない。
# 読めなければ error に理由を入れる（例外は投げない）。
def read_hub_projects(environment: Mapping[str, str]) -> HubListing:
    try:
        path = hub_file_path(environment)
    except ValueError as error:
        return HubListing("", False, (), str(error))
    if not os.path.lexists(path):
        return HubListing(str(path), False, (), None)
    try:
        data = json.loads(read_hub_file_bytes(path).decode("utf-8"))
    except FileNotFoundError:
        return HubListing(str(path), False, (), None)
    except (OSError, UnicodeDecodeError) as error:
        return HubListing(str(path), True, (), f"hub.json を読めません: {error}")
    except ValueError as error:
        return HubListing(str(path), True, (), str(error) if str(error).startswith("hub.json") else f"hub.json を読めません: {error}")
    except RecursionError:
        return HubListing(str(path), True, (), "hub.json の入れ子が深すぎるため読みません。")
    except MemoryError:
        return HubListing(str(path), True, (), "hub.json が大きすぎるため読みません。")
    if not isinstance(data, dict) or not isinstance(data.get("projects"), list):
        return HubListing(str(path), True, (), "hub.json の形式が不正です。")
    projects = []  # 登録プロジェクト。
    for item in data["projects"]:
        if not isinstance(item, dict):
            continue
        approval_file = item.get("approvalFile") if isinstance(item.get("approvalFile"), str) else ""  # 承認ファイルのパス。
        profile, problem = check_approval_file(approval_file, environment)
        projects.append(HubProject(str(item.get("name") or ""), str(item.get("root") or ""), approval_file, profile, problem))
    return HubListing(str(path), True, tuple(projects), None, tunnel_id=matched_text(data.get("tunnelId"), TUNNEL_PATTERN), profile_name=matched_text(data.get("profileName"), PROFILE_PATTERN))


# プロジェクトのフォルダーに足場（設定ファイル）があるかを返す。シンボリックリンクも「ある」とみなす（扱いは CLI に任せる）。
def scaffold_exists(project_root: str, environment: Mapping[str, str]) -> bool:
    return os.path.lexists(os.path.join(expand_home(project_root, environment), CONFIG_NAME))


# ---------------------------------------------------------------------------
# 権限の確認・切り替え（2.8.0。純粋関数）
# ---------------------------------------------------------------------------


HUB_PERMISSION_ENTRY_FIELDS = {
    "name": (str,), "root": (str,), "profile": (str,), "approvalState": (str,),
    "sourceRead": (str, type(None)), "claudeCode": (str, type(None)), "allowedCommandCount": (int,), "error": (str, type(None)),
}  # hub-permissions の projects の 1 件に必須の欄と型。
HUB_PERMISSION_APPROVAL_STATES = ("approved", "changed", "unapproved", "unavailable")  # approvalState が取る値。
HUB_PERMISSION_SOURCE_STATES = ("on", "off", "partial")  # sourceRead が取る値（null は確認できなかったことを示す）。
HUB_PERMISSION_CLAUDE_STATES = ("on", "off", "unset")  # claudeCode が取る値（null は確認できなかったことを示す）。


# hub-permissions の標準出力を解釈する。読めない・欄が欠ける・形が違うときは (None, 理由) を返し、例外は投げない。parse_exposure_report と同じ流儀。
def parse_hub_permissions_report(text: object) -> tuple[list[dict] | None, str | None]:
    try:
        report = json.loads(text if isinstance(text, str) else "")
    except (ValueError, TypeError) as error:
        return None, f"JSON として読めません: {error}"
    except RecursionError:
        return None, "JSON の入れ子が深すぎるため読めません。"
    except MemoryError:
        return None, "JSON が大きすぎるため読めません。"
    if not isinstance(report, dict):
        return None, "JSON の最上位が object ではありません。"
    if report.get("schemaVersion") != 1:
        return None, f"未対応の schemaVersion です: {report.get('schemaVersion')}"
    projects = report.get("projects")  # 登録プロジェクトごとの権限の結果。
    if not isinstance(projects, list):
        return None, "欄 projects が配列ではありません。"
    for item in projects:
        if not isinstance(item, dict):
            return None, "projects の要素が object ではありません。"
        for name, types in HUB_PERMISSION_ENTRY_FIELDS.items():
            if name not in item:
                return None, f"projects の要素に欄 {name} がありません。"
            value = item[name]
            if isinstance(value, bool) or not isinstance(value, types):
                return None, f"projects の要素の欄 {name} の型が不正です。"
        if item["approvalState"] not in HUB_PERMISSION_APPROVAL_STATES:
            return None, f"未対応の承認状態です: {item['approvalState']}"
        if item["sourceRead"] is not None and item["sourceRead"] not in HUB_PERMISSION_SOURCE_STATES:
            return None, f"未対応のソースの読み取りの状態です: {item['sourceRead']}"
        if item["claudeCode"] is not None and item["claudeCode"] not in HUB_PERMISSION_CLAUDE_STATES:
            return None, f"未対応の Claude Code の状態です: {item['claudeCode']}"
    return projects, None


# set-permission（指紋なし）の確認結果が、渡したプロジェクトのフォルダー・プロファイルと一致するかを返す（末尾の / の違いは無視する）。
def exposure_report_matches(report: dict, project_root: str, profile: str) -> bool:
    return report.get("profile") == profile and str(report.get("projectRoot") or "").rstrip("/") == str(project_root).rstrip("/")


# 権限の値（on なら反対にする。それ以外（off・partial・unset・未確認）はすべて on にする）から、切り替え先の値を返す。
def toggled_permission_value(current: str | None) -> str:
    return "off" if current == "on" else "on"


# hub-permissions の 1 件の結果から、一覧に出す 3 列（ソースの読み取り・Claude Code・承認）の文を返す。
# 未確認（entry が None）なら 3 つとも「（未確認）」。error があれば 3 つとも、その理由にする（この画面からは切り替えない）。
def permission_display_texts(entry: dict | None) -> tuple[str, str, str]:
    if entry is None:
        return PERMISSION_UNKNOWN_TEXT, PERMISSION_UNKNOWN_TEXT, PERMISSION_UNKNOWN_TEXT
    if entry.get("error"):
        reason = f"確認できません（{escape_for_display(str(entry['error']))}）"
        return reason, reason, reason
    source = PERMISSION_SOURCE_LABELS.get(entry.get("sourceRead"), PERMISSION_UNKNOWN_TEXT)
    count = entry.get("allowedCommandCount") or 0  # 確認なしで実行できるコマンドの件数。
    claude_value = entry.get("claudeCode")  # Claude Code の起動の状態。
    claude = (f"On（コマンド {count} 件）" if count else "On") if claude_value == "on" else PERMISSION_CLAUDE_LABELS.get(claude_value, PERMISSION_UNKNOWN_TEXT)
    approval = PERMISSION_APPROVAL_LABELS.get(entry.get("approvalState"), PERMISSION_UNKNOWN_TEXT)
    return source, claude, approval


# ---------------------------------------------------------------------------
# ハブの稼働の判定と、分かっている値の探索（読み取りだけ。子プロセスを起動しない・通信しない・書き込まない）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HubState:
    """ハブ（Tunnel Client）の稼働表示の内容（GTK に依存しない）。"""

    kind: str  # 状態の種類（running・stopped・unset・unknown のどれか）。
    text: str  # 状態の表示（「ハブ: ● 実行中（PID 1234）」など）。
    detail: str  # 詳細の表示（Tunnel ID・プロファイル名・登録の件数、または理由）。
    pid: int | None = None  # 実行中のときの Tunnel Client の PID（それ以外は None）。


# Tunnel Client が PID ファイルを書く場所を、CLI と同じ規則（XDG_STATE_HOME、無ければ ~/.local/state）で返す。絶対パスでなければ ValueError。
def state_directory(environment: Mapping[str, str]) -> Path:
    base = Path(expand_home(environment.get("XDG_STATE_HOME", "~/.local/state"), environment))  # 状態の置き場所。
    if not base.is_absolute():
        raise ValueError(f"XDG_STATE_HOME は絶対パスで指定してください: {base}")
    return base / STATE_DIRECTORY_NAME


# PID ファイルの中身を PID にする。半角の数字だけ（前後の空白と改行は除く）で、1 以上 PID_LIMIT 以下のときだけ返す。それ以外は None。
def parse_pid_text(text: str) -> int | None:
    stripped = str(text).strip()  # 前後の空白と改行を除いた中身。
    if not PID_TEXT_PATTERN.fullmatch(stripped):
        return None
    pid = int(stripped)
    return pid if 0 < pid <= PID_LIMIT else None


# プロファイルの PID ファイル（Tunnel Client が書く <プロファイル名>.pid）を読み、PID を返す。
# 無い・読まない（シンボリックリンク・FIFO・他人のファイル・大きすぎる）・数字だけでないときは None（例外は投げない）。
def read_pid_file(profile: str, environment: Mapping[str, str]) -> int | None:
    if not PROFILE_PATTERN.fullmatch(str(profile)):
        return None
    try:
        path = state_directory(environment) / f"{profile}.pid"  # Tunnel Client が書く PID ファイル。
        return parse_pid_text(read_hub_file_bytes(path, PID_FILE_LIMIT_BYTES, "PID ファイル").decode("ascii"))
    except (OSError, ValueError):
        return None


# プロセスのコマンドライン（/proc/<PID>/cmdline の、NUL で区切ったバイト列）を、空でない引数の並びにする。
def split_command_line(raw: bytes) -> list[str]:
    return [item.decode("utf-8", errors="replace") for item in raw.split(b"\x00") if item]


# 引数の並びが、そのプロファイルの Tunnel Client のものかを返す（CLI の matching_process と同じ意味）。
# 先頭の引数のファイル名が tunnel-client で、--profile のすぐ次の引数がプロファイル名のときだけ True。実体（exe）の一致までは確かめない。
def is_tunnel_client_command(arguments: list[str], profile: str) -> bool:
    if not arguments or os.path.basename(arguments[0]) != TUNNEL_CLIENT_NAME:
        return False
    return any(name == "--profile" and value == profile for name, value in zip(arguments, arguments[1:]))


# PID のプロセスが、そのプロファイルの Tunnel Client かを <process_directory>/<PID>/cmdline で確かめる。
# プロセスが無い・読まない（他人のプロセスなど）ときは False（例外は投げない）。
def matching_tunnel_process(pid: int, profile: str, process_directory: str = PROCESS_DIRECTORY) -> bool:
    try:
        raw = read_hub_file_bytes(Path(process_directory) / str(int(pid)) / "cmdline", COMMAND_LINE_LIMIT_BYTES, "cmdline")  # NUL 区切りのコマンドライン。
    except (OSError, ValueError, TypeError):
        return False
    return is_tunnel_client_command(split_command_line(raw), profile)


# ハブの Tunnel Client の PID を返す（PID ファイルの PID のプロセスが、そのプロファイルの Tunnel Client のときだけ）。動いていなければ None。
def running_hub_pid(profile: str, environment: Mapping[str, str], process_directory: str = PROCESS_DIRECTORY) -> int | None:
    pid = read_pid_file(profile, environment)
    return pid if pid is not None and matching_tunnel_process(pid, profile, process_directory) else None


# hub.json の読み取り結果・PID ファイル・/proc から、ハブの稼働表示の内容を作る。hub.json 由来の値は見える形にして出す。
def hub_state(listing: HubListing, environment: Mapping[str, str], process_directory: str = PROCESS_DIRECTORY) -> HubState:
    if listing.error:
        return HubState("unknown", HUB_STATE_UNKNOWN, escape_for_display(listing.error))
    if not listing.exists or listing.tunnel_id is None:
        return HubState("unset", HUB_STATE_UNSET, HUB_DETAIL_UNSET)
    if listing.profile_name is None:
        return HubState("unknown", HUB_STATE_UNKNOWN, HUB_DETAIL_NO_PROFILE)
    detail = HUB_DETAIL_TEMPLATE.format(tunnel=escape_for_display(listing.tunnel_id), profile=escape_for_display(listing.profile_name), count=len(listing.projects))  # 実行中・停止中に共通の詳細。
    pid = running_hub_pid(listing.profile_name, environment, process_directory)
    if pid is None:
        return HubState("stopped", HUB_STATE_STOPPED, detail + HUB_DETAIL_STOPPED_SUFFIX)
    return HubState("running", HUB_STATE_RUNNING.format(pid=pid), detail, pid)


# Tunnel Client の実行ファイルを、CLI の find_tunnel_client と同じ順（PATH、~/.local/bin、~/bin）で探し、絶対パスを返す。見つからなければ None。
# PATH は渡された環境のものを使い、空の要素と相対パスの要素は除く（端末の探索と同じ。カレントディレクトリにある同名の実行ファイルを拾わない）。
def find_tunnel_client(environment: Mapping[str, str]) -> str | None:
    discovered = shutil.which(TUNNEL_CLIENT_NAME, path=absolute_search_path(environment))  # PATH で見つかった場所。
    if discovered and os.path.isabs(discovered):
        return os.path.abspath(discovered)
    for candidate in TUNNEL_CLIENT_CANDIDATES:
        expanded = expand_home(candidate, environment)  # ~ を HOME に展開した候補。
        if os.path.isabs(expanded) and os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return os.path.abspath(expanded)
    return None


# 入力欄の中身の鍵を返す。ふつうはオプション名（同じオプションは全カードで共有する）。共有から外す欄（hub-add の Tunnel ID）だけ専用の鍵にする。
def buffer_key(action: str | None, option: str) -> str:
    return SEPARATE_BUFFERS.get((action, option), option)


# 自動で入れる値を、入力欄の中身の鍵から値への対応で返す（hub-add の Tunnel ID と、Tunnel Client の場所の 2 つだけ）。
# 分からないものと、表示を偽装できる文字（共通仕様 S1 の禁止文字）を含むものは入れない。
def known_values(listing: HubListing, environment: Mapping[str, str]) -> dict[str, str]:
    candidates = {HUB_TUNNEL_BUFFER: listing.tunnel_id, TUNNEL_CLIENT_OPTION: find_tunnel_client(environment)}  # 候補（分からなければ None）。
    return {key: value for key, value in candidates.items() if value and not has_forbidden_character(value)}


# 自動で入れてよい欄かを返す。空（空白だけを含む）か、前回この画面が入れた値のままのときだけ True（利用者が入力した値は書き換えない）。
def autofill_allowed(current: str, previous: str | None) -> bool:
    return is_blank(current) or (previous is not None and current == previous)


# ---------------------------------------------------------------------------
# 子プロセス（GTK に依存しない。メインループへの受け渡しは schedule で差し替える）
# ---------------------------------------------------------------------------


class ChildProcess:
    """CLI の子プロセス 1 つ。出力を 1 行ずつ、終了を 1 回だけ、schedule 経由で受け取り先へ渡す。"""

    # 引数配列・環境・受け取り先を覚える。起動は start() で行う。
    def __init__(self, arguments: list[str], environment: Mapping[str, str], on_line: Callable[[str], None], on_exit: Callable[[int | None, str], None], capture_stdout: bool = False, schedule: Callable[..., None] | None = None):
        self.arguments = [str(item) for item in arguments]  # 実行する引数配列。
        self.environment = dict(environment)  # 子プロセスの環境。
        self.on_line = on_line  # 1 行ごとの受け取り先。
        self.on_exit = on_exit  # 終了の受け取り先（終了コード, まとめて読んだ標準出力）。
        self.capture_stdout = capture_stdout  # 標準出力を行ごとに流さず、まとめて返すか。
        self.schedule = schedule or (lambda function, *values: function(*values))  # 受け取り先の呼び出し方。
        self.process: subprocess.Popen | None = None  # 起動したプロセス。

    # 子プロセスを新しいプロセスグループで起動し、読み取りスレッドを始める。標準入力は渡さず、作業ディレクトリは HOME にする。
    def start(self) -> None:
        self.process = subprocess.Popen(
            self.arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if self.capture_stdout else subprocess.STDOUT,
            env=self.environment,
            cwd=working_directory(self.environment),
            start_new_session=True,
        )
        threading.Thread(target=self.read_output, daemon=True).start()

    # ストリームを 1 行ずつ文字列にして渡す。1 行は最大 LOG_READ_BYTES バイトまで読み、超えた分は改行まで読み捨てる（印はログ欄で付ける）。
    def forward_lines(self, stream) -> None:
        skipping = False  # 長すぎる行の残りを読み捨てている最中か。
        while True:
            raw = stream.readline(LOG_READ_BYTES)
            if not raw:
                break
            complete = raw.endswith(b"\n")  # 行の終わりまで読めたか。
            if skipping:
                skipping = not complete
                continue
            skipping = not complete and len(raw) >= LOG_READ_BYTES
            self.schedule(self.on_line, raw.decode("utf-8", errors="replace").rstrip("\r\n"))
        stream.close()

    # 標準出力をまとめて読む。CAPTURE_LIMIT_BYTES を超えたら読むのをやめ、プロセスグループを止めて None を返す。
    def read_captured(self) -> str | None:
        stream = self.process.stdout  # 子プロセスの標準出力。
        chunks: list[bytes] = []  # 読んだ中身。
        total = 0  # 読んだバイト数。
        while True:
            chunk = stream.read(65536)
            if not chunk:
                stream.close()
                return b"".join(chunks).decode("utf-8", errors="replace")
            total += len(chunk)
            if total > CAPTURE_LIMIT_BYTES:
                break
            chunks.append(chunk)
        self.schedule(self.on_line, f"ERROR: 標準出力が上限（{CAPTURE_LIMIT_BYTES} バイト）を超えたため、読み取りを中止しました（失敗として扱います）。")
        stream.close()  # 子のそれ以降の書き込みは失敗する（読み手がいない）。
        self.terminate(signal.SIGTERM)
        timer = threading.Timer(5.0, self.terminate, args=(signal.SIGKILL,))  # SIGTERM で終わらないときの SIGKILL。
        timer.daemon = True
        timer.start()
        return None

    # 出力を読み終えるまで渡し、最後に終了コードを渡す。capture_stdout のときは標準出力をまとめて返す（上限を超えたら空で、失敗の終了コード）。
    def read_output(self) -> None:
        captured = ""  # まとめて読んだ標準出力。
        overflow = False  # まとめて読む標準出力が上限を超えたか。
        if self.capture_stdout:
            error_thread = threading.Thread(target=self.forward_lines, args=(self.process.stderr,), daemon=True)  # 標準エラーを流すスレッド。
            error_thread.start()
            result = self.read_captured()  # まとめて読んだ標準出力（上限を超えたら None）。
            overflow = result is None
            captured = result or ""
            error_thread.join()
        else:
            self.forward_lines(self.process.stdout)
        code = self.process.wait()
        if overflow and code == 0:
            code = 1
        self.schedule(self.on_exit, code, captured)

    # プロセスグループに、まだ誰か残っているかを返す（CLI が終わっていても、Tunnel Client などの孫が残っていれば True）。
    # 終わったリーダーは先に回収し、ゾンビを生存と数えない。
    def running(self) -> bool:
        if self.process is None:
            return False
        self.process.poll()
        try:
            os.killpg(self.process.pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    # プロセスグループに残っている全員へシグナルを送り、送ったかを返す（Tunnel Client など孫プロセスも含む）。
    # グループが空なら送らない（PID が再利用されたときに、別のプロセスへ送らないため）。
    def terminate(self, signal_number: int = signal.SIGTERM) -> bool:
        if not self.running():
            return False
        try:
            os.killpg(self.process.pid, signal_number)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    # プロセスグループが空になるまで最大 timeout 秒待ち、空になったかを返す。
    def wait(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)  # 待つ期限。
        while self.running():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
        return True


# 子プロセスたちのプロセスグループへ SIGTERM を送り、最大 grace 秒待って、残っているグループへ SIGKILL を送る。
def stop_process_groups(children: list, grace: float = 5.0) -> None:
    for child in children:
        child.terminate(signal.SIGTERM)
    deadline = time.monotonic() + grace  # 待つ期限。
    for child in children:
        if not child.wait(max(0.0, deadline - time.monotonic())):
            child.terminate(signal.SIGKILL)


# ---------------------------------------------------------------------------
# 画面（GTK 3）。ここから下は import_gtk() の後でだけ使う。
# ---------------------------------------------------------------------------


Gtk = None  # 画面を作るときに読み込む GTK 3。
Gdk = None  # クリップボードなどに使う GDK。
GLib = None  # メインループと markup のエスケープに使う GLib。
Pango = None  # ラベルの折り返し方に使う Pango。


# PyGObject（GTK 3）を読み込む。このファイルの import だけでは呼ばれない。
def import_gtk() -> None:
    global Gtk, Gdk, GLib, Pango
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("Pango", "1.0")
    from gi.repository import Gdk as gdk_module
    from gi.repository import GLib as glib_module
    from gi.repository import Gtk as gtk_module
    from gi.repository import Pango as pango_module

    Gtk, Gdk, GLib, Pango = gtk_module, gdk_module, glib_module, pango_module


# 終了の合図（SIGINT・SIGTERM・SIGHUP・SIGQUIT）を受けたら、stop_children で子プロセスを止めてから quit_loop を呼ぶ。登録した合図を返す。
# SIGQUIT は GLib.unix_signal_add が扱えない（GLib 2.80 で、扱えるのは SIGHUP・SIGINT・SIGTERM・SIGUSR1・SIGUSR2・SIGWINCH だけ）ため、
# Python のシグナルハンドラーからメインループへ渡す（PyGObject はシグナルでメインループを起こす）。
def install_signal_handlers(stop_children: Callable[[], None], quit_loop: Callable[[], None]) -> list[int]:
    state = {"done": False}  # 終了の処理を済ませたか。

    # 子プロセスを止めて、メインループを終える（2 回目以降は何もしない）。
    def shutdown(*_values) -> bool:
        if not state["done"]:
            state["done"] = True
            try:
                stop_children()
            finally:
                quit_loop()
        return False

    numbers = [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]  # GLib で受ける合図。
    for number in numbers:
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, number, shutdown)
    signal.signal(signal.SIGQUIT, lambda _number, _frame: GLib.idle_add(shutdown))
    return [*numbers, signal.SIGQUIT]


# JSON などの文字列を markup 用にエスケープする。
def escape_markup(text: str) -> str:
    return GLib.markup_escape_text(str(text))


# 画面側で書いた説明文を、改行を入れてツールチップの markup にする。
def plain_tooltip(text: str) -> str:
    return escape_markup(wrap_display_text(text))


# ウィジェットにツールチップ（markup）を付ける。
def set_tooltip(widget, markup: str) -> None:
    widget.set_tooltip_markup(markup)


# 見出し用のラベル（太字・説明付き）を作る。
def heading_label(text: str, tooltip: str, name: str):
    label = Gtk.Label(xalign=0.0)
    label.set_markup("<b>" + escape_markup(text) + "</b>")
    label.set_name(name)
    set_tooltip(label, plain_tooltip(tooltip))
    return label


@dataclass
class CardWidgets:
    """1 枚のカード（Action）の部品。"""

    action: str  # Action 名（kebab-case）。
    frame: object  # カードの枠。
    run_button: object  # 実行ボタン。
    stop_button: object | None  # 停止ボタン（終わらない操作だけ）。
    checks: dict = field(default_factory=dict)  # オプション名から、このカードのチェックボックスへの対応。


@dataclass
class Job:
    """実行中の 1 つの操作（承認の確認などの複数の段階を含む）。"""

    action: str  # 操作の Action 名。
    values: dict  # 実行時の入力値。
    current: object | None = None  # いま動いている子プロセス。
    final_started: bool = False  # 終わらない最後の段階（起動）に入ったか。
    stop_requested: bool = False  # 停止ボタンが押されたか。
    stopper: object | None = None  # 停止のために動かしている hub-stop。
    prefix: str = ""  # ログの各行の先頭に付ける印（補助の操作だけ「[Action 名] 」）。


# 折り返すラベル（名前・説明付き）を作る。markup が真なら text を markup として扱う（呼び出し側でエスケープ済みのこと）。
def wrapped_label(text: str, name: str, tooltip: str, markup: bool = False):
    label = Gtk.Label(xalign=0.0, wrap=True)
    label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
    label.set_max_width_chars(100)
    if markup:
        label.set_markup(text)
    else:
        label.set_text(text)
    label.set_name(name)
    set_tooltip(label, plain_tooltip(tooltip))
    return label


# 赤い太字の markup を作る（警告と「公開」の強調に使う）。
def danger_markup(text: str) -> str:
    return f'<span foreground="{DANGER_COLOR}" weight="bold">{escape_markup(text)}</span>'


# 公開か非公開かの markup を作る。公開は太字・赤で強調する。
def public_markup(public: bool) -> str:
    return danger_markup(public_text(True)) if public else escape_markup(public_text(False))


class ApprovalPanel:
    """承認ダイアログの中身。上から、固定の見出し・スクロールする詳細・固定の要約・確認のチェック・ボタンの順に並べる。

    詳細を末尾まで表示するまで「内容を読みました」を選べず、それ（と、別のフォルダーの承認を上書きするときはその確認）を
    選ぶまで「この内容で承認」を押せない。禁止文字や形の崩れがあるときは、承認ボタンは常に押せない（キャンセルだけ）。
    """

    # 公開範囲の確認結果から、見出し・詳細・要約・チェックボックス・ボタンを作る。on_response には応答の種類を渡す。
    # extra_note は、呼び出し側が見出しの先頭に足す注記（2.8.0: 権限の切り替えで設定ファイルも書き換わることなど）。
    def __init__(self, report: dict, hub_warning: str | None, on_response: Callable[[object], None], extra_note: str | None = None):
        self.view_model = approval_view(report, hub_warning, extra_note)  # 表示する内容（GTK に依存しない純粋関数で作ったもの）。
        self.blocked = bool(self.view_model.blockers)  # 承認できない内容か。
        self.read_reached = False  # 詳細を末尾まで表示したか（一度表示したら戻さない）。
        self.read_check_pending = False  # 末尾の確認を予約済みか。
        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=10)
        self.box.pack_start(self.build_header(), False, False, 0)
        self.box.pack_start(self.build_details(), True, True, 0)
        self.box.pack_start(self.build_summary(), False, False, 0)
        read_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)  # 「内容を読みました」とその案内の行。
        self.check = Gtk.CheckButton(label="内容を読みました")
        self.check.set_name("approval-read")
        set_tooltip(self.check, plain_tooltip("詳細を末尾までスクロールすると選べます。選ぶまで「この内容で承認」は押せません。"))
        read_row.pack_start(self.check, False, False, 0)
        hint = "この内容は承認できません（「キャンセル」だけ押せます）。" if self.blocked else "（詳細を末尾までスクロールすると選べます）"  # チェックの横の案内。
        self.read_hint = wrapped_label(hint, "approval-read-hint", "「内容を読みました」を選べる条件です。")
        read_row.pack_start(self.read_hint, True, True, 0)
        self.box.pack_start(read_row, False, False, 0)
        self.override_check = None  # 別のフォルダーの承認の上書きを確かめるチェック（要るときだけ）。
        if self.view_model.override_warning is not None and not self.blocked:
            self.override_check = Gtk.CheckButton(label="別のフォルダーの承認を上書きしてよいことを理解しました")
            self.override_check.set_name("approval-override")
            set_tooltip(self.override_check, plain_tooltip("このプロファイル名で保存された別のフォルダーの承認が、この承認で置き換わります。理解したうえで承認するときだけ選びます。"))
            self.override_check.connect("toggled", self.update_controls)
            self.box.pack_start(self.override_check, False, False, 0)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8, halign=Gtk.Align.END)
        self.cancel_button = Gtk.Button(label="キャンセル")
        self.cancel_button.set_name("approval-cancel")
        set_tooltip(self.cancel_button, plain_tooltip("承認せずに閉じます。承認は保存せず、このプロジェクトは公開されません。"))
        self.approve_button = Gtk.Button(label="この内容で承認")
        self.approve_button.set_name("approval-accept")
        set_tooltip(self.approve_button, plain_tooltip("表示した指紋で承認します。CLI が現在の公開範囲と照合し、一致したときだけ承認を保存します（一致しなければ失敗します）。"))
        buttons.pack_start(self.cancel_button, False, False, 0)
        buttons.pack_start(self.approve_button, False, False, 0)
        self.box.pack_start(buttons, False, False, 0)
        self.check.connect("toggled", self.update_controls)
        self.cancel_button.connect("clicked", lambda _button: on_response(Gtk.ResponseType.CANCEL))
        # 押せない状態でのプログラムからの clicked でも承認しないよう、押されたときにもう一度確かめる。
        self.approve_button.connect("clicked", lambda _button: on_response(Gtk.ResponseType.ACCEPT) if self.approvable() else None)
        adjustment = self.scrolled.get_vadjustment()  # 詳細の縦スクロールの位置。
        adjustment.connect("changed", self.schedule_read_check)
        adjustment.connect("value-changed", self.schedule_read_check)
        self.details.connect("size-allocate", self.schedule_read_check)
        self.details.connect("map", self.schedule_read_check)
        self.update_controls()

    # 固定の見出し（スクロールしない）: 問い・承認状態・プロジェクトルート・プロファイル・ハブの警告・承認できない理由・上書きの警告。
    def build_header(self):
        header = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        header.pack_start(heading_label("次の公開範囲を ChatGPT へ公開することを承認しますか?", "公開範囲（ChatGPT から読める文書の範囲）と、その指紋（SHA-256）です。詳細を末尾まで読んでから承認します。", "approval-heading"), False, False, 0)
        if self.view_model.extra_note:
            note = wrapped_label(self.view_model.extra_note, "approval-extra-note", "この承認で変わる設定ファイルについての注記です。")
            header.pack_start(note, False, False, 0)
        state = wrapped_label("<b>" + escape_markup(self.view_model.state_text) + "</b>", "approval-state", "承認状態です（未承認、または前回の承認から変更あり）。", markup=True)
        header.pack_start(state, False, False, 0)
        header.pack_start(wrapped_label(self.view_model.root_text, "approval-root", "承認の対象のプロジェクトのフォルダーです。制御文字などは \\uXXXX の形で見えるようにしています。"), False, False, 0)
        header.pack_start(wrapped_label(self.view_model.profile_text, "approval-profile", "承認を保存する名前（プロファイル名）です。"), False, False, 0)
        if self.view_model.hub_warning:
            warning = wrapped_label("<b>" + escape_markup("警告: " + self.view_model.hub_warning) + "</b>", "approval-hub-warning", "ハブ方式の影響範囲です（「プロジェクトを追加」の注意書きから引用）。", markup=True)
            header.pack_start(warning, False, False, 0)
        if self.view_model.blockers:
            blocked = wrapped_label("\n".join(danger_markup(text) for text in self.view_model.blockers), "approval-blocked", "この内容は承認できません。設定ファイル（.chatgpt-project-bridge.json）を見直してから、もう一度確認してください。", markup=True)
            header.pack_start(blocked, False, False, 0)
        if self.view_model.override_warning and not self.blocked:
            override = wrapped_label(danger_markup(self.view_model.override_warning), "approval-override-warning", "同じプロファイル名の承認は 1 つだけ保存されます。承認すると、別のフォルダーの承認が置き換わります。", markup=True)
            header.pack_start(override, False, False, 0)
        return header

    # スクロールする詳細（差分と全項目。1 項目 1 行・番号付き）を作る。スクロールバーは常に表示する。
    def build_details(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.pack_start(heading_label("詳細（全項目。末尾までスクロールしてください）", "前回からの差分と、公開ファイル・公開ディレクトリ・拒否ディレクトリの全件です。値は二重引用符で囲み、制御文字などは \\uXXXX の形で見えるようにしています。", "approval-details-title"), False, False, 0)
        self.details = Gtk.TextView(editable=False, cursor_visible=False, monospace=True, wrap_mode=Gtk.WrapMode.WORD_CHAR)
        self.details.set_name("approval-details")
        set_tooltip(self.details, plain_tooltip("CLI（show-exposure）が返した公開範囲の全項目です。末尾までスクロールすると「内容を読みました」を選べます。「⚠ 混在した文字種」は、見た目の似た別の文字（ラテン文字とキリル文字など）が 1 つの名前に混ざっている印です。"))
        buffer = self.details.get_buffer()
        buffer.create_tag("heading", weight=700)
        buffer.create_tag("warning", foreground=DANGER_COLOR, weight=700)
        for index, line in enumerate(self.view_model.details):
            if index:
                buffer.insert(buffer.get_end_iter(), "\n")
            if line.heading:
                buffer.insert_with_tags_by_name(buffer.get_end_iter(), line.text, "heading")
            else:
                buffer.insert(buffer.get_end_iter(), line.text)
            if line.warning:
                buffer.insert_with_tags_by_name(buffer.get_end_iter(), "  " + line.warning, "warning")
        self.scrolled = Gtk.ScrolledWindow()
        self.scrolled.set_name("approval-details-scroll")
        self.scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.ALWAYS)  # 横に隠れる部分を作らず幅で折り返し、縦のスクロールバーは常に出す。
        self.scrolled.set_overlay_scrolling(False)
        self.scrolled.set_min_content_height(200)
        self.scrolled.set_min_content_width(680)
        self.scrolled.add(self.details)
        box.pack_start(self.scrolled, True, True, 0)
        return box

    # 固定の要約（スクロールしない。承認ボタンの近く）: 件数・Git の公開・文書の上限・指紋の全桁。構造化データから作る。
    def build_summary(self):
        summary = self.view_model.summary  # 要約の数値と真偽値。
        frame = Gtk.Frame()
        frame.set_name("approval-summary")
        frame.set_label_widget(heading_label("要約（承認の対象）", "公開範囲の件数・Git の公開・文書の上限・指紋です。件数は、公開範囲の配列の長さから数えています。", "approval-summary-title"))
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin=6)
        box.pack_start(wrapped_label(summary_count_text(summary), "approval-summary-counts", "公開範囲の各配列の件数です。詳細の番号の最後と一致します。"), False, False, 0)
        line = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=24)  # Git の公開と文書の上限の行。
        git_markup = f"Git のファイル名: {public_markup(summary.git_paths)} / Git のコミット件名: {public_markup(summary.git_subjects)}"  # 公開を強調した Git の行。
        line.pack_start(wrapped_label(git_markup, "approval-summary-git", "Git のファイル名やコミット件名を ChatGPT へ公開するかです。公開のときは赤で強調します。", markup=True), False, False, 0)
        line.pack_start(wrapped_label(summary_size_text(summary), "approval-summary-size", "ChatGPT が 1 回に読める文書の大きさの上限です。"), False, False, 0)
        box.pack_start(line, False, False, 0)
        box.pack_start(wrapped_label(SUMMARY_SHA_HEADING, "approval-summary-sha-title", "承認すると、この指紋を CLI へ渡します。CLI は現在の公開範囲と照合し、一致したときだけ承認を保存します。"), False, False, 0)
        self.sha_label = Gtk.Label(xalign=0.0, wrap=True, selectable=True)
        self.sha_label.set_line_wrap_mode(Pango.WrapMode.CHAR)  # 狭い幅でも、64 桁を折り返して全桁を見せる。
        self.sha_label.set_markup("<tt>" + escape_markup(summary.sha256) + "</tt>")
        self.sha_label.set_name("approval-sha")
        set_tooltip(self.sha_label, plain_tooltip("公開範囲の指紋（SHA-256。16 進 64 桁）です。文字を選んでコピーできます。"))
        box.pack_start(self.sha_label, False, False, 0)
        frame.add(box)
        return frame

    # 詳細の位置の確認を、レイアウトが落ち着いてから（低い優先度のアイドルで）1 回だけ行うよう予約する。
    def schedule_read_check(self, *_values) -> None:
        if self.read_reached or self.read_check_pending:
            return
        self.read_check_pending = True
        GLib.idle_add(self.check_read_position, priority=GLib.PRIORITY_LOW)

    # 詳細が末尾まで表示されているか（value + page_size >= upper - 1 で、最後の行が見えている）を確かめ、表示されていれば「内容を読みました」を選べるようにする。
    def check_read_position(self) -> bool:
        self.read_check_pending = False
        if self.read_reached or not self.details.get_mapped():
            return False
        adjustment = self.scrolled.get_vadjustment()  # 詳細の縦スクロールの位置。
        page = adjustment.get_page_size()  # 見えている高さ。
        if page <= 0:
            return False
        buffer = self.details.get_buffer()
        line_top, line_height = self.details.get_line_yrange(buffer.get_end_iter())  # 最後の行の位置。
        visible = self.details.get_visible_rect()  # 見えている範囲。
        if adjustment.get_value() + page >= adjustment.get_upper() - 1 and line_top + line_height <= visible.y + visible.height + 1:
            self.read_reached = True
            if not self.blocked:
                self.read_hint.set_text("（詳細を末尾まで表示しました）")
            self.update_controls()
        return False

    # 別のフォルダーの承認の上書きを確かめ済みか（要らなければ True）を返す。
    def override_acknowledged(self) -> bool:
        return self.override_check is None or self.override_check.get_active()

    # 承認してよい状態か（承認できる内容で、末尾まで表示し、「内容を読みました」と必要なら上書きの確認を選んだか）を返す。
    def approvable(self) -> bool:
        return not self.blocked and self.read_reached and self.check.get_active() and self.override_acknowledged()

    # チェックボックスと承認ボタンを、いまの状態に合わせて押せる・押せないにする。
    def update_controls(self, *_values) -> None:
        self.check.set_sensitive(not self.blocked and self.read_reached)
        if self.override_check is not None:
            self.override_check.set_sensitive(not self.blocked)
        self.approve_button.set_sensitive(self.approvable())


class BridgeApp:
    """管理画面の部品と、操作の流れ（子プロセス・承認ダイアログ・端末窓）をまとめる。"""

    # 説明データと CLI のオプション一覧から画面を組み立てる。子プロセスの起動・端末・ダイアログは差し替えられる。
    def __init__(self, help_data: dict, cli_options: frozenset[str], environment: Mapping[str, str], child_factory=None, which=None, terminal_popen=subprocess.Popen):
        self.help_data = help_data  # 画面の構成と説明文。
        self.cli_options = cli_options  # Ubuntu の CLI が受け付ける長いオプション名。
        self.environment = dict(environment)  # 子プロセスと hub.json の場所の元になる環境。
        self.child_factory = child_factory or self.default_child_factory  # 子プロセスを作る関数。
        self.which = which  # 端末を探す関数（None なら PATH の絶対パスの要素だけから探す）。
        self.terminal_popen = terminal_popen  # 端末を起動する関数。
        self.confirm_dangerous = self.dangerous_dialog  # 上書き系の確認（試験ではスタブ）。
        self.ask_approval = self.approval_dialog  # 承認ダイアログ（試験ではスタブ）。
        self.show_message = self.message_dialog  # お知らせ（試験ではスタブ）。
        self.show_copyable_command = self.copyable_command_dialog  # 端末が無いときの案内（試験ではスタブ）。
        self.ask_close = self.close_dialog  # 閉じる前の確認（試験ではスタブ）。
        self.call_later = self.default_call_later  # 少し待ってから呼ぶ関数（試験ではすぐ呼ぶ）。
        self.window = None  # 本番のウィンドウ（試験では作らない）。
        self.job: Job | None = None  # 実行中の操作（本体）。
        self.aux_job: Job | None = None  # 本体の起動中に並行して動かす、読み取り専用の補助の操作（同時に 1 つまで）。
        self.cards: dict[str, CardWidgets] = {}  # Action 名からカードへの対応。
        self.entry_buffers: dict = {}  # 入力欄の中身の鍵（ふつうはオプション名で全カード共有。hub-add の Tunnel ID だけ専用の鍵）から、入力欄の中身への対応。
        self.adjustments: dict = {}  # オプション名から、全カードで共有する数値の対応。
        self.reverting = False  # 上書き系のチェックを戻している最中か。
        self.autofilled: dict[str, str] = {}  # 入力欄の中身の鍵から、前回この画面が自動で入れた値への対応。
        self.process_directory = PROCESS_DIRECTORY  # 稼働の判定で読む /proc の場所（試験では一時フォルダーに差し替える）。
        self.hub_state_shown: HubState | None = None  # いま帯に出している稼働表示（同じ内容なら書き換えない）。
        self.hub_timer: int | None = None  # 稼働表示の繰り返しタイマー（open_window で始め、ウィンドウの destroy で止める。ここでは始めない）。
        self.permission_rows: tuple[HubProject, ...] = ()  # いま一覧に出している登録プロジェクト（hub_store の行と同じ順）。2.8.0。
        self.permission_entries: dict[str, dict] = {}  # ハブ内の名前から、最後に確認した hub-permissions の結果への対応。2.8.0。
        self.root_widget = self.build_content()  # 画面全体（ウィンドウの中身）。
        self.refresh_hub_list()

    # 既定の子プロセスを作る。出力と終了は GLib のメインループで受け取る。
    def default_child_factory(self, arguments, environment, on_line, on_exit, capture_stdout):
        return ChildProcess(arguments, environment, on_line, on_exit, capture_stdout, self.schedule)

    # 別スレッドから、関数の呼び出しをメインループへ渡す。
    def schedule(self, function, *values) -> None:
        # 1 回だけ呼んで、繰り返さない。
        def call_once():
            function(*values)
            return False

        GLib.idle_add(call_once)

    # milliseconds ミリ秒後に関数を 1 回呼ぶ。
    def default_call_later(self, milliseconds: int, function) -> None:
        # 1 回だけ呼んで、繰り返さない。
        def call_once():
            function()
            return False

        GLib.timeout_add(milliseconds, call_once)

    # ---- 組み立て ----

    # ハブの稼働表示の帯・タブ（Notebook）と、下部の共通欄（コマンド表示・出力ログ）を作る。
    def build_content(self):
        paned = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        self.notebook = Gtk.Notebook()
        self.notebook.set_name("tabs")
        for group in GROUP_ORDER:
            page = self.build_group_page(group)
            tab_label = Gtk.Label(label=str(self.help_data["groups"].get(group, group)))
            tab_label.set_name(f"tab:{group}")
            set_tooltip(tab_label, plain_tooltip(GROUP_TOOLTIPS[group]))
            self.notebook.append_page(page, tab_label)
        upper = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)  # 上側（帯とタブ）。帯はタブの外に置き、どのタブでも見えるようにする。
        upper.pack_start(self.build_hub_band(), False, False, 0)
        upper.pack_start(self.notebook, True, True, 0)
        paned.pack1(upper, True, False)
        paned.pack2(self.build_bottom(), False, False)
        paned.set_position(560)
        return paned

    # ハブの稼働表示の帯（状態と詳細の 2 つのラベル）を作る。中身は update_hub_state が入れる。
    def build_hub_band(self):
        band = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16, margin=6)
        band.set_name("hub-band")
        self.hub_state_label = Gtk.Label(xalign=0.0, yalign=0.0)
        self.hub_state_label.set_name("hub-state")
        set_tooltip(self.hub_state_label, plain_tooltip(HUB_STATE_TOOLTIP))
        band.pack_start(self.hub_state_label, False, False, 0)
        self.hub_state_detail = Gtk.Label(xalign=0.0, yalign=0.0, wrap=True)
        self.hub_state_detail.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)  # 長い理由やパスでも、帯の幅で折り返して全部見せる。
        self.hub_state_detail.set_name("hub-state-detail")
        set_tooltip(self.hub_state_detail, plain_tooltip(HUB_STATE_TOOLTIP))
        band.pack_start(self.hub_state_detail, True, True, 0)
        return band

    # ハブの稼働表示（帯の 2 つのラベル）を、いまの状態に書き換える。listing を省くと hub.json を読み直す。入力欄には触れない。
    def update_hub_state(self, listing: HubListing | None = None) -> None:
        try:
            state = hub_state(listing or read_hub_projects(self.environment), self.environment, self.process_directory)
        except Exception as error:  # 想定外の例外でも「確認できません」と理由を出し、繰り返しタイマーや操作の流れを止めない。
            state = HubState("unknown", HUB_STATE_UNKNOWN, escape_for_display(f"{type(error).__name__}: {error}"))
        if state == self.hub_state_shown:
            return
        self.hub_state_shown = state
        markup = "<b>" + escape_markup(state.text) + "</b>"  # 状態の表示（太字）。
        if state.kind == "running":
            markup = f'<span foreground="{HUB_RUNNING_COLOR}">{markup}</span>'
        self.hub_state_label.set_markup(markup)
        self.hub_state_detail.set_text(state.detail)

    # 分かっている値（hub-add の Tunnel ID・Tunnel Client の場所）を、空の欄か、前回この処理が入れた値のままの欄へ入れる。
    # 利用者が入力した値は書き換えない。繰り返しタイマーからは呼ばない（入力中に書き換わらないようにするため）。
    def autofill_known_values(self, listing: HubListing) -> None:
        for key, value in known_values(listing, self.environment).items():
            buffer = self.entry_buffers.get(key)  # 入れる先の入力欄の中身（その欄が画面に無ければ None）。
            if buffer is None or not autofill_allowed(buffer.get_text(), self.autofilled.get(key)):
                continue
            if buffer.get_text() != value:
                buffer.set_text(value, -1)
            self.autofilled[key] = value

    # 繰り返しタイマー（HUB_POLL_SECONDS 秒ごと）: ハブの稼働表示だけを調べ直す。True を返して繰り返す。
    def on_hub_timer(self) -> bool:
        self.update_hub_state()
        return True

    # 稼働表示の繰り返しタイマーを止める（始めていなければ何もしない）。
    def stop_hub_timer(self) -> None:
        if self.hub_timer is not None:
            GLib.source_remove(self.hub_timer)
            self.hub_timer = None

    # 1 つのタブの中身（スクロールできる縦並びのカード）を作る。
    def build_group_page(self, group: str):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin=10)
        if group == "easy":
            box.pack_start(self.build_easy_header(), False, False, 0)
        if group == "maintainer":
            warning = Gtk.Label(xalign=0.0, wrap=True)
            warning.set_markup("<b>" + escape_markup(MAINTAINER_WARNING) + "</b>")
            warning.set_name("maintainer-warning")
            set_tooltip(warning, plain_tooltip("配布物（Skill のアーカイブ・Bundle）と依存物ロックを作る、保守者向けの操作です。署名には SSH 秘密鍵のファイル、ロックの更新には gh（GitHub CLI）とネット接続が要ります。"))
            box.pack_start(warning, False, False, 0)
        for action, info in self.help_data["actions"].items():
            if info.get("group") == group:
                box.pack_start(self.build_card(action), False, False, 0)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.add(box)
        return scrolled

    # かんたんタブの先頭（説明・ハブの登録一覧・確認の 5 段階）を作る。
    def build_easy_header(self):
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        actions = self.help_data["actions"]  # 案内に出す Action の表示名の元。
        recovery = EASY_RECOVERY_TEMPLATE.format(status=actions.get("hub-status", {}).get("label", "hub-status"), stop=actions.get("hub-stop", {}).get("label", "hub-stop"))  # 異常終了のあとの確かめ方。
        intro = Gtk.Label(label="\n".join([*EASY_INTRO_LINES, recovery]), xalign=0.0, wrap=True)
        intro.set_name("easy-intro")
        set_tooltip(intro, plain_tooltip(GROUP_TOOLTIPS["easy"]))
        left.pack_start(intro, False, False, 0)
        left.pack_start(self.build_hub_list(), True, True, 0)
        header.pack_start(left, True, True, 0)
        header.pack_start(self.build_stages(), False, False, 0)
        return header

    # ハブに登録済みのプロジェクトの一覧（hub.json を読むだけ）と、権限の確認・切り替えの 3 つのボタンを作る。
    def build_hub_list(self):
        frame = Gtk.Frame()
        frame.set_label_widget(heading_label("ハブに登録済みのプロジェクト", "このPCのハブ設定（hub.json）を読み取って、登録済みのプロジェクトの名前とフォルダーを表示します。hub.json は書き換えません。ソースの読み取り・Claude Code・承認の列は「権限を確認」を押すまで「（未確認）」のままです。", "hub-list-title"))
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=8)
        self.hub_status = Gtk.Label(xalign=0.0, wrap=True, selectable=False)
        self.hub_status.set_name("hub-list-status")
        set_tooltip(self.hub_status, plain_tooltip("hub.json の場所と、読み取りの結果です。"))
        box.pack_start(self.hub_status, False, False, 0)
        self.hub_store = Gtk.ListStore(str, str, str, str, str, str)
        self.hub_tree = Gtk.TreeView(model=self.hub_store)
        self.hub_tree.set_name("hub-list-view")
        for index, title in enumerate(("名前", "フォルダー", "承認ファイル", "ソースの読み取り", "Claude Code", "承認")):
            column = Gtk.TreeViewColumn(title, Gtk.CellRendererText(), text=index)
            column.set_resizable(True)
            self.hub_tree.append_column(column)
        set_tooltip(self.hub_tree, plain_tooltip(
            "ハブに登録済みのプロジェクト（ハブ内の名前・フォルダー・承認ファイルの場所の確認・権限の確認の列）です。承認ファイルが所定の場所に無い登録は、承認状態を確かめられないため"
            "「確かめられません」と出し、この画面では承認・切り替えをしません。行を選ぶと、下の「ソースの読み取りを切り替え」「Claude Code の起動を切り替え」の対象になります"
            "（選ぶだけでは何も実行しません）。"
        ))
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(124)
        scrolled.add(self.hub_tree)
        box.pack_start(scrolled, True, True, 0)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        refresh = Gtk.Button(label="一覧を更新", halign=Gtk.Align.START)
        refresh.set_name("hub-list-refresh")
        set_tooltip(refresh, plain_tooltip("hub.json を読み直して一覧を更新します。端末窓で「プロジェクトを追加」を終えたあとに押します。"))
        refresh.connect("clicked", lambda _button: self.refresh_hub_list())
        buttons.pack_start(refresh, False, False, 0)
        self.permission_check_button = Gtk.Button(label="権限を確認", halign=Gtk.Align.START)
        self.permission_check_button.set_name("hub-permission-check")
        set_tooltip(self.permission_check_button, plain_tooltip(PERMISSION_CHECK_TOOLTIP))
        self.permission_check_button.connect("clicked", self.on_check_permissions_clicked)
        buttons.pack_start(self.permission_check_button, False, False, 0)
        self.permission_source_button = Gtk.Button(label="ソースの読み取りを切り替え", halign=Gtk.Align.START)
        self.permission_source_button.set_name("hub-permission-toggle-source-read")
        set_tooltip(self.permission_source_button, plain_tooltip(PERMISSION_TOGGLE_TOOLTIPS["source-read"]))
        self.permission_source_button.connect("clicked", self.on_toggle_source_read_clicked)
        buttons.pack_start(self.permission_source_button, False, False, 0)
        self.permission_claude_button = Gtk.Button(label="Claude Code の起動を切り替え", halign=Gtk.Align.START)
        self.permission_claude_button.set_name("hub-permission-toggle-claude-code")
        set_tooltip(self.permission_claude_button, plain_tooltip(PERMISSION_TOGGLE_TOOLTIPS["claude-code"]))
        self.permission_claude_button.connect("clicked", self.on_toggle_claude_code_clicked)
        buttons.pack_start(self.permission_claude_button, False, False, 0)
        box.pack_start(buttons, False, False, 0)
        frame.add(box)
        return frame

    # hub.json を読み直して一覧に出す。ファイルが無ければ「未登録」と出し、作らない。
    # 同じ読み取り結果で、ハブの稼働表示を更新し、分かっている値を空の入力欄へ入れる。権限の列は、確認済みの内容（self.permission_entries）があれば使い、無ければ「（未確認）」にする。
    # 選んでいた行は、同じ名前の登録が残っていれば選び直す（ListStore を作り直すと選択が消えるため）。
    def refresh_hub_list(self) -> None:
        _model, selected_iterator = self.hub_tree.get_selection().get_selected()  # 作り直す前の選択。
        selected_index = self.hub_store.get_path(selected_iterator).get_indices()[0] if selected_iterator is not None else None
        selected_name = self.permission_rows[selected_index].name if selected_index is not None and selected_index < len(self.permission_rows) else None
        listing = read_hub_projects(self.environment)
        self.update_hub_state(listing)
        self.autofill_known_values(listing)
        self.permission_rows = listing.projects
        self.hub_store.clear()
        if listing.error:
            self.hub_status.set_text(f"読めません: {escape_for_display(listing.error)}（{escape_for_display(listing.path or 'hub.json')}）")
            return
        restore_index = None  # 選び直す行（無ければ None）。
        for index, project in enumerate(listing.projects):
            approval = "所定の場所" if project.approval_problem is None else "確かめられません（所定の場所ではありません）"  # 承認ファイルの確認の結果。
            source_text, claude_text, approval_text = permission_display_texts(self.permission_entries.get(project.name))
            self.hub_store.append([escape_for_display(project.name), escape_for_display(project.root), approval, source_text, claude_text, approval_text])
            if project.name == selected_name:
                restore_index = index
        if restore_index is not None:
            self.hub_tree.get_selection().select_path(Gtk.TreePath.new_from_indices([restore_index]))
        unverifiable = sum(1 for project in listing.projects if project.approval_problem is not None)  # 承認状態を確かめられない登録の数。
        if not listing.projects:
            self.hub_status.set_text(f"未登録（{listing.path}{' はまだありません' if not listing.exists else ''}）")
        else:
            note = f"。承認状態を確かめられない登録 {unverifiable} 件" if unverifiable else ""  # 確かめられない登録の注記。
            self.hub_status.set_text(f"登録 {len(listing.projects)} 件{note}（{listing.path}）")

    # 一覧でいま選んでいる登録プロジェクトを返す（選んでいなければ None）。
    def selected_hub_project(self) -> HubProject | None:
        _model, iterator = self.hub_tree.get_selection().get_selected()
        if iterator is None:
            return None
        index = self.hub_store.get_path(iterator).get_indices()[0]
        return self.permission_rows[index] if index < len(self.permission_rows) else None

    # 確認の 5 段階を、静的なラベルで作る。
    def build_stages(self):
        frame = Gtk.Frame()
        frame.set_label_widget(heading_label("確認の 5 段階", STAGE_TITLE_TOOLTIP + STAGE_HUB_NOTE, "stage-title"))
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=8)
        for index, (title, description) in enumerate(stage_definitions(self.help_data), start=1):
            suffix = "" if index <= 3 else "（ChatGPT 側）"  # この画面では確かめられない段階の印。
            label = Gtk.Label(label=f"{index}. {title}{suffix}", xalign=0.0)
            label.set_name(f"stage:{index}")
            if index > 3:
                label.set_markup("<i>" + escape_markup(f"{index}. {title}{suffix}") + "</i>")
            set_tooltip(label, plain_tooltip(description))
            box.pack_start(label, False, False, 0)
        note = Gtk.Label(label=STAGE_NOTE, xalign=0.0)
        note.set_name("stage:note")
        set_tooltip(note, plain_tooltip("1〜3 は、この画面の「自己試験」「ハブの稼働状態」などで確かめられます。4・5 は ChatGPT の新しいチャットで確かめます。"))
        box.pack_start(note, False, False, 0)
        frame.add(box)
        return frame

    # Action の説明のツールチップ（markup）を作る。
    def action_markup(self, action: str) -> str:
        return tooltip_markup(action_tooltip_sections(self.help_data, action), escape_markup)

    # オプションの説明のツールチップ（markup）を作る。
    def option_markup(self, option: str, action: str) -> str:
        return tooltip_markup(option_tooltip_sections(self.help_data, option, action), escape_markup)

    # 1 行入力の中身を返す（無ければ作る）。同じオプションは全カードで共有し、共有から外す欄（hub-add の Tunnel ID）だけ専用にする。
    def shared_buffer(self, option: str, action: str | None = None):
        key = buffer_key(action, option)  # 入力欄の中身の鍵。
        if key not in self.entry_buffers:
            self.entry_buffers[key] = Gtk.EntryBuffer()
        return self.entry_buffers[key]

    # 全カードで共有する数値入力の範囲と値を返す（無ければ作る）。
    def shared_adjustment(self, option: str):
        if option not in self.adjustments:
            self.adjustments[option] = Gtk.Adjustment(value=0, lower=0, upper=65535, step_increment=1, page_increment=100)
        return self.adjustments[option]

    # 1 つの Action のカード（見出し・概要・入力欄・実行ボタン）を作る。
    def build_card(self, action: str):
        info = self.help_data["actions"][action]
        action_tooltip = self.action_markup(action)  # Action の説明。
        frame = Gtk.Frame()
        frame.set_name(f"card:{action}")
        title = Gtk.Label(xalign=0.0)
        title.set_markup("<b>" + escape_markup(info["label"]) + "</b>")
        title.set_name(f"card-title:{action}")
        set_tooltip(title, action_tooltip)
        frame.set_label_widget(title)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=8)
        summary = Gtk.Label(label=str(info.get("summary") or ""), xalign=0.0, wrap=True)
        summary.set_max_width_chars(110)
        summary.set_name(f"card-summary:{action}")
        set_tooltip(summary, action_tooltip)
        body.pack_start(summary, False, False, 0)
        grid = Gtk.Grid(column_spacing=8, row_spacing=4)
        checks = {}  # このカードのチェックボックス。
        row = 0  # 格子の行。
        for option in visible_options(self.help_data, action, self.cli_options):
            option_info = self.help_data["options"][option]
            option_tooltip = self.option_markup(option, action)  # オプションの説明。
            kind = option_kind(self.help_data, option)
            if kind == "flag":
                check = Gtk.CheckButton(label=str(option_info["label"]))
                check.set_name(f"option-check:{action}:{option}")
                set_tooltip(check, option_tooltip)
                if option in FORCED_FLAGS.get(action, ()):
                    check.set_active(True)
                    check.set_sensitive(False)
                elif option_info.get("dangerous") is True:
                    check.connect("toggled", self.on_dangerous_toggled, action, option)
                grid.attach(check, 1, row, 2, 1)
                checks[option] = check
                row += 1
                continue
            required = option in info.get("required", [])  # 必須欄か。
            label = Gtk.Label(label=str(option_info["label"]) + ("＊" if required else ""), xalign=1.0)
            label.set_name(f"option-label:{action}:{option}")
            set_tooltip(label, option_tooltip)
            grid.attach(label, 0, row, 1, 1)
            if kind == "number":
                widget = Gtk.SpinButton(adjustment=self.shared_adjustment(option), climb_rate=1.0, digits=0)
                widget.set_numeric(True)
            else:
                widget = Gtk.Entry.new_with_buffer(self.shared_buffer(option, action))
                example = re.sub(r"（Windows は[^）]*）", "", str(option_info.get("example") or ""))  # 入力例（Ubuntu の分だけ）。
                if example:
                    widget.set_placeholder_text("例: " + example)
            widget.set_hexpand(True)
            widget.set_name(f"option-input:{action}:{option}")
            set_tooltip(widget, option_tooltip)
            grid.attach(widget, 1, row, 1, 1)
            if kind == "path":
                choose = Gtk.Button(label="選択…")
                choose.set_name(f"option-choose:{action}:{option}")
                set_tooltip(choose, plain_tooltip(self.choose_tooltip(action, option)))
                choose.connect("clicked", self.on_choose_clicked, action, option)
                grid.attach(choose, 2, row, 1, 1)
            row += 1
        if row:
            body.pack_start(grid, False, False, 0)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        run_button = Gtk.Button(label="端末窓で実行" if "key" in info.get("interactive", []) else "実行")
        run_button.set_name(f"run:{action}")
        set_tooltip(run_button, action_tooltip)
        run_button.connect("clicked", self.on_run_clicked, action)
        buttons.pack_start(run_button, False, False, 0)
        stop_button = None  # 停止ボタン（終わらない操作だけ）。
        if action in STOPPABLE_ACTIONS:
            stop_button = Gtk.Button(label="停止")
            stop_button.set_name(f"stop:{action}")
            set_tooltip(stop_button, plain_tooltip(self.stop_tooltip(action)))
            stop_button.set_no_show_all(True)
            stop_button.connect("clicked", self.on_stop_clicked, action)
            buttons.pack_start(stop_button, False, False, 0)
        body.pack_start(buttons, False, False, 0)
        frame.add(body)
        self.cards[action] = CardWidgets(action, frame, run_button, stop_button, checks)
        return frame

    # 「選択…」ボタンの説明を作る。
    def choose_tooltip(self, action: str, option: str) -> str:
        label = self.help_data["options"][option]["label"]
        kinds = {"folder": "フォルダーを選ぶ", "save": "保存するファイル名を指定する", "open": "既存のファイルを選ぶ"}  # 選択画面の種類。
        return f"「{label}」を、ファイル選択の画面で選びます（{kinds[chooser_mode(action, option)]}）。選んだパスがこの欄に入ります。ファイルの中身は読みません。"

    # 停止ボタンの説明を作る。
    def stop_tooltip(self, action: str) -> str:
        if action in HUB_STOP_ACTIONS:
            caution = str(self.help_data["actions"].get("hub-stop", {}).get("caution") or "").split("。")[0]  # hub-stop の注意書きの最初の文。
            return f"ハブを止めます（「{self.help_data['actions']['hub-stop']['label']}」（hub-stop）を実行します）。{caution}。"
        return "Tunnel Client を止めます（CLI とその子プロセスのプロセスグループへ、終了の合図（SIGTERM）を送ります）。"

    # 下部の共通欄（実行されるコマンド・出力ログ・消去・コピー）を作る。
    def build_bottom(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin=8)
        box.pack_start(heading_label("実行されるコマンド", "画面が CLI に渡す引数配列を、表示用に 1 行へ整えたものです。", "command-title"), False, False, 0)
        self.command_view = Gtk.TextView(editable=False, cursor_visible=False, monospace=True, wrap_mode=Gtk.WrapMode.CHAR)
        self.command_view.set_name("command-view")
        self.command_view.get_buffer().set_text("（まだ実行していません）")
        set_tooltip(self.command_view, plain_tooltip("最後に実行した（または実行中の）コマンドです。表示用に整形したもので、実行にはこの文字列を使いません（引数は配列のまま CLI へ渡します）。端末窓で実行する操作は、その端末で動く CLI のコマンドを表示します。"))
        command_scroll = Gtk.ScrolledWindow()
        command_scroll.set_min_content_height(44)
        command_scroll.add(self.command_view)
        box.pack_start(command_scroll, False, False, 0)
        log_header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        log_header.pack_start(heading_label("出力ログ", "CLI の標準出力と標準エラーを、届いた順に表示します。", "log-title"), False, False, 0)
        clear_button = Gtk.Button(label="消去")
        clear_button.set_name("log-clear")
        set_tooltip(clear_button, plain_tooltip("出力ログ欄を空にします。CLI や設定には影響しません。"))
        clear_button.connect("clicked", lambda _button: self.log_view.get_buffer().set_text(""))
        copy_button = Gtk.Button(label="コピー")
        copy_button.set_name("log-copy")
        set_tooltip(copy_button, plain_tooltip("出力ログ欄の全文をクリップボードへコピーします。"))
        copy_button.connect("clicked", lambda _button: self.copy_to_clipboard(self.text_of(self.log_view)))
        log_header.pack_end(copy_button, False, False, 0)
        log_header.pack_end(clear_button, False, False, 0)
        box.pack_start(log_header, False, False, 0)
        self.log_view = Gtk.TextView(editable=False, cursor_visible=False, monospace=True, wrap_mode=Gtk.WrapMode.CHAR)
        self.log_view.set_name("log-view")
        set_tooltip(self.log_view, plain_tooltip("CLI の出力を届いた順に表示し、処理ごとに最後へ「終了コード N」を出します。起動中に並行して実行した読み取り専用の操作（稼働状態・登録一覧）の行には、先頭に「[Action 名]」が付きます。終了コード 0 は CLI の処理の成功で、ChatGPT から読めることの確認ではありません。Runtime API Key の入力は別の端末窓で行い、この画面には届きません。"))
        log_buffer = self.log_view.get_buffer()
        self.log_end_mark = log_buffer.create_mark(None, log_buffer.get_end_iter(), False)  # 自動スクロールの目印。
        log_scroll = Gtk.ScrolledWindow()
        log_scroll.set_min_content_height(140)
        log_scroll.add(self.log_view)
        box.pack_start(log_scroll, True, True, 0)
        return box

    # ---- 共通の表示 ----

    # テキスト欄の全文を返す。
    def text_of(self, view) -> str:
        buffer = view.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)

    # 文字列をクリップボードへコピーする。
    def copy_to_clipboard(self, text: str) -> None:
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        clipboard.store()

    # 出力ログ欄の最後へ行を足し、末尾まで自動でスクロールする。各行の制御文字は見える形にし、長すぎる行は切り詰める。
    def append_log(self, text: str) -> None:
        buffer = self.log_view.get_buffer()
        lines = str(text).rstrip("\n").split("\n")  # 足す行（改行 LF だけで分ける）。
        buffer.insert(buffer.get_end_iter(), "\n".join(sanitize_log_line(line) for line in lines) + "\n")
        overflow = buffer.get_line_count() - LOG_LINE_LIMIT  # 上限を超えた行数。
        if overflow > 0:
            buffer.delete(buffer.get_start_iter(), buffer.get_iter_at_line(overflow))
        self.log_view.scroll_mark_onscreen(self.log_end_mark)

    # 「実行されるコマンド」欄を書き換える。
    def set_command_display(self, text: str) -> None:
        self.command_view.get_buffer().set_text(text)

    # ---- 入力値 ----

    # カードの入力欄の値（text・path・number）を集める。数値の 0 は CLI の既定と同じなので空として扱う。
    # パスは ~ と相対パスを、この画面の作業ディレクトリを基準に絶対パスへそろえる（子プロセスの作業ディレクトリは HOME のため）。
    def collect_values(self, action: str) -> dict[str, str]:
        values: dict[str, str] = {}  # オプション名から入力値への対応。
        for option in visible_options(self.help_data, action, self.cli_options):
            kind = option_kind(self.help_data, option)
            if kind == "text":
                values[option] = self.shared_buffer(option, action).get_text()
            elif kind == "path":
                values[option] = absolute_input_path(self.shared_buffer(option, action).get_text())
            elif kind == "number":
                number = int(self.shared_adjustment(option).get_value())  # 数値入力の値。
                values[option] = "" if number == 0 else str(number)
        return values

    # カードでオンにしたフラグを集める（常に付けるものは除く。組み立てのときに付く）。
    def collect_flags(self, action: str) -> set[str]:
        return {option for option, check in self.cards[action].checks.items() if check.get_active() and check.get_sensitive()}

    # 上書き系のチェックをオンにしたら確認ダイアログを出し、キャンセルならオフへ戻す。
    def on_dangerous_toggled(self, check, action: str, option: str) -> None:
        if self.reverting or not check.get_active():
            return
        if self.confirm_dangerous(option):
            self.append_log(f"「{self.help_data['options'][option]['label']}」を有効にしました（「{self.help_data['actions'][action]['label']}」のカードだけ。保存しません）。")
            return
        self.reverting = True
        try:
            check.set_active(False)
        finally:
            self.reverting = False

    # ファイル選択の画面を作る（表示はしない）。いまの入力値があれば、その場所から始める。
    def build_file_chooser(self, action: str, option: str):
        mode = chooser_mode(action, option)
        titles = {"folder": "フォルダーを選択", "save": "保存先のファイルを指定", "open": "ファイルを選択"}  # 選択画面の題名。
        modes = {"folder": Gtk.FileChooserAction.SELECT_FOLDER, "save": Gtk.FileChooserAction.SAVE, "open": Gtk.FileChooserAction.OPEN}  # GTK の選択の種類。
        dialog = Gtk.FileChooserDialog(title=titles[mode], transient_for=self.window, action=modes[mode])
        cancel = dialog.add_button("キャンセル", Gtk.ResponseType.CANCEL)
        accept = dialog.add_button("選択", Gtk.ResponseType.ACCEPT)
        set_tooltip(cancel, plain_tooltip("選ばずに閉じます。入力欄は変わりません。"))
        set_tooltip(accept, plain_tooltip("選んだパスを入力欄へ入れます。ファイルの中身は読みません。"))
        current = expand_home(self.shared_buffer(option, action).get_text().strip(), self.environment)  # いまの入力値。
        if current and os.path.isdir(current) and mode == "folder":
            dialog.set_current_folder(current)
        elif current and os.path.isdir(os.path.dirname(current)):
            dialog.set_current_folder(os.path.dirname(current))
            if mode == "save":
                dialog.set_current_name(os.path.basename(current))
        elif option == "signing-key" and os.path.isdir(expand_home("~/.ssh", self.environment)):
            dialog.set_current_folder(expand_home("~/.ssh", self.environment))
        return dialog

    # 「選択…」ボタン: ファイル選択の画面を開き、選んだパスを入力欄へ入れる。
    def on_choose_clicked(self, _button, action: str, option: str) -> None:
        dialog = self.build_file_chooser(action, option)
        if dialog.run() == Gtk.ResponseType.ACCEPT and dialog.get_filename():
            self.shared_buffer(option, action).set_text(dialog.get_filename(), -1)
        dialog.destroy()

    # ---- 実行の状態 ----

    # 操作を始め、そのカードの上書き系のチェックをオフに戻し、実行ボタンの状態を更新する。
    def begin_job(self, action: str, values: dict) -> Job:
        self.job = Job(action=action, values=dict(values))
        self.reset_dangerous_checks(action)
        self.update_buttons()
        return self.job

    # 操作を終え、実行ボタンの状態を戻す。登録一覧も読み直す（hub.json は読むだけ）。
    def finish_job(self) -> None:
        self.job = None
        self.update_buttons()
        self.refresh_hub_list()

    # 補助の操作を始める。ログの各行の先頭に「[Action 名] 」を付けて、本体の出力と区別する。
    def begin_aux_job(self, action: str, values: dict) -> Job:
        self.aux_job = Job(action=action, values=dict(values), prefix=f"[{action}] ")
        self.update_buttons()
        return self.aux_job

    # 補助の操作を終え、実行ボタンの状態を戻す。
    def finish_aux_job(self) -> None:
        self.aux_job = None
        self.update_buttons()
        self.refresh_hub_list()

    # 補助の操作をいま始めてよいかを返す。本体の終わらない子（起動）が動いている間だけ、読み取り専用の短い操作を 1 つまで許す。
    def auxiliary_allowed(self, action: str) -> bool:
        return action in AUXILIARY_ACTIONS and self.aux_job is None and self.job is not None and self.job.action in STOPPABLE_ACTIONS and self.job.final_started

    # 実行中は実行ボタンを無効にし（起動中の補助の操作は除く）、その操作のカードにだけ停止ボタンを出す。
    def update_buttons(self) -> None:
        idle = self.job is None and self.aux_job is None  # 何も動いていないか。
        for action, card in self.cards.items():
            card.run_button.set_sensitive(idle or self.auxiliary_allowed(action))
            if card.stop_button is None:
                continue
            active = self.job is not None and self.job.action == action  # このカードの操作が実行中か。
            card.stop_button.set_visible(active)
            card.stop_button.set_sensitive(active and not self.job.stop_requested)
        self.permission_check_button.set_sensitive(idle or self.auxiliary_allowed("hub-permissions"))  # 読み取り専用なので補助の扱い。
        self.permission_source_button.set_sensitive(idle)  # 書き込みを伴うため、ほかの操作と並行させない。
        self.permission_claude_button.set_sensitive(idle)

    # 段階の後処理のあとで、操作が次の段階へ渡っておらず（動いている子が無く）まだ終わっていなければ、終える。
    def settle_job(self, job: Job) -> None:
        if job.current is not None:
            return
        if self.job is job:
            self.finish_job()
        elif self.aux_job is job:
            self.finish_aux_job()

    # 停止が求められていれば、流れを終えて True を返す。
    def stopped(self) -> bool:
        if self.job is not None and self.job.stop_requested:
            self.append_log("停止が求められたため、ここで終えました。")
            self.finish_job()
            return True
        return False

    # 子プロセスを 1 つ起動し、出力をログへ流す。終わったら終了コードを出して on_done(終了コード, 標準出力) を呼ぶ。
    # job を省くと本体の操作の段階になる。補助の操作では、ログの各行に job.prefix を付ける。
    def run_step(self, arguments: list[str], on_done, capture: bool = False, final: bool = False, job: Job | None = None) -> None:
        job = job or self.job  # この段階が属する操作。
        self.set_command_display(display_command(arguments))
        self.append_log(job.prefix + "$ " + display_command(arguments))
        child = None  # 起動する子プロセス。

        # 子プロセスの出力の 1 行をログへ出す。
        def on_line(line):
            self.append_log(job.prefix + line)

        # 子プロセスの終了を受け取り、ログへ出して次へ進む。後処理で例外が起きても、次の段階へ渡っていなければ操作を必ず終える。
        def on_exit(code, output):
            try:
                for line in exit_code_lines(code, job.stop_requested):
                    self.append_log(job.prefix + line)
                if job.current is child:
                    job.current = None
                on_done(code, output)
            except Exception as error:  # 想定外の例外でも、実行ボタンが押せないまま残らないようにする。
                self.append_log(job.prefix + f"内部エラーのため中止しました（{type(error).__name__}: {error}）。")
            finally:
                self.settle_job(job)

        child = self.child_factory(arguments, child_environment(self.environment), on_line, on_exit, capture)
        job.current = child
        job.final_started = final
        self.update_buttons()
        try:
            child.start()
        except (OSError, ValueError) as error:  # ValueError は引数に NUL 文字があるときなど。
            self.append_log(f"子プロセスを起動できませんでした: {error}")
            on_exit(None, "")

    # ---- 操作の流れ ----

    # 実行ボタン: 必須欄を確かめ、操作の種類ごとの流れへ進む。起動中は、読み取り専用の補助の操作だけを並行して実行する。
    def on_run_clicked(self, _button, action: str) -> None:
        busy = self.job is not None or self.aux_job is not None  # 何か動いているか。
        if busy and not self.auxiliary_allowed(action):
            return
        info = self.help_data["actions"][action]
        values = self.collect_values(action)  # 入力値。
        flags = self.collect_flags(action)  # オンにしたフラグ。
        missing = missing_required(self.help_data, action, values)
        if missing:
            self.show_message("次の欄が空のため、実行しませんでした。\n" + "\n".join(f"・{item}" for item in missing))
            return
        try:
            self.dispatch_run(action, info, values, flags, busy)
        except Exception as error:  # 想定外の例外でも、ログに出し、実行ボタンが押せないまま残らないようにする。
            self.append_log(f"内部エラーのため中止しました（{type(error).__name__}: {error}）。")
            for job in (self.job, self.aux_job):
                if job is not None and job.current is None:
                    self.settle_job(job)

    # 操作の種類ごとの流れへ進む（補助の操作・ハブの起動・承認が要る操作・キーが要る操作・そのほか）。
    def dispatch_run(self, action: str, info: dict, values: dict, flags: set[str], busy: bool) -> None:
        if busy:
            job = self.begin_aux_job(action, values)  # 起動中に並行して動かす補助の操作。
            self.run_step(build_cli_arguments(self.help_data, action, values, flags, self.cli_options), lambda _code, _output: self.finish_aux_job(), job=job)
            return
        interactive = info.get("interactive", [])  # 入力が要るもの（key・approval）。
        if action in HUB_STOP_ACTIONS:
            self.start_hub_flow(action, values, flags)
        elif "approval" in interactive:
            self.start_approval_flow(action, values, flags)
        elif "key" in interactive:
            self.begin_job(action, values)
            try:
                self.open_terminal(build_cli_arguments(self.help_data, action, values, flags, self.cli_options))
            finally:
                self.finish_job()
        else:
            self.begin_job(action, values)
            self.run_step(build_cli_arguments(self.help_data, action, values, flags, self.cli_options), lambda _code, _output: self.finish_job())

    # 実行を始めるときに、そのカードの上書き系のチェック（force・force-reconfigure・replace-key）をオフに戻す。
    # 指定はこの 1 回の実行にだけ効く（成功・失敗とも、次の実行には持ち越さない）。
    def reset_dangerous_checks(self, action: str) -> None:
        for option, check in self.cards[action].checks.items():
            if self.help_data["options"][option].get("dangerous") is True and check.get_active() and check.get_sensitive():
                check.set_active(False)
                self.append_log(f"「{self.help_data['options'][option]['label']}」は、この実行にだけ付けます（チェックはオフに戻しました）。")

    # 承認が要る操作（approve・start・add-project・hub-add）: 足場 → 公開範囲の確認 → 承認ダイアログ → 実行。
    def start_approval_flow(self, action: str, values: dict, flags: set[str]) -> None:
        info = self.help_data["actions"][action]
        root = values.get("project-root", "")  # プロジェクトのフォルダー（入力どおり）。
        profile = blank_to_none(values.get("profile")) if "profile" in visible_options(self.help_data, action, self.cli_options) else None  # show-exposure と実行で同じものを使う。
        needs_scaffold = action in ("add-project", "hub-add") and not scaffold_exists(root, self.environment)  # 先に init が要るか。
        if needs_scaffold and is_blank(values.get("project-name")):
            self.show_message(f"足場（{CONFIG_NAME}）がまだ無いため、先に作ります。「{self.help_data['options']['project-name']['label']}」を入力してから、もう一度実行してください。")
            return
        self.begin_job(action, values)
        hub_warning = hub_warning_text(self.help_data) if action in HUB_APPROVAL_ACTIONS else None  # ハブの影響範囲の警告。
        if hub_warning:
            self.append_log("注意: " + hub_warning)

        # 公開範囲の確認結果を読み、承認ダイアログを経て実行する。
        def after_exposure(code, output):
            if self.stopped():
                return
            if code != 0:
                self.append_log("公開範囲を確認できなかったため、中止しました。")
                self.finish_job()
                return
            report, error = parse_exposure_report(output)
            if report is None:
                self.append_log(f"公開範囲の確認結果を読めませんでした（{error}）。受け取った出力:")
                self.append_log("\n".join(raw_output_lines(output)))
                self.append_log("中止しました。")
                self.finish_job()
                return
            grant = None  # 承認ダイアログの結果。
            if not approval_needed(report):
                self.append_log(f"公開範囲は承認済みです（指紋 {report['exposureSha256']}）。承認ダイアログは出しません。")
            else:
                grant = self.ask_approval(report, hub_warning, root, profile)
                if grant is None:
                    self.append_log("承認されなかったため、何も実行しませんでした。このプロジェクトは公開されません。")
                    self.finish_job()
                    return
                self.append_log(f"承認ダイアログで承認されました（指紋 {grant.sha256}）。CLI が現在の公開範囲と照合します。")
            arguments = build_cli_arguments(self.help_data, action, values, flags, self.cli_options, grant)  # 実行する引数配列。
            if "key" in info.get("interactive", []):
                self.open_terminal(arguments)
                self.finish_job()
                return
            self.run_step(arguments, lambda _code, _output: self.finish_job(), final=action in STOPPABLE_ACTIONS)

        # 公開範囲を読み取り専用で確認する。
        def show_exposure():
            self.run_step(build_show_exposure_arguments(root, profile), after_exposure, capture=True)

        # 足場の作成の結果を見て、公開範囲の確認へ進む。
        def after_init(code, _output):
            if self.stopped():
                return
            if code != 0:
                self.append_log("足場の作成（init）に失敗したため、中止しました。")
                self.finish_job()
                return
            show_exposure()

        if needs_scaffold:
            self.append_log(f"足場（{CONFIG_NAME}）が無いため、先に「{self.help_data['actions']['init']['label']}」（init）を実行します。")
            self.run_step(build_init_arguments(root, values["project-name"]), after_init)
        else:
            show_exposure()

    # hub-start・hub-restart: 登録プロジェクトごとに公開範囲を確かめ、必要なら承認 → approve。最後に --service 付きで起動する。
    def start_hub_flow(self, action: str, values: dict, flags: set[str]) -> None:
        listing = read_hub_projects(self.environment)
        if listing.error:
            self.show_message(f"hub.json を読めないため、実行しませんでした: {listing.error}")
            return
        self.begin_job(action, values)
        pending = list(listing.projects)  # まだ確かめていない登録プロジェクト。
        unverifiable: list[str] = []  # 承認状態を確かめられなかった登録の名前。
        hub_warning = hub_warning_text(self.help_data)  # ハブの影響範囲の警告。
        self.append_log(f"登録プロジェクト {len(pending)} 件の公開範囲を確かめてから起動します。")

        # 次の登録プロジェクトを確かめる。全部終わったら起動する。
        def next_project():
            if self.stopped():
                return
            if not pending:
                launch()
                return
            project = pending.pop(0)
            self.append_log(f"--- {project.name}（{project.root}）")
            if project.approval_problem is not None:
                self.append_log(f"承認状態を確かめられません: {project.approval_problem}")
                self.append_log("この画面からは、このプロジェクトを承認しません（承認済みとしても扱いません）。hub.json の登録内容を確かめてください。")
                unverifiable.append(project.name)
                next_project()
                return
            if is_blank(project.root) or project.profile is None:
                self.append_log("hub.json の登録内容（root）を読めないため確かめられません。この画面からは、このプロジェクトを承認しません。")
                unverifiable.append(project.name)
                next_project()
                return
            self.run_step(build_show_exposure_arguments(project.root, project.profile), lambda code, output: after_exposure(project, code, output), capture=True)

        # 公開範囲の確認結果を読み、必要なら承認ダイアログを出す。
        def after_exposure(project, code, output):
            if self.stopped():
                return
            report, error = parse_exposure_report(output) if code == 0 else (None, f"終了コード {code}")
            if report is None:
                self.append_log(f"公開範囲を確認できませんでした（{error}）。このプロジェクトは承認しません（公開されません）。")
                if code == 0:
                    self.append_log("\n".join(raw_output_lines(output)))
                next_project()
                return
            if not approval_needed(report):
                self.append_log(f"公開範囲は承認済みです（指紋 {report['exposureSha256']}）。")
                next_project()
                return
            grant = self.ask_approval(report, hub_warning, project.root, project.profile)
            if grant is None:
                self.append_log(f"{project.name} は承認されなかったため、公開されません。")
                next_project()
                return
            self.run_step(build_approve_arguments(project.root, project.profile, grant), lambda code, _output: after_approve(project, code))

        # 承認の保存の結果をログへ出し、次へ進む。
        def after_approve(project, code):
            if self.stopped():
                return
            if code != 0:
                self.append_log(f"{project.name} の承認を保存できませんでした。このプロジェクトは公開されません。")
            next_project()

        # 承認の確認が終わったら、--service 付きで起動する。
        def launch():
            if unverifiable:
                self.append_log(f"承認状態を確かめられなかった登録 {len(unverifiable)} 件: {'、'.join(unverifiable)}（この画面からは承認していません）。")
            self.append_log("承認の確認が終わりました。--service 付きで起動します（承認されていないプロジェクトは公開しません）。")
            self.run_step(build_cli_arguments(self.help_data, action, values, flags, self.cli_options), lambda _code, _output: self.finish_job(), final=True)

        next_project()

    # 想定外の例外をログに出し、まだ終わっていない操作を終える（on_run_clicked と同じ考え方。ボタンの signal から直接呼ぶものに使う）。
    def guarded_call(self, function: Callable[[], None]) -> None:
        try:
            function()
        except Exception as error:  # 想定外の例外でも、実行ボタンが押せないまま残らないようにする。
            self.append_log(f"内部エラーのため中止しました（{type(error).__name__}: {error}）。")
            for job in (self.job, self.aux_job):
                if job is not None and job.current is None:
                    self.settle_job(job)

    # 「権限を確認」ボタン。
    def on_check_permissions_clicked(self, _button) -> None:
        self.guarded_call(self.check_permissions)

    # hub-permissions を実行し、結果で self.permission_entries と一覧の列を更新する。起動中は、読み取り専用の補助の操作として並行する。
    # after は、完了後（成功・失敗どちらでも）に呼ぶ続き（権限の切り替えの「まだ確認していなければ、先に確認する」のために使う）。
    def check_permissions(self, after: Callable[[], None] | None = None) -> None:
        busy = self.job is not None or self.aux_job is not None
        if busy and not self.auxiliary_allowed("hub-permissions"):
            if after is not None:
                after()
            return
        action, values = "hub-permissions", {}
        job = self.begin_aux_job(action, values) if busy else self.begin_job(action, values)
        finish = self.finish_aux_job if busy else self.finish_job

        # 権限を確認した結果を読み、一覧の列を更新してから、操作を終えて続きを呼ぶ。
        def on_done(code, output):
            if code != 0:
                self.append_log("権限を確認できなかったため、一覧の列はそのままにします。")
            else:
                entries, error = parse_hub_permissions_report(output)
                if entries is None:
                    self.append_log(f"権限を確認した結果を読めませんでした（{error}）。一覧の列はそのままにします。")
                else:
                    self.permission_entries = {entry["name"]: entry for entry in entries}
            finish()
            if after is not None:
                after()

        self.run_step(build_cli_arguments(self.help_data, action, values, set(), self.cli_options), on_done, capture=True, job=job)

    # 「ソースの読み取りを切り替え」ボタン。
    def on_toggle_source_read_clicked(self, _button) -> None:
        self.guarded_call(lambda: self.start_permission_toggle("source-read"))

    # 「Claude Code の起動を切り替え」ボタン。
    def on_toggle_claude_code_clicked(self, _button) -> None:
        self.guarded_call(lambda: self.start_permission_toggle("claude-code"))

    # 一覧で選んだプロジェクトの権限（ソースの読み取り・Claude Code の起動）を、いまと反対の値へ切り替える。
    # 未確認なら先に権限を確認してから続ける（選んだプロジェクトは確認の前に覚えておき、確認のあとに一覧の選択が変わっていても使う）。
    def start_permission_toggle(self, option: str) -> None:
        if self.job is not None or self.aux_job is not None:
            return
        project = self.selected_hub_project()
        if project is None:
            self.show_message("切り替えるプロジェクトを、一覧で選んでください。")
            return
        if project.approval_problem is not None or project.profile is None:
            self.show_message(f"このプロジェクトは承認状態を確かめられないため、この画面からは切り替えません: {project.approval_problem or '承認ファイルの場所を確かめられません。'}")
            return

        # 権限が確認できていれば切り替えへ進み、まだ確認できていなければ確認してから続ける（2 回目でも確認できなければ理由を出して終える）。
        def proceed(checked: bool) -> None:
            entry = self.permission_entries.get(project.name)
            if entry is None:
                if checked:
                    self.show_message(f"{project.name} の権限を確認できなかったため、切り替えません。「権限を確認」を押して理由を確かめてください。")
                    return
                self.append_log(f"{project.name} の権限をまだ確認していないため、先に「権限を確認」を行います。")
                self.check_permissions(lambda: proceed(True))
                return
            if entry.get("error"):
                self.show_message(f"{project.name} は権限を確認できないため、この画面からは切り替えません: {entry['error']}")
                return
            self.run_permission_toggle(project, option, entry)

        proceed(False)

    # 選んだプロジェクトの権限（確認できたもの）を、いまと反対の値へ実際に切り替える: 確認（指紋なしの set-permission）→ 承認ダイアログ → 書き込み（指紋付き）→ 権限を確認し直す。
    def run_permission_toggle(self, project: HubProject, option: str, entry: dict) -> None:
        current = entry.get(PERMISSION_STATE_FIELDS[option])  # いまの値（呼び出し元で error を除いているので、確認できなかった null はここには来ない）。
        new_value = toggled_permission_value(current)
        label = PERMISSION_OPTION_LABELS[option]
        values = {"project-root": project.root, "profile": project.profile, option: new_value}
        self.append_log(f"{project.name} の「{label}」を {current or '不明'} から {new_value} へ切り替えます。")
        self.begin_job("set-permission", values)

        # 指紋なしの set-permission（確認だけ）の結果を読み、承認ダイアログを経て書き込む。
        def after_check(code, output):
            if self.stopped():
                return
            if code != 0:
                self.append_log("公開範囲を確認できなかったため、中止しました。")
                self.finish_job()
                return
            report, error = parse_exposure_report(output)
            if report is None or not exposure_report_matches(report, project.root, project.profile):
                self.append_log(f"公開範囲の確認結果を、選んだプロジェクトと一致させられなかったため中止しました（{error or '内容が一致しません。'}）。")
                self.append_log("\n".join(raw_output_lines(output)))
                self.finish_job()
                return
            if not approval_needed(report):
                self.append_log(f"{label} はすでに同じ内容です。変更はありません。")
                self.finish_job()
                return
            grant = self.ask_approval(report, None, project.root, project.profile, extra_note=PERMISSION_TOGGLE_NOTE)
            if grant is None:
                self.append_log("承認されなかったため、何も変更しませんでした。")
                self.finish_job()
                return
            arguments = build_cli_arguments(self.help_data, "set-permission", values, set(), self.cli_options, grant)
            self.run_step(arguments, lambda _code, _output: self.finish_permission_toggle())

        self.run_step(build_cli_arguments(self.help_data, "set-permission", values, set(), self.cli_options), after_check, capture=True)

    # 権限の切り替えの書き込みが終わったら、操作を終えて、権限を確認し直して一覧の列を更新する（操作の終了時の自動の呼び直し）。
    def finish_permission_toggle(self) -> None:
        self.finish_job()
        self.check_permissions()

    # 停止ボタン: 従来方式の start は SIGTERM（プロセスグループ）、ハブ系は hub-stop を実行する。
    def on_stop_clicked(self, _button, action: str) -> None:
        job = self.job  # 止める操作。
        if job is None or job.action != action or job.stop_requested:
            return
        job.stop_requested = True
        self.update_buttons()
        child = job.current  # いま動いている子プロセス。
        if action in HUB_STOP_ACTIONS and job.final_started:
            arguments = build_hub_stop_arguments(self.help_data, self.cli_options, job.values.get("tunnel-client-path"))  # hub-stop の引数配列（起動に使った Tunnel Client の場所を渡す）。
            self.append_log("ハブを止めます（hub-stop を実行します）。")
            self.set_command_display(display_command(arguments))
            self.append_log("$ " + display_command(arguments))

            # hub-stop の終了を受け取り、起動の処理が残っていれば SIGTERM を送る。
            def after_stop(code, _output):
                for line in exit_code_lines(code, False):
                    self.append_log(line)
                job.stopper = None
                self.call_later(3000, terminate_if_running)

            # hub-stop のあとも起動の処理が続いていれば、プロセスグループへ SIGTERM を送る。
            def terminate_if_running():
                if child is not None and child.running():
                    self.append_log("hub-stop のあとも起動の処理が続いているため、終了の合図（SIGTERM）を送ります。")
                    child.terminate(signal.SIGTERM)

            stopper = self.child_factory(arguments, child_environment(self.environment), self.append_log, after_stop, False)
            job.stopper = stopper
            try:
                stopper.start()
            except (OSError, ValueError) as error:
                self.append_log(f"hub-stop を起動できませんでした: {error}")
                job.stopper = None
                terminate_if_running()
        elif child is not None:
            self.append_log("終了の合図（SIGTERM）を送ります。")
            child.terminate(signal.SIGTERM)

    # Runtime API Key を入力する操作を、別の端末窓で CLI に実行させる。キーはこの画面を通らない。
    def open_terminal(self, cli_arguments: list[str]) -> bool:
        self.set_command_display("（端末窓で実行）" + display_command(cli_arguments))
        found = find_terminal(self.which, self.environment)
        if found is None:
            self.append_log("端末が見つかりませんでした。表示したコマンドを、端末に貼り付けて実行してください。")
            self.show_copyable_command(terminal_missing_message(cli_arguments), display_command(cli_arguments))
            return False
        name, path = found
        command = terminal_command(name, path, helper_arguments(cli_arguments))  # 端末を開く引数配列。
        try:
            process = self.terminal_popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=child_environment(self.environment), cwd=working_directory(self.environment), start_new_session=True)
        except (OSError, ValueError) as error:
            self.append_log(f"端末（{path}）を起動できませんでした: {error}")
            self.show_copyable_command(terminal_missing_message(cli_arguments), display_command(cli_arguments))
            return False
        threading.Thread(target=process.wait, daemon=True).start()  # 端末の終了を回収する（結果は端末の中に出る）。
        self.append_log(f"端末: {path}")
        self.append_log("$ " + display_command(cli_arguments))
        self.append_log(TERMINAL_OPENED_MESSAGE)
        return True

    # ---- 終了 ----

    # 実行中の子プロセス（とそのプロセスグループの孫）を止める。SIGTERM のあと最大 5 秒待ち、グループに残っていれば SIGKILL を送る。
    def terminate_children(self) -> None:
        jobs = [job for job in (self.job, self.aux_job) if job is not None]  # 本体と補助の操作。
        children = [item for job in jobs for item in (job.current, job.stopper) if item is not None]  # 止める子プロセス。
        stop_process_groups(children)

    # ウィンドウを閉じる前に、実行中の子プロセス（本体と補助の両方）があれば確かめてから止める。閉じないときは True を返す。
    def on_delete_event(self, _window=None, _event=None) -> bool:
        jobs = [job for job in (self.job, self.aux_job) if job is not None]  # 実行中の操作。
        if not jobs:
            return False
        labels = "、".join(f"「{self.help_data['actions'].get(job.action, {}).get('label', job.action)}」" for job in jobs)  # 実行中の操作の名前。
        if self.job is not None and self.job.action in STOPPABLE_ACTIONS:
            message = f"{CLOSE_FOREGROUND_MESSAGE}\n（実行中 {len(jobs)} 件: {labels}）"
        else:
            message = f"実行中の処理（{labels}）が止まります。閉じますか?"
        if not self.ask_close(message):
            return True
        self.terminate_children()
        return False

    # ウィンドウが壊されたら、稼働表示の繰り返しタイマーを止めてから、メインループを終える。
    def on_window_destroy(self, _window=None) -> None:
        self.stop_hub_timer()
        Gtk.main_quit()

    # 本番のウィンドウを作って表示し、稼働表示の繰り返しタイマーを始める（タイマーは、ウィンドウの destroy で止める）。
    def open_window(self) -> None:
        self.window = Gtk.Window(title="ChatGPT Project Bridge 管理画面")
        self.window.set_default_size(1100, 860)
        self.window.add(self.root_widget)
        self.window.connect("delete-event", self.on_delete_event)
        self.window.connect("destroy", self.on_window_destroy)
        self.stop_hub_timer()
        self.hub_timer = GLib.timeout_add_seconds(HUB_POLL_SECONDS, self.on_hub_timer)
        self.window.show_all()

    # ---- ダイアログ（本番用。試験では差し替える） ----

    # 上書き系のチェックの確認ダイアログを作る（表示はしない）。既定のボタンは「キャンセル」。
    def build_dangerous_dialog(self, option: str):
        title, body = dangerous_confirmation_text(self.help_data, option)
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.NONE, text=title)
        dialog.format_secondary_text(body)
        cancel = dialog.add_button("キャンセル", Gtk.ResponseType.CANCEL)
        accept = dialog.add_button("それでも有効にする", Gtk.ResponseType.ACCEPT)
        set_tooltip(cancel, plain_tooltip("有効にしません（チェックはオフに戻ります）。"))
        set_tooltip(accept, plain_tooltip("このカードの実行にだけ、この指定を付けます。設定は保存しません。"))
        dialog.set_default_response(Gtk.ResponseType.CANCEL)
        return dialog

    # 上書き系のチェックの確認ダイアログ。「それでも有効にする」を押したときだけ True。
    def dangerous_dialog(self, option: str) -> bool:
        dialog = self.build_dangerous_dialog(option)
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.ACCEPT

    # 承認ダイアログを作る（表示はしない）。中身は ApprovalPanel。
    def build_approval_dialog(self, report: dict, hub_warning: str | None, extra_note: str | None = None):
        dialog = Gtk.Dialog(title="公開範囲の承認", transient_for=self.window, modal=True)
        dialog.set_default_size(860, 700)
        panel = ApprovalPanel(report, hub_warning, dialog.response, extra_note)
        dialog.get_content_area().pack_start(panel.box, True, True, 0)
        return dialog, panel

    # 承認ダイアログ。詳細を末尾まで表示し、「内容を読みました」（と必要なら上書きの確認）を選んで「この内容で承認」を押したときだけ承認を返す。
    # extra_note は、呼び出し側が足す注記（2.8.0: 権限の切り替えなど）。
    def approval_dialog(self, report: dict, hub_warning: str | None, requested_root: str, requested_profile: str | None, extra_note: str | None = None) -> ApprovalGrant | None:
        dialog, panel = self.build_approval_dialog(report, hub_warning, extra_note)
        dialog.show_all()
        panel.cancel_button.set_can_default(True)
        panel.cancel_button.grab_default()
        panel.cancel_button.grab_focus()
        response = dialog.run()
        confirmed = response == Gtk.ResponseType.ACCEPT and panel.approvable()  # 利用者が承認したか。
        acknowledged = panel.override_acknowledged()  # 別のフォルダーの承認の上書きを確かめたか。
        dialog.destroy()
        return grant_from_confirmation(report, requested_root, requested_profile, confirmed, override_acknowledged=acknowledged)

    # お知らせのダイアログを作る（表示はしない）。
    def build_message_dialog(self, text: str):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.NONE, text=text)
        close = dialog.add_button("閉じる", Gtk.ResponseType.CLOSE)
        set_tooltip(close, plain_tooltip("このお知らせを閉じます。"))
        return dialog

    # お知らせのダイアログ。
    def message_dialog(self, text: str) -> None:
        dialog = self.build_message_dialog(text)
        dialog.run()
        dialog.destroy()

    # 閉じる前の確認ダイアログを作る（表示はしない）。既定のボタンは「キャンセル」。
    def build_close_dialog(self, text: str):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.NONE, text=text)
        cancel = dialog.add_button("キャンセル", Gtk.ResponseType.CANCEL)
        close = dialog.add_button("閉じる", Gtk.ResponseType.ACCEPT)
        set_tooltip(cancel, plain_tooltip("閉じずに戻ります。実行中の処理は続きます。"))
        set_tooltip(close, plain_tooltip("実行中の処理を止めて（SIGTERM）、画面を閉じます。"))
        dialog.set_default_response(Gtk.ResponseType.CANCEL)
        return dialog

    # 閉じる前の確認ダイアログ。「閉じる」を押したときだけ True。
    def close_dialog(self, text: str) -> bool:
        dialog = self.build_close_dialog(text)
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.ACCEPT

    # 端末が見つからないときの案内のダイアログを作る（表示はしない）。
    def build_copyable_command_dialog(self, message: str, command_text: str):
        dialog = Gtk.Dialog(title="端末が見つかりません", transient_for=self.window, modal=True)
        dialog.set_default_size(760, 320)
        view = Gtk.TextView(editable=False, monospace=True, wrap_mode=Gtk.WrapMode.CHAR)
        view.get_buffer().set_text(message)
        set_tooltip(view, plain_tooltip("案内と、端末に貼り付けるコマンドです。文字を選んでコピーできます。"))
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(220)
        scrolled.add(view)
        dialog.get_content_area().pack_start(scrolled, True, True, 0)
        copy_button = Gtk.Button(label="コマンドをコピー")
        set_tooltip(copy_button, plain_tooltip("端末に貼り付けるコマンドだけを、クリップボードへコピーします。"))
        copy_button.connect("clicked", lambda _button: self.copy_to_clipboard(command_text))
        dialog.get_content_area().pack_start(copy_button, False, False, 0)
        close = dialog.add_button("閉じる", Gtk.ResponseType.CLOSE)
        set_tooltip(close, plain_tooltip("この案内を閉じます。"))
        return dialog

    # 端末が見つからないときに、コピーできる形でコマンドを見せるダイアログ。
    def copyable_command_dialog(self, message: str, command_text: str) -> None:
        dialog = self.build_copyable_command_dialog(message, command_text)
        dialog.show_all()
        dialog.run()
        dialog.destroy()


# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------


USAGE = """使い方:
  python3 project-bridge-gui.py
      ChatGPT Project Bridge 管理画面を開きます（python3-gi と gir1.2-gtk-3.0 が必要です）。
  （--terminal-helper は、画面が端末窓を開くときの内部用です）"""  # --help の表示。


# 起動の入口。端末窓のヘルパーか、画面を開くかを分ける。
def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)  # コマンドラインの引数。
    if arguments[:1] == ["--terminal-helper"]:
        return run_terminal_helper(arguments[1:])
    if arguments[:1] in (["-h"], ["--help"]):
        print(USAGE)
        return 0
    if arguments:
        print(f"ERROR: 未対応の引数です: {' '.join(arguments)}\n{USAGE}", file=sys.stderr)
        return 2
    if not sys.platform.startswith("linux"):
        print("ERROR: この画面は Ubuntu/Linux 専用です。Windows では project-bridge-gui.ps1 を使用してください。", file=sys.stderr)
        return 1
    try:
        import_gtk()
    except (ImportError, ValueError):
        print("ERROR: python3-gi と gir1.2-gtk-3.0 が必要です: sudo apt install python3-gi gir1.2-gtk-3.0", file=sys.stderr)
        return 1
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        print("ERROR: 画面の表示先（DISPLAY または WAYLAND_DISPLAY）がありません。デスクトップのセッションの中の端末から起動してください（SSH 接続だけでは開けません）。", file=sys.stderr)
        return 1
    if not Gtk.init_check(sys.argv[:1])[0]:
        print("ERROR: 画面の表示先に接続できませんでした。デスクトップのセッションの中の端末から起動してください。", file=sys.stderr)
        return 1
    try:
        help_data = load_help_data()
        cli_options = load_cli_option_names()
    except HelpDataError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    app = BridgeApp(help_data, cli_options, os.environ)
    app.open_window()
    # 端末の Ctrl+C・端末を閉じた（SIGHUP）・終了の合図（SIGTERM・SIGQUIT）でも、子プロセスを止めてから閉じる。
    install_signal_handlers(app.terminate_children, Gtk.main_quit)
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
