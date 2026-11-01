#!/bin/sh
# Installs the T3 Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://t3.codes/install.sh | sh
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `t3 service install` uses, so the service reuses this download
# instead of fetching the release again.
# The `t3` symlink points at $T3CODE_HOME/runtime/versions/current/t3, which
# points at that version, so upgrades never replace a file in the bin folder.
set -eu

repo="pingdotgg/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
# Trailing slashes would put `//` in the paths the t3 command guard compares.
while [ "${t3_home%/}" != "$t3_home" ] && [ "$t3_home" != / ]; do t3_home="${t3_home%/}"; done
while [ "${bin_dir%/}" != "$bin_dir" ] && [ "$bin_dir" != / ]; do bin_dir="${bin_dir%/}"; done
# Absolute, so the PATH hint never adds a folder that changes with the working directory.
case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac

fail() {
  printf '\nt3 install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       T3 Code' >&2
  printf '  %s%s     %sCLI installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
if [ "${platform}-${arch}" = darwin-x64 ]; then
  fail "there is no t3 CLI for Intel Macs. Install the desktop app from https://t3.codes/download, or run a server from source: https://github.com/${repo}/blob/main/docs/user/install.md#intel-macs"
fi
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  if [ "$channel" = stable ]; then
    # release.yml marks only plain stable releases latest. This is a github.com
    # page, so it is not cut off by a page of newer nightlies or the API quota.
    fetch "https://github.com/${repo}/releases/latest" "$tmp_index" application/json
    version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  else
    page=1
    while [ -z "$version" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$tmp_index"
      version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
      grep -q '"tag_name"' "$tmp_index" || break
      page=$((page + 1))
    done
  fi
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "t3 ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

# A path as Node's path.resolve spells it: absolute against the real working folder, with `.`,
# `..`, and `//` collapsed as text, keeping the names of symlinked folders.
resolve_path() (
  # The x keeps a trailing newline in the working folder's name, which $(...) would drop.
  case "$1" in
    /*) rest="$1" ;;
    *) rest="$(pwd -P && echo x)" && rest="${rest%"
x"}/$1" ;;
  esac
  out=
  IFS=/
  set -f
  for part in $rest; do
    case "$part" in "" | .) ;; ..) out="${out%/*}" ;; *) out="$out/$part" ;; esac
  done
  printf '%s' "${out:-/}"
)
# Spelled as every t3 spells its T3 home, so released t3 still owns the links made from it.
# Like the CLI, a quoted ~ at the start means the home folder.
# shellcheck disable=SC2088 # The ~ here is the literal text to expand.
case "$t3_home" in "~") t3_home="$HOME" ;; "~/"*) t3_home="${HOME}/${t3_home#"~/"}" ;; esac
# The x keeps a trailing newline in the name, which $(...) would drop.
t3_home="$(resolve_path "$t3_home" && echo x)"
t3_home="${t3_home%x}"
stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s T3 Code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "t3 ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g t3@${version}\`"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "t3 ${version} has no release archive for ${platform}-${arch}"
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting T3 Code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the t3 command..."
mkdir -p "$bin_dir"
public="${bin_dir}/t3"
# The t3 command links to this home's command link, and upgrades switch only that one. Other
# programs write to bin_dir too, so the public name is never replaced while it may be theirs.
# In versions, so a t3 from before it still updates and uninstalls the command.
current_dir="${versions_dir}/current"
command_link="${current_dir}/t3"
# Inside the T3 home, so swapping it in place cannot replace another program's file. Still,
# only a link in a real folder is ever replaced there; mv would move into a folder.
if [ -L "$current_dir" ] || { [ -e "$current_dir" ] && [ ! -d "$current_dir" ]; }; then
  fail "${current_dir} is not a folder. Remove it and run this again."
fi
mkdir -p "$current_dir"
if [ -d "$command_link" ] || { [ -e "$command_link" ] && [ ! -L "$command_link" ]; }; then
  fail "${command_link} is not a link to a file. Remove it and run this again."
fi
newline="
"
# Sets real to folder $1's real path, keeping a trailing newline that $(...) would drop.
real_dir() {
  real="$(CDPATH='' cd -P -- "$1" 2>/dev/null && pwd && echo x)" || return 1
  real="${real%"${newline}x"}"
}
real_dir "$versions_dir" || fail "could not read ${versions_dir}"
real_versions_dir="$real"
real_dir "$current_dir" || fail "could not read ${current_dir}"
real_command_link="${real}/t3"
# Exactly <versions>/<version>/t3 ($1 under $2), never another program inside a version.
version_t3() {
  case "$1" in "$2"/*) ;; *) return 1 ;; esac
  case "${1#"$2"/}" in */*/*) return 1 ;; */t3) return 0 ;; *) return 1 ;; esac
}
# Its bin folder may be a link, or missing until the app runs.
real_dir "$t3_home" || fail "could not read ${t3_home}"
real_desktop_launcher="${real}/bin/t3"
if real_dir "${t3_home}/bin"; then real_desktop_launcher="${real}/t3"; fi
real_dir "$bin_dir" || fail "could not read ${bin_dir}"
real_bin_dir="$real"
# The desktop app's launcher carries its marker; a linked bin folder could hold a user's own t3.
desktop_launcher() {
  # The app writes a file; a link there leads to another home's or another tool's t3.
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(wc -c < "$1")" -le 16384 ] &&
    grep -qF "Written by T3 Code: runs the desktop app's bundled t3 CLI." "$1"
}
# Prints what the link at $1 is to this home: current (its command link), older (a version's t3
# or the desktop app's launcher), or nothing. Anything that is not a symlink is someone else's.
link_kind() {
  [ -L "$1" ] || return 0
  # The x keeps a trailing newline in the target, which $(...) would drop.
  existing="$(readlink "$1" 2>/dev/null && echo x)" || return 0
  existing="${existing%x}"
  existing="${existing%"$newline"}"
  # `..` can mean another folder once a link is followed, and a target naming a folder (`t3/`,
  # `t3/.`) never runs the file it would resolve to. `//` and `/./` collapse as text.
  case "/${existing}/" in */../*) return 0 ;; esac
  # A trailing newline would be lost in $(...) below, so such a target could pass as ours.
  case "$existing" in */ | */. | . | *"$newline") return 0 ;; esac
  # A relative target starts from the bin folder's real path, as the OS follows it.
  case "$existing" in /*) ;; *) existing="${real_bin_dir}/${existing}" ;; esac
  existing="$(resolve_path "$existing")"
  # The desktop app writes this exact path, also when the home's bin folder is a link.
  if [ "$existing" = "${t3_home}/bin/t3" ] && desktop_launcher "$existing"; then echo older; return 0; fi
  # A folder that is itself a link (another versions/<name>) is not followed.
  folder="${existing%/*}"
  [ -n "$folder" ] || folder=/
  [ ! -L "$folder" ] || return 0
  # Resolved on disk, which sees through a symlinked T3 home.
  if real_dir "$folder"; then
    real_existing="${real}/${existing##*/}"
    if [ "$real_existing" = "$real_command_link" ]; then echo current
    elif version_t3 "$real_existing" "$real_versions_dir" ||
      { [ "$real_existing" = "$real_desktop_launcher" ] && desktop_launcher "$real_existing"; }; then
      echo older
    fi
    return 0
  fi
  # Only a missing folder (a pruned version) leaves the text. A folder that cannot be resolved for
  # another reason may be another program's.
  [ ! -e "$folder" ] || return 0
  parent="${folder%/*}"
  real_dir "${parent:-/}" || return 0
  real_existing="${real}/${folder##*/}/${existing##*/}"
  if version_t3 "$real_existing" "$real_versions_dir"; then echo older; fi
}
kind=
real_public="${real_bin_dir}/t3"
# The command link is replaced in place, which is safe only away from the public name. -ef
# compares device and inode, so an alias or a bind mount of its folder counts too.
if [ "$real_public" = "$real_command_link" ] || [ "$bin_dir" -ef "$current_dir" ]; then
  fail "T3CODE_INSTALL_BIN_DIR cannot be ${current_dir}. Choose another folder."
