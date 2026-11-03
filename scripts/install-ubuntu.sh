#!/usr/bin/env bash
# Ubuntu LTSへ依存物・公式Tunnel Client・Skill・ランチャー・管理画面(GUI)のメニュー項目を1コマンドで導入する。
set -Eeuo pipefail

archive_name="chatgpt-project-bridge.tar.gz" # Bundle内の検証対象アーカイブ名。
local_bin="${HOME}/.local/bin" # PATHへ追加するユーザー専用実行ファイル配置先。
local_lib="${HOME}/.local/lib/chatgpt-project-bridge" # Node.js本体のユーザー専用配置先。
skill_target="${HOME}/.codex/skills/chatgpt-project-bridge" # Codexが探索するSkill導入先。
state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/chatgpt-project-bridge" # lockなどの非秘密状態配置先。
temp_dir="" # checksum検証前の一時ダウンロード先。
lock_dir="" # 同時インストールを拒否するmkdir lock。
lock_owned=0 # このprocessがlockを取得した場合だけcleanupで解除する。
verified=0 # 署名または指紋の照合済みとして実行前確認を省略するか。
curl_options=(--proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL) # HTTPS以外への接続とリダイレクトを拒否する取得設定。
pinned_tunnel_version="" # ロックで固定したTunnel Clientの版。
pinned_tunnel_name="" # ロックで固定したTunnel Clientのアセット名。
pinned_tunnel_url="" # ロックで固定したTunnel Clientの取得元。
pinned_tunnel_sha256="" # ロックで固定したTunnel ClientのSHA-256。
pinned_node_version="" # ロックで固定したNode.jsの版。
pinned_node_name="" # ロックで固定したNode.jsのアセット名。
pinned_node_url="" # ロックで固定したNode.jsの取得元。
pinned_node_sha256="" # ロックで固定したNode.jsのSHA-256。

# 引数を解釈する。--verified だけを受け付ける。
parse_arguments() {
  local argument
  for argument in "$@"; do
    case "${argument}" in
      --verified) verified=1 ;;
      *) printf 'ERROR: 未対応の引数です: %s\n' "${argument}" >&2; exit 1 ;;
    esac
  done
}

# 実行前に、署名または指紋を別経路の値と照合したことを利用者に確認する。
confirm_bundle_verified() {
  local bundle_dir sums answer
  bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  sums="${bundle_dir}/SHA256SUMS.txt"
  if [[ -f "${bundle_dir}/SHA256SUMS.txt.sig" ]]; then
    printf '署名ファイル SHA256SUMS.txt.sig があります。ssh-keygen -Y verify で検証済みであることを確認してください。\n'
  else
    printf '署名ファイルがありません。SHA256SUMS.txt の指紋を、Bundleとは別の経路で受け取った値と照合済みであることを確認してください。\n'
  fi
  if [[ -f "${sums}" ]] && command -v sha256sum >/dev/null 2>&1; then
    printf 'SHA256SUMS.txt の指紋: %s\n' "$(sha256sum "${sums}" | awk '{print $1}')"
  fi
  printf '（この表示はインストーラー自身が出しているため、改ざんされたBundleでは信用できません。照合は実行前に行ってください。）\n'
  ((verified == 0)) || return 0
  read -r -p '署名または指紋の照合は済みましたか? [yes/NO]: ' answer || answer=""
  case "${answer,,}" in
    yes|y) ;;
    *) printf 'ERROR: 照合が済んでいないため中止しました。手順書の「実行前の照合」を行ってから再実行してください。\n' >&2; exit 1 ;;
  esac
}

# Skillアーカイブも導入済みSkillも無いときの案内を出して終了する。Skillのソースの scripts から直接実行された場合は、Bundleの作り方を添える。
fail_missing_bundle() {
  local archive="$1" bundle_dir
  bundle_dir="$(dirname -- "${archive}")"
  printf 'ERROR: Bundle archiveがありません: %s\n' "${archive}" >&2
  printf 'このインストーラーは、export-bundle で作った Bundle の Ubuntu フォルダーの中で実行します（Bundle の中での名前は install.sh）。%s、SHA256SUMS.txt、VERSION.txt と同じフォルダーに置き、フォルダーごとコピーしてください。\n' "${archive_name}" >&2
  if [[ -f "${bundle_dir}/project-bridge.sh" ]]; then # 同じ場所にあれば、Skillのソースの scripts から実行されている。
    printf 'Skill のソースから導入する場合は、先に Bundle を作ります（出力先は Skill の外のフォルダー）:\n' >&2
    # ソースの project-bridge.sh には実行権が無いことがある（Bundle を展開したものにだけ付く）ので、bash で実行する形で案内する。
    printf '  bash %q export-bundle --output-path <出力先フォルダー>\n' "${bundle_dir}/project-bridge.sh" >&2
    printf 'その後、<出力先フォルダー>/Ubuntu で bash ./install.sh を実行します。\n' >&2
  fi
  exit 1
}

# 一時領域と自身が取得したlockだけを終了時に除去する。
cleanup() {
  [[ -z "${temp_dir}" || ! -d "${temp_dir}" ]] || rm -rf -- "${temp_dir}"
  ((lock_owned == 0)) || rmdir -- "${lock_dir}" 2>/dev/null || true
}
trap cleanup EXIT

# Ubuntu LTS版とCPUを明示的に制限する。
validate_platform() {
  [[ -r /etc/os-release ]] || { printf 'ERROR: /etc/os-releaseを読めません。\n' >&2; exit 1; }
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || { printf 'ERROR: Ubuntuだけをサポートします: %s\n' "${ID:-unknown}" >&2; exit 1; }
  case "${VERSION_ID:-}" in 22.04|24.04|26.04) ;; *) printf 'ERROR: Ubuntu LTS 22.04/24.04/26.04だけをサポートします: %s\n' "${VERSION_ID:-unknown}" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) printf 'ERROR: amd64/arm64だけをサポートします: %s\n' "$(uname -m)" >&2; exit 1 ;; esac
}

# 不足コマンドに対応するapt packageだけを導入する。
install_missing_dependencies() {
  local -a packages=()
  command -v curl >/dev/null 2>&1 || packages+=(curl)
  command -v python3 >/dev/null 2>&1 || packages+=(python3)
  command -v git >/dev/null 2>&1 || packages+=(git)
  command -v tar >/dev/null 2>&1 || packages+=(tar)
  command -v xz >/dev/null 2>&1 || packages+=(xz-utils)
  command -v sha256sum >/dev/null 2>&1 || packages+=(coreutils)
  command -v awk >/dev/null 2>&1 || packages+=(gawk)
  command -v grep >/dev/null 2>&1 || packages+=(grep)
  command -v find >/dev/null 2>&1 || packages+=(findutils)
  command -v install >/dev/null 2>&1 || packages+=(coreutils)
  command -v pgrep >/dev/null 2>&1 || packages+=(procps)
  [[ -r /etc/ssl/certs/ca-certificates.crt ]] || packages+=(ca-certificates)
  ((${#packages[@]} > 0)) || return 0
  mapfile -t packages < <(printf '%s\n' "${packages[@]}" | sort -u)
  local -a apt=(apt-get)
  if ((EUID != 0)); then
    command -v sudo >/dev/null 2>&1 || { printf 'ERROR: 不足packageの導入にはsudoが必要です: %s\n' "${packages[*]}" >&2; exit 1; }
    apt=(sudo apt-get)
  fi
  "${apt[@]}" update
  "${apt[@]}" install -y --no-install-recommends "${packages[@]}"
}

# unameの値をNode.js配布名へ変換する。
node_architecture() {
  case "$(uname -m)" in x86_64) printf '%s\n' 'x64' ;; aarch64|arm64) printf '%s\n' 'arm64' ;; esac
}

# unameの値をTunnel Client配布名へ変換する。
tunnel_architecture() {
  case "$(uname -m)" in x86_64) printf '%s\n' 'amd64' ;; aarch64|arm64) printf '%s\n' 'arm64' ;; esac
}

# 現在のNode.jsが18以上なら再導入しない。
node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  local version major
  version="$(node --version 2>/dev/null || true)"
  major="${version#v}"; major="${major%%.*}"
  [[ "${major}" =~ ^[0-9]+$ ]] && ((major >= 18))
}