fi
if [ -e "$public" ] || [ -L "$public" ]; then
  kind="$(link_kind "$public")"
  [ -n "$kind" ] || fail "another t3 is already at ${public}. Remove it and run this again, or run ${target_dir}/t3 directly."
fi
# Made in a new folder of its own, so nothing already in current is reused or removed, and moved
# into current, so a link that replaced current/t3 is replaced itself, never followed.
switch_command_link() {
  staging_dir="$(mktemp -d "${current_dir}/.t3.XXXXXX")" || fail "could not link ${command_link}"
  if ! { ln -s "${target_dir}/t3" "${staging_dir}/t3" && mv -f "${staging_dir}/t3" "${current_dir}/"; }; then
    rm -f "${staging_dir}/t3"
    rmdir "$staging_dir"
    fail "could not link ${command_link}"
  fi
  rmdir "$staging_dir"
}
# Checked before the home's command switches, so a bin folder that cannot be written changes nothing.
[ -w "$bin_dir" ] || fail "cannot write to ${bin_dir}"
# The home's command switches first: if the public link then fails, the home runs the version asked
# for and only the public link is missing, never a third version.
switch_command_link
case "$kind" in
  # An empty spot is linked without -f, so a file that appears after the check above is kept.
  # Into the folder, so an entry of any kind already named t3 makes ln fail instead of filling it.
  # A concurrent install may have made the same link a moment ago.
  "") ln -s "$command_link" "${bin_dir}/" || [ "$(link_kind "$public")" = current ] ||
    fail "could not link ${public}; something else was created there." ;;
  older)
    # Moved aside before it is checked again, so the check sees exactly what gets replaced. A new
    # folder of its own, so nothing left by an earlier install is replaced; the entry keeps its
    # name t3, so it goes back with `ln -P ... "${bin_dir}/"`, which never overwrites anything.
    aside_dir="$(mktemp -d "${bin_dir}/.t3.XXXXXX")" || fail "could not replace ${public}"
    # BusyBox ln has no -P; its plain ln links a symlink itself, as Linux link() does.
    put_back() { ln -P "$aside" "${bin_dir}/" 2>/dev/null || ln "$aside" "${bin_dir}/" 2>/dev/null; }
    aside="${aside_dir}/t3"
    # Not stopped between moving the old link aside and putting a link back, so a cancelled
    # install never leaves the name empty.
    trap '' INT TERM HUP
    mv "$public" "$aside" || { rmdir "$aside_dir"; fail "could not replace ${public}"; }
    if [ -n "$(link_kind "$aside")" ]; then
      if ! ln -s "$command_link" "${bin_dir}/"; then
        # Keep the working old command when the name is still free; if it cannot go back, it stays.
        put_back ||
          fail "could not link ${public}; the old link is at ${aside}."
        rm -f "$aside" && rmdir "$aside_dir"
        fail "could not link ${public}"
      fi
      rm -f "$aside" && rmdir "$aside_dir"
      trap - INT TERM HUP
    else
      # Another program wrote it after the check: put it back without overwriting anything newer.
      # A folder cannot be hard linked; it stays where it is, and the message says where.
      put_back ||
        fail "another program wrote ${public} during the install; it is now at ${aside}."
      rm -f "$aside" && rmdir "$aside_dir"
      fail "another t3 was just written at ${public}. Remove it and run this again, or run ${target_dir}/t3 directly."
    fi
    ;;