# ロックで固定したNode.js LTSを、固定SHA-256を照合して導入する。既存のNode.js 18以上は維持する。
install_node() {
  if node_is_supported; then printf 'Node.jsは導入済みです: %s (%s)\n' "$(command -v node)" "$(node --version)"; return; fi
  local archive extracted
  archive="${pinned_node_name}"
  curl "${curl_options[@]}" "${pinned_node_url}" -o "${temp_dir}/${archive}"
  printf '%s  %s\n' "${pinned_node_sha256}" "${temp_dir}/${archive}" | sha256sum -c -
  mkdir -p -- "${local_lib}/node" "${local_bin}"
  tar -xJf "${temp_dir}/${archive}" -C "${local_lib}/node"
  extracted="${local_lib}/node/${archive%.tar.xz}"
  ln -sfn -- "${extracted}/bin/node" "${local_bin}/node"
  ln -sfn -- "${extracted}/bin/npm" "${local_bin}/npm"
  ln -sfn -- "${extracted}/bin/npx" "${local_bin}/npx"
  printf 'Node.js: %s (%s)\n' "${pinned_node_version}" "${local_bin}/node"
}

# 検証済みアーカイブ（無ければ導入済みSkill）の dependencies.lock.json から、このCPU向けの固定値を読む。
read_dependency_lock() {
  local archive="$1" node_arch tunnel_arch
  local -a values=()
  node_arch="$(node_architecture)"; tunnel_arch="$(tunnel_architecture)"
  # -I: 実行フォルダー（cwd）に置かれた json.py などのモジュールと PYTHON* 環境変数を読まない。
  mapfile -t values < <(python3 -I - "${archive}" "${skill_target}" "${node_arch}" "${tunnel_arch}" <<'PY'
import json
import re
import sys
import tarfile
from pathlib import Path

archive, skill_target, node_arch, tunnel_arch = sys.argv[1:5]
# アーカイブがあればその中の、無ければ導入済みSkillのロックを読む。
if archive:
    with tarfile.open(archive, "r:gz") as bundle:
        member = bundle.getmember("chatgpt-project-bridge/dependencies.lock.json")
        if not member.isfile():
            raise SystemExit("dependencies.lock.jsonが通常ファイルではありません")
        lock = json.load(bundle.extractfile(member))
else:
    lock = json.loads((Path(skill_target) / "dependencies.lock.json").read_text(encoding="utf-8"))
if lock.get("schemaVersion") != 1:
    raise SystemExit("dependencies.lock.jsonの版が不正です")
tunnel = lock["tunnelClient"]["assets"][f"linux-{tunnel_arch}"]
node = lock["node"]["assets"][f"linux-{node_arch}"]
checks = [
    (re.fullmatch(rf"tunnel-client-v[^/]+-linux-{re.escape(tunnel_arch)}\.zip", tunnel["name"]), "Tunnel Clientのアセット名"),
    (tunnel["url"] == f"https://github.com/openai/tunnel-client/releases/download/{lock['tunnelClient']['version']}/{tunnel['name']}", "Tunnel Clientの取得元"),
    (re.fullmatch(r"[0-9a-f]{64}", tunnel["sha256"]), "Tunnel ClientのSHA-256"),
    (re.fullmatch(r"v\d+\.\d+\.\d+", lock["node"]["version"]), "Node.jsの版"),
    (node["name"] == f"node-{lock['node']['version']}-linux-{node_arch}.tar.xz", "Node.jsのアセット名"),
    (node["url"] == f"https://nodejs.org/dist/{lock['node']['version']}/{node['name']}", "Node.jsの取得元"),
    (re.fullmatch(r"[0-9a-f]{64}", node["sha256"]), "Node.jsのSHA-256"),
]
for ok, label in checks:
    if not ok:
        raise SystemExit(f"dependencies.lock.jsonの{label}が不正です")
for value in (lock["tunnelClient"]["version"], tunnel["name"], tunnel["url"], tunnel["sha256"], lock["node"]["version"], node["name"], node["url"], node["sha256"]):
    print(value)
PY
)
  ((${#values[@]} == 8)) || { printf 'ERROR: dependencies.lock.jsonを読めません。\n' >&2; exit 1; }
  pinned_tunnel_version="${values[0]}"; pinned_tunnel_name="${values[1]}"; pinned_tunnel_url="${values[2]}"; pinned_tunnel_sha256="${values[3]}"
  pinned_node_version="${values[4]}"; pinned_node_name="${values[5]}"; pinned_node_url="${values[6]}"; pinned_node_sha256="${values[7]}"
}

# 管理スクリプトが利用するCLI引数が導入対象に残っていることを確認する。
verify_tunnel_client_compatibility() {
  local binary="$1" init_help run_help flag
  init_help="$("${binary}" init --help 2>&1)"
  run_help="$("${binary}" run --help 2>&1)"
  for flag in '--profile-dir' '--control-plane-api-key-ref'; do grep -Fq -- "${flag}" <<<"${init_help}" || { printf 'ERROR: Tunnel Client initに必要な引数がありません: %s\n' "${flag}" >&2; exit 1; }; done
  for flag in '--profile' '--pid.file' '--log.file' '--health.url-file'; do grep -Fq -- "${flag}" <<<"${run_help}" || { printf 'ERROR: Tunnel Client runに必要な引数がありません: %s\n' "${flag}" >&2; exit 1; }; done
}

# ロックで固定したTunnel Clientを、固定SHA-256とCLI互換性を検証してユーザー領域へ導入する。
install_tunnel_client() {
  local asset_name extract binary
  asset_name="${pinned_tunnel_name}"
  curl "${curl_options[@]}" "${pinned_tunnel_url}" -o "${temp_dir}/${asset_name}"
  printf '%s  %s\n' "${pinned_tunnel_sha256}" "${temp_dir}/${asset_name}" | sha256sum -c -
  extract="${temp_dir}/tunnel-client"; mkdir -p -- "${extract}" "${local_bin}"
  # -I: 実行フォルダー（cwd）に置かれた zipfile.py などのモジュールと PYTHON* 環境変数を読まない。
  python3 -I - "${temp_dir}/${asset_name}" "${extract}" <<'PY'
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

# 通常ファイルだけをarchive境界内へ展開する。
destination = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for member in archive.infolist():
        parts = PurePosixPath(member.filename).parts
        if member.is_dir() or not parts or member.filename.startswith("/") or ".." in parts or stat.S_ISLNK(member.external_attr >> 16):
            raise SystemExit(f"安全でないzip entryを拒否しました: {member.filename}")
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(member) as source, target.open("xb") as output:
            output.write(source.read())
PY
  binary="$(find "${extract}" -type f -name tunnel-client -print -quit)"
  [[ -n "${binary}" ]] || { printf 'ERROR: archive内にtunnel-clientがありません。\n' >&2; exit 1; }
  chmod +x -- "${binary}"; verify_tunnel_client_compatibility "${binary}"
  [[ ! -L "${local_bin}" && ! -L "${local_bin}/tunnel-client" ]] || { printf 'ERROR: Tunnel Client導入先にsymlinkは使用できません。\n' >&2; exit 1; }
  install -m 0755 -- "${binary}" "${local_bin}/tunnel-client"
  printf 'Tunnel Client: %s (SHA-256 %s)\n' "${pinned_tunnel_version}" "${pinned_tunnel_sha256}"
}

# Bundle自身のSHA256SUMSでSkill archiveを検証する。
verify_bundle_hash() {
  local archive="$1" sums expected actual
  sums="$(cd -- "$(dirname -- "${archive}")" && pwd -P)/SHA256SUMS.txt"
  [[ -f "${sums}" && ! -L "${sums}" ]] || { printf 'ERROR: SHA256SUMS.txtがありません: %s\n' "${sums}" >&2; exit 1; }
  expected="$(awk -v name="$(basename -- "${archive}")" '$2 == name || $2 == "*" name { print $1; exit }' "${sums}")"
  [[ -n "${expected}" ]] || { printf 'ERROR: Bundle hashを特定できません。\n' >&2; exit 1; }
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || { printf 'ERROR: BundleのSHA-256が一致しません。\n' >&2; exit 1; }
}

# tarとManifestを検証し、stage・timestamp backup・rollback付きでSkillを交換する。
install_skill_transactionally() {
  local archive="$1"
  # -I: 実行フォルダー（cwd）に置かれた tarfile.py などのモジュールと PYTHON* 環境変数を読まない。
  python3 -I - "${archive}" "${skill_target}" <<'PY'
import datetime
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

archive = Path(sys.argv[1]).resolve(strict=True)
target = Path(sys.argv[2]).expanduser()
parent = target.parent
parent.mkdir(parents=True, exist_ok=True)

# 導入先の既存経路にsymlinkを含めない。
cursor = Path(parent.anchor or "/")
for part in parent.parts[1:]:
    cursor /= part
    if cursor.is_symlink():
        raise SystemExit(f"Skill導入経路にsymlinkは使用できません: {cursor}")
if target.is_symlink():
    raise SystemExit(f"既存Skillにsymlinkは使用できません: {target}")

stage = Path(tempfile.mkdtemp(prefix=".chatgpt-project-bridge.stage.", dir=parent))
backup = None
try:
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        relative_members = {}
        for member in members:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2 or parts[0] != "chatgpt-project-bridge" or ".." in parts or not member.isfile():
                raise SystemExit(f"安全でないtar entryを拒否しました: {member.name}")
            relative = "/".join(parts[1:])
            if relative in relative_members:
                raise SystemExit(f"重複tar entryを拒否しました: {relative}")
            relative_members[relative] = member
        manifest_member = relative_members.get("distribution.json")
        if manifest_member is None:
            raise SystemExit("distribution.jsonがありません")
        manifest = json.load(bundle.extractfile(manifest_member))
        if manifest.get("schemaVersion") != 1 or not manifest.get("version"):
            raise SystemExit("distribution.jsonの版が不正です")
        expected = {item["path"]: int(item["mode"], 8) for item in manifest.get("files", [])}
        if set(expected) != set(relative_members):
            raise SystemExit("tarのファイル一覧がdistribution.jsonと一致しません")
        for relative, mode in expected.items():
            member = relative_members[relative]
            if stat.S_IMODE(member.mode) != mode:
                raise SystemExit(f"tar entry modeがmanifestと一致しません: {relative}")
            destination = stage.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
            os.chmod(destination, mode)
    if target.exists():
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = Path(f"{target}.backup.{stamp}")
        if backup.exists():
            raise SystemExit(f"backup先が既にあります: {backup}")
        os.replace(target, backup)
    os.replace(stage, target)
except BaseException:
    if not target.exists() and backup is not None and backup.exists():
        os.replace(backup, target)
    raise
finally:
    if stage.exists():
        shutil.rmtree(stage)
PY
}

# ~/.profileの管理markerを重複なく更新する。
install_profile_marker() {
  local profile="${HOME}/.profile" begin='# >>> chatgpt-project-bridge PATH >>>' end='# <<< chatgpt-project-bridge PATH <<<'
  local begin_count end_count
  [[ ! -L "${profile}" ]] || { printf 'ERROR: ~/.profileがsymlinkのため自動更新を拒否しました。\n' >&2; exit 1; }
  touch -- "${profile}"
  begin_count="$(grep -Fc -- "${begin}" "${profile}" || true)"
  end_count="$(grep -Fc -- "${end}" "${profile}" || true)"
  if [[ "${begin_count}" != "${end_count}" || "${begin_count}" -gt 1 ]]; then
    printf 'ERROR: ~/.profileの管理markerが不完全または重複しています。手動確認してください。\n' >&2; exit 1
  fi
  if [[ "${begin_count}" == "0" ]]; then
    printf '\n%s\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n%s\n' "${begin}" "${end}" >>"${profile}"
  fi
}

# Skillを絶対パスで呼ぶ4つのランチャー（CLI 3本と管理画面(GUI) 1本）を作る。
install_launchers() {
  mkdir -p -- "${local_bin}"
  printf '%s\n' '#!/usr/bin/env bash' 'exec python3 -u "$HOME/.codex/skills/chatgpt-project-bridge/scripts/project-bridge.py" "$@"' >"${local_bin}/chatgpt-project-bridge"
  printf '%s\n' '#!/usr/bin/env bash' 'exec python3 -u "$HOME/.codex/skills/chatgpt-project-bridge/scripts/project-bridge.py" add-project "$@"' >"${local_bin}/chatgpt-project-add"
  printf '%s\n' '#!/usr/bin/env bash' 'exec python3 -u "$HOME/.codex/skills/chatgpt-project-bridge/scripts/project-bridge.py" hub-add "$@"' >"${local_bin}/chatgpt-hub-add"
  printf '%s\n' '#!/usr/bin/env bash' 'exec python3 "$HOME/.codex/skills/chatgpt-project-bridge/scripts/project-bridge-gui.py" "$@"' >"${local_bin}/chatgpt-project-bridge-gui"
  chmod 0755 -- "${local_bin}/chatgpt-project-bridge" "${local_bin}/chatgpt-project-add" "${local_bin}/chatgpt-hub-add" "${local_bin}/chatgpt-project-bridge-gui"
}

# freedesktopのExec規則に従い、値を二重引用符で囲んで返す。
# 引用内の \ " ` $ はバックスラッシュで退避する。.desktopの文字列規則で退避の \ も二重になる（\ 自身は4個）。% は %% にする。
quote_desktop_exec() {
  local value="$1" escaped
  escaped="$(printf '%s' "${value}" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')"
  printf '"%s"' "${escaped}"
}

# 管理画面(GUI)をアプリメニューから起動するデスクトップエントリを作る。再実行では同じ内容で上書きする。
# XDG_DATA_HOME は絶対パスのときだけ使う（相対パスは仕様上無効なので無視する）。一時ファイルからmvで置き換える。
# 置き場かエントリがsymlink（dotfiles管理など）なら、リンク先へ書かないようメニュー項目だけを作らずに飛ばし、導入の残りは続ける。
install_desktop_entry() {
  local data_home="${XDG_DATA_HOME:-}" # ユーザー専用データの置き場。
  [[ "${data_home}" == /* ]] || data_home="${HOME}/.local/share"
  local applications_dir="${data_home}/applications" # ユーザー専用のメニュー項目置き場。
  local desktop_file="${applications_dir}/chatgpt-project-bridge.desktop" # 管理画面のデスクトップエントリ。
  local launcher="${local_bin}/chatgpt-project-bridge-gui" # Execに入れるランチャーの絶対パス。
  local temporary_file # 書き終えてから置き換えるための一時ファイル。
  if [[ "${launcher}" =~ [[:cntrl:]] ]]; then
    printf 'WARN: ランチャーのパスに制御文字があるため、メニュー項目は作りません: %s\n' "${launcher}" >&2
    return 0
  fi
  if [[ -L "${applications_dir}" || -L "${desktop_file}" ]]; then
    printf 'WARN: メニュー項目（.desktop）は作成しません: 置き場またはエントリがsymlinkです: %s\n' "${applications_dir}" >&2
    return 0
  fi
  mkdir -p -- "${applications_dir}"
  if [[ -L "${applications_dir}" || -L "${desktop_file}" ]]; then # mkdir の間に差し替えられた場合も、リンク先へは書かない。
    printf 'WARN: メニュー項目（.desktop）は作成しません: 置き場またはエントリがsymlinkです: %s\n' "${applications_dir}" >&2
    return 0
  fi
  temporary_file="$(mktemp -- "${applications_dir}/.chatgpt-project-bridge.desktop.XXXXXX")"
  {
    printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=ChatGPT Project Bridge 管理画面'
    printf '%s\n' 'Comment=ChatGPT へのプロジェクト公開の設定と起動（マウスオーバーで説明が出ます）'
    printf 'Exec=%s\n' "$(quote_desktop_exec "${launcher}")"
    printf '%s\n' 'Terminal=false' 'Categories=Utility;' 'Icon=network-server' 'StartupNotify=true'
  } >"${temporary_file}" || { rm -f -- "${temporary_file}"; printf 'ERROR: メニュー項目を書き込めません: %s\n' "${desktop_file}" >&2; exit 1; }
  chmod 0644 -- "${temporary_file}" || { rm -f -- "${temporary_file}"; exit 1; }
  mv -f -- "${temporary_file}" "${desktop_file}" || { rm -f -- "${temporary_file}"; exit 1; }
}

# 管理画面(GUI)の依存（python3-gi と GTK 3）を確認する。足りなくても導入は失敗させず、案内だけ出す（自動ではaptしない）。
# cwd を / にして実行フォルダー（Bundle）に置かれた gi.py などを読まず、-E で PYTHON* 環境変数も無視する。
# -I と違って利用者のsite-packages（pip --user で入れた gi）は見える。サブシェルの失敗は if の条件の中なので、set -e でも止まらない。
check_gui_dependencies() {
  if ! (cd / && python3 -E -c 'import gi; gi.require_version("Gtk", "3.0")') >/dev/null 2>&1; then
    printf 'WARN: 管理画面（GUI）を使うには python3-gi と gir1.2-gtk-3.0 が必要です: sudo apt install python3-gi gir1.2-gtk-3.0\n' >&2
  fi
}

# ハブの自動起動（systemdユーザーサービス）とlingerの状態を読み取りだけで案内する。ここでは登録・有効化はしない。
# systemctl/loginctlが無い環境では、その案内を省く（set -eでも止まらないよう、失敗するコマンドは || true で受ける）。
show_autostart_status() {
  local unit_name="chatgpt-project-bridge-hub.service" unit_path state linger user
  unit_path="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${unit_name}"
  if [[ ! -f "${unit_path}" ]]; then
    printf '自動起動（ハブの再起動後の起動）は未登録です。登録するには: chatgpt-project-bridge hub-service-install\n'
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    state="$(systemctl --user is-enabled "${unit_name}" 2>/dev/null || true)"
    [[ "${state}" == "enabled" ]] || printf '自動起動が有効になっていません（%s）。有効化するには: chatgpt-project-bridge hub-service-install\n' "${state:-不明}"
  fi
  if command -v loginctl >/dev/null 2>&1; then
    user="$(id -un)"
    linger="$(loginctl show-user "${user}" -p Linger --value 2>/dev/null || true)"
    [[ "${linger}" == "yes" ]] || printf 'lingerが無効です。ログインしていないときはハブが動きません。有効化するには: sudo loginctl enable-linger %s\n' "${user}"
  fi
}

parse_arguments "$@"
validate_platform
# 照合を尋ねる前に、導入元（同梱のSkillアーカイブ、無ければ導入済みSkill）があることを確かめる。無ければ照合する対象も無いので、尋ねずに案内して止める。
bundle_archive="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/${archive_name}" # 同梱Skillアーカイブ。
[[ ( -f "${bundle_archive}" && ! -L "${bundle_archive}" ) || -d "${skill_target}" ]] || fail_missing_bundle "${bundle_archive}"
confirm_bundle_verified
install_missing_dependencies
if pgrep -f '[t]unnel-client.*[[:space:]]run' >/dev/null 2>&1; then printf 'ERROR: Tunnel Client実行中はインストールできません。停止してください。\n' >&2; exit 1; fi
mkdir -p -- "${state_root}"
lock_dir="${state_root}/install.lock"
mkdir -- "${lock_dir}" 2>/dev/null || { printf 'ERROR: 別のインストールが実行中です: %s\n' "${lock_dir}" >&2; exit 1; }
lock_owned=1
temp_dir="$(mktemp -d -t chatgpt-project-bridge.XXXXXX)"

# 依存物を取得する前にBundleを照合し、固定された版とハッシュを読む。
has_bundle_archive=0 # アーカイブから導入するか。
if [[ -f "${bundle_archive}" && ! -L "${bundle_archive}" ]]; then
  verify_bundle_hash "${bundle_archive}"
  has_bundle_archive=1
  read_dependency_lock "${bundle_archive}"
elif [[ -d "${skill_target}" ]]; then
  read_dependency_lock ""
else
  fail_missing_bundle "${bundle_archive}"
fi

mkdir -p -- "${local_bin}"
export PATH="${local_bin}:${PATH}"
install_node
hash -r
install_tunnel_client
((has_bundle_archive == 0)) || install_skill_transactionally "${bundle_archive}"
install_launchers
install_desktop_entry
check_gui_dependencies
install_profile_marker

printf 'ChatGPT Project Bridgeのインストールが完了しました。\n'
printf '新しい端末で実行: chatgpt-project-add\n'
show_autostart_status