esac
# Pruning keeps what this launcher points at; a background service cannot see bin_dir otherwise.
launchers="${t3_home}/runtime/launchers"
grep -qxF "$real_public" "$launchers" 2>/dev/null || printf '%s\n' "$real_public" >> "$launchers"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled T3 Code %s%s\n\n' "$green" "$version" "$reset" >&2
# The folder a shell reads its startup file from: $1 when set and safe to paste, else $2 when
# unset. A set but unsafe folder prints nothing, since the default would never be read.
read_from() {
  case "$1" in
    "") printf '%s' "$2" ;;
    /*) case "$1" in *[!A-Za-z0-9_./-]*) ;; *) printf '%s' "$1" ;; esac ;;
  esac
}
# A command to paste for zsh, Linux bash, or fish, like `t3 install` prints. macOS bash reads only
# one of several startup files, so no single file is safe to change there.
path_command=
path_rest="$bin_dir"
path_prefix=
case "$bin_dir" in "$HOME"/*) path_rest="${bin_dir#"$HOME"}" path_prefix='$HOME' ;; esac
case "$path_rest" in *[!A-Za-z0-9_./-]*) path_rest= ;; esac
if [ -n "$path_rest" ]; then
  # Last on PATH, so it never shadows another t3.
  path_line="export PATH=\"\$PATH:${path_prefix}${path_rest}\""
  shell_name="${SHELL:-}"
  case "${shell_name##*/}" in
    zsh)
      # zsh reads .zshrc from ZDOTDIR when it is set; ~/.zshrc would never be read then.
      zsh_dir="$(read_from "${ZDOTDIR:-}" '~')"
      [ -z "$zsh_dir" ] || path_command="printf '\\n%s\\n' '${path_line}' >> ${zsh_dir}/.zshrc" ;;
    bash) [ "$platform" = darwin ] || path_command="printf '\\n%s\\n' '${path_line}' >> ~/.bashrc" ;;
    fish)
      # --path changes $PATH itself; fish_user_paths would go ahead of the system folders.
      config_dir="$(read_from "${XDG_CONFIG_HOME:-}" '~/.config')"
      fish_dir="${config_dir}/fish"
      [ -z "$config_dir" ] || path_command="mkdir -p ${fish_dir} && printf '\\n%s\\n' 'fish_add_path --append --path ${path_prefix}${path_rest}' >> ${fish_dir}/config.fish" ;;
  esac
fi
# A t3 earlier on PATH runs instead; the PATH command adds this folder last.
first_t3="$(command -v t3 2>/dev/null || true)"
case "$first_t3" in "" | "${bin_dir}/t3") first_t3= ;; esac
if [ -n "$first_t3" ]; then
  printf '  Another t3 at %s runs first, so run %s%s/t3%s to use this one.\n\n' "$first_t3" "$bold" "$bin_dir" "$reset"
else
  case ":${PATH}:" in
    *":${bin_dir}:"*) printf '  Run %st3%s to use T3 Code here, or %st3 up%s to use it from your other devices.\n\n' "$bold" "$reset" "$bold" "$reset" ;;
    *)
      if [ -n "$path_command" ]; then
        printf '  %s is not on your PATH yet. Add it with:\n\n    %s\n\n  Then open a new terminal and run %st3%s.\n\n' "$bin_dir" "$path_command" "$bold" "$reset"
      else
        printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset"
      fi
      ;;
  esac
fi
