#!/usr/bin/env bash
#
# Academia installer for Ubuntu Server 24.04 LTS / 26.04 LTS.
#
#   sudo ./deploy/install.sh                 # from a clone of the repository
#   curl -fsSL https://raw.githubusercontent.com/tuxisawesome/Academia/main/deploy/install.sh | sudo bash
#
# All questions are asked first; after you confirm, the installation runs unattended.
# Every question can be answered in advance with a flag (see --help), and --yes accepts
# the defaults for anything not given, so the script also works fully non-interactively.
#
# Re-running the installer is safe: it repairs/updates an existing installation and
# never changes existing accounts or data.
#
# This file is also used as a function library by update.sh (ACADEMIA_LIB_ONLY=1).

set -Eeuo pipefail
umask 022

# ---- Layout --------------------------------------------------------------------------------
# shellcheck disable=SC2034  # some of these are only used by update.sh

APP_USER=academia
BUILD_USER=academia-build
APP_ROOT=/opt/academia
SRC_DIR=$APP_ROOT/src
RELEASES_DIR=$APP_ROOT/releases
CURRENT_LINK=$APP_ROOT/current
TOOLS_DIR=$APP_ROOT/tools
PYTHON_DIR=$APP_ROOT/python
CACHE_DIR=$APP_ROOT/cache
DATA_DIR=/var/lib/academia
ETC_DIR=/etc/academia
ENV_FILE=$ETC_DIR/academia.env
CONF_FILE=$ETC_DIR/install.conf
STATE_FILE=$APP_ROOT/state
CADDYFILE=/etc/caddy/Caddyfile
CADDY_SITE_DIR=/etc/caddy/sites
CADDY_SITE=$CADDY_SITE_DIR/academia.caddy
LOG_FILE=/var/log/academia-install.log
CREDENTIALS_FILE=/root/academia-credentials.txt
APP_PORT=8750 # default; the port in use is ACADEMIA_PORT in $ENV_FILE (see app_port)
KEEP_RELEASES=3

DEFAULT_REPO=https://github.com/tuxisawesome/Academia.git
DEFAULT_BRANCH=main
DEFAULT_TRUSTED_PROXIES=private_ranges

# Pinned toolchain (overridden by deploy/versions.env of the release being installed).
# shellcheck disable=SC2034
UV_VERSION=0.12.21
PYTHON_VERSION=3.13
NODE_VERSION=24.21.0
NODE_SHA256_X64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
NODE_SHA256_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2

# ---- Output helpers ------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BLUE=$'\e[34m' C_RESET=$'\e[0m'
else
  C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_RESET=""
fi

STEP_NO=0
STEP_TOTAL=0

say() { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_DIM}$*${C_RESET}"; }
warn() { printf '%s\n' "${C_YELLOW}Warning:${C_RESET} $*" >&2; }
die() {
  printf '%s\n' "${C_RED}Error:${C_RESET} $*" >&2
  exit 1
}
step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s\n' "${C_BLUE}${C_BOLD}==> [${STEP_NO}/${STEP_TOTAL}] $*${C_RESET}"
  log "== $*"
}
ok() { printf '%s\n' "    ${C_GREEN}✓${C_RESET} $*"; }
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

# Runs a command with its output going to the log file; shows the tail if it fails.
run() {
  log "+ $*"
  if ! "$@" >>"$LOG_FILE" 2>&1; then
    show_failure "$*"
    return 1
  fi
}

show_failure() { # show_failure <command>
  printf '%s\n' "${C_RED}Command failed:${C_RESET} $1" >&2
  printf '%s\n' "${C_DIM}Last lines of $LOG_FILE:${C_RESET}" >&2
  tail -n 25 "$LOG_FILE" >&2 || true
}

ON_ERROR_CLEANUP="" # optional command that on_error runs first (e.g. to put a moved-aside release back)

on_error() {
  local code=$? line=${1:-?}
  # Only report once, from the top-level shell (not from command substitutions).
  ((BASH_SUBSHELL == 0)) || exit "$code"
  if [[ -n $ON_ERROR_CLEANUP ]]; then $ON_ERROR_CLEANUP || true; fi
  printf '\n%s\n' "${C_RED}${C_BOLD}Academia setup failed${C_RESET} (line $line, exit code $code)." >&2
  printf '%s\n' "Details are in $LOG_FILE. Fix the problem and run the same command again — it is safe to re-run." >&2
  exit "$code"
}

# ---- Prompts (read from the terminal, so `curl | sudo bash` works) -------------------------

HAVE_TTY=0
if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

ask() { # ask VAR "Question" "default"
  local __var=$1 question=$2 default=${3-} answer
  if [[ $HAVE_TTY -eq 0 ]]; then
    [[ -n $default ]] || die "No terminal available to ask: $question (pass it as a flag, see --help)."
    printf -v "$__var" '%s' "$default"
    return
  fi
  if [[ -n $default ]]; then
    read -r -p "  $question ${C_DIM}[$default]${C_RESET}: " answer </dev/tty || true
  else
    read -r -p "  $question: " answer </dev/tty || true
  fi
  printf -v "$__var" '%s' "${answer:-$default}"
}

ask_yes_no() { # ask_yes_no "Question" y|n  -> returns 0 for yes
  local question=$1 default=$2 answer hint
  [[ $default == y ]] && hint="Y/n" || hint="y/N"
  if [[ $HAVE_TTY -eq 0 ]]; then
    [[ $default == y ]]
    return
  fi
  while true; do
    read -r -p "  $question ${C_DIM}[$hint]${C_RESET} " answer </dev/tty || true
    answer=${answer:-$default}
    case ${answer,,} in
      y | yes) return 0 ;;
      n | no) return 1 ;;
    esac
  done
}

ask_secret() { # ask_secret VAR "Question"
  local __var=$1 question=$2 first second
  while true; do
    IFS= read -r -s -p "  $question: " first </dev/tty || true
    printf '\n'
    [[ -z $first ]] && {
      printf -v "$__var" '%s' ""
      return
    }
    if ((${#first} < 10)); then
      say "    ${C_YELLOW}Please use at least 10 characters.${C_RESET}"
      continue
    fi
    IFS= read -r -s -p "  Repeat the password: " second </dev/tty || true
    printf '\n'
    if [[ $first == "$second" ]]; then
      printf -v "$__var" '%s' "$first"
      return
    fi
    say "    ${C_YELLOW}The passwords don't match. Try again.${C_RESET}"
  done
}

# ---- Small utilities -----------------------------------------------------------------------

require_root() {
  [[ $EUID -eq 0 ]] || die "Please run this script as root (for example with sudo)."
}

load_versions() { # load_versions <dir containing versions.env>
  local f=$1/versions.env
  if [[ -f $f ]]; then
    # shellcheck disable=SC1090
    . "$f"
  fi
}

arch_name() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m). Academia supports amd64 and arm64." ;;
  esac
}

apt_get() { # like `run apt-get …`, but waits while another apt holds its locks
  # On a freshly booted server the automatic updates (apt-daily, unattended-upgrades) hold them
  # for minutes, and apt-get would fail at once. Waits up to about 15 minutes.
  local i
  for ((i = 1; ; i++)); do
    log "+ apt-get $*"
    if LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=5 "$@" >>"$LOG_FILE" 2>&1; then
      return 0
    fi
    if ((i < 60)) && grep -q 'Could not get lock' < <(tail -n 5 "$LOG_FILE"); then
      ((i > 1)) || info "    Waiting for the system's automatic updates to finish…"
      sleep 10
      continue
    fi
    show_failure "apt-get $*"
    return 1
  done
}

apt_install() {
  apt_get install -y -q --no-install-recommends "$@"
}

conf_get() { # conf_get KEY [default]
  local key=$1 default=${2-}
  if [[ -f $CONF_FILE ]]; then
    local value
    value=$(grep -E "^${key}=" "$CONF_FILE" | tail -n1 | cut -d= -f2- || true)
    value=${value%\"}
    value=${value#\"}
    [[ -n $value ]] && {
      printf '%s' "$value"
      return
    }
  fi
  printf '%s' "$default"
}

ssh_port() {
  local port=""
  if command -v sshd >/dev/null 2>&1; then
    # sshd -T fails, for example, while /run/sshd doesn't exist yet: port 22 is assumed then.
    port=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
  fi
  echo "${port:-22}"
}

port_owner() { # prints the process listening on TCP port $1 (empty if free)
  ss -H -ltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n1 || true
}

app_port() { # the port the app listens on: ACADEMIA_PORT in the settings file
  local port=""
  [[ -f $ENV_FILE ]] && port=$(grep -E '^ACADEMIA_PORT=' "$ENV_FILE" | tail -n1 | tr -dc '0-9' || true)
  echo "${port:-$APP_PORT}"
}

public_ipv4() {
  curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true
}

# ---- Toolchain -----------------------------------------------------------------------------

ensure_packages() {
  apt_get update -q
  apt_install ca-certificates curl git gnupg sqlite3 xz-utils tar debian-keyring debian-archive-keyring \
    apt-transport-https iproute2 ufw
  ok "System packages installed"
}

ensure_caddy() {
  # The signing key is fetched fresh every time: Caddy rotated an expired key before.
  local key=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
  local list=/etc/apt/sources.list.d/caddy-stable.list
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o "$key.new" &&
    mv "$key.new" "$key"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >"$list.new" && mv "$list.new" "$list"
  chmod o+r "$key" "$list"
  apt_get update -q
  apt_install caddy
  ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}') installed"
}

ensure_uv() {
  mkdir -p "$TOOLS_DIR/bin"
  local have=""
  [[ -x $TOOLS_DIR/bin/uv ]] && have=$("$TOOLS_DIR/bin/uv" --version 2>/dev/null | awk '{print $2}')
  if [[ $have != "$UV_VERSION" ]]; then
    # Downloads go to a private directory: other users could create a fixed name in /tmp first.
    local tmp
    tmp=$(mktemp -d)
    curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" -o "$tmp/uv-install.sh"
    run env UV_UNMANAGED_INSTALL="$TOOLS_DIR/bin" INSTALLER_NO_MODIFY_PATH=1 sh "$tmp/uv-install.sh"
    rm -rf "$tmp"
  fi
  ok "uv $("$TOOLS_DIR/bin/uv" --version | awk '{print $2}')"
}

ensure_python() {
  mkdir -p "$PYTHON_DIR"
  run env UV_PYTHON_INSTALL_DIR="$PYTHON_DIR" UV_CACHE_DIR="$CACHE_DIR/uv-root" \
    "$TOOLS_DIR/bin/uv" python install "$PYTHON_VERSION"
  chmod -R a+rX "$PYTHON_DIR"
  ok "Python $PYTHON_VERSION"
}

ensure_node() {
  local arch sha dir
  arch=$(arch_name)
  dir="$TOOLS_DIR/node-v$NODE_VERSION"
  if [[ ! -x $dir/bin/node ]]; then
    [[ $arch == x64 ]] && sha=$NODE_SHA256_X64 || sha=$NODE_SHA256_ARM64
    local tmp tarball
    tmp=$(mktemp -d)
    tarball=$tmp/node-v$NODE_VERSION.tar.xz
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o "$tarball"
    echo "$sha  $tarball" | sha256sum -c --quiet - || die "Node.js download failed its checksum."
    rm -rf "$dir.tmp" && mkdir -p "$dir.tmp"
    tar -xJf "$tarball" -C "$dir.tmp" --strip-components=1
    rm -rf "$tmp"
    mv "$dir.tmp" "$dir"
  fi
  ln -sfn "$dir" "$TOOLS_DIR/node"
  # Remove other Node versions.
  find "$TOOLS_DIR" -maxdepth 1 -name 'node-v*' ! -name "node-v$NODE_VERSION" -exec rm -rf {} + 2>/dev/null || true
  ok "Node.js $("$TOOLS_DIR/node/bin/node" --version) (used only to build the web app)"
}

ensure_users_and_dirs() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    run useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  if ! id "$BUILD_USER" >/dev/null 2>&1; then
    run useradd --system --home-dir "$CACHE_DIR/build-home" --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
  fi
  install -d -m 0755 -o root -g root "$APP_ROOT" "$RELEASES_DIR" "$TOOLS_DIR"
  install -d -m 0755 -o root -g root "$CACHE_DIR"
  install -d -m 0750 -o "$BUILD_USER" -g "$BUILD_USER" "$CACHE_DIR/build-home" "$CACHE_DIR/uv" "$CACHE_DIR/npm"
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
  # The service account owns everything in $DATA_DIR and could have replaced a folder there with
  # a symbolic link, which root must not follow (install -d would chown its target): root only
  # resets the owner of the top folders (chown -h never follows a link), and the folders are
  # made by the service account itself.
  local sub
  for sub in db sources thumbs cache cache/pdf exports tmp backups; do
    [[ ! -L $DATA_DIR/$sub ]] || die "$DATA_DIR/$sub is a symbolic link. Replace it with a folder and try again."
    if [[ $sub != */* && -d $DATA_DIR/$sub ]]; then chown -h "$APP_USER:$APP_USER" "$DATA_DIR/$sub"; fi
    runuser -u "$APP_USER" -- install -d -m 0750 "$DATA_DIR/$sub"
  done
  install -d -m 0750 -o root -g "$APP_USER" "$ETC_DIR"
  ok "Service accounts and directories ready"
}

write_env_file() {
  if [[ ! -f $ENV_FILE ]]; then
    local workers
    workers=$(($(nproc) / 2))
    ((workers < 1)) && workers=1
    ((workers > 4)) && workers=4
    cat >"$ENV_FILE" <<EOF
# Academia settings. Restart after editing:  sudo systemctl restart academia
ACADEMIA_DATA_DIR=$DATA_DIR
ACADEMIA_HOST=127.0.0.1
# After changing the port, run the installer again so that Caddy follows.
ACADEMIA_PORT=$APP_PORT
ACADEMIA_FORWARDED_ALLOW_IPS=127.0.0.1
# Largest PDF that can be uploaded, in MB.
ACADEMIA_MAX_UPLOAD_MB=1024
# Size limit of the cache of assembled PDFs, in MB.
ACADEMIA_PDF_CACHE_MAX_MB=4096
# Worker processes for PDF rendering and assembly.
ACADEMIA_PDF_WORKERS=$workers
TMPDIR=$DATA_DIR/tmp
PYTHONUNBUFFERED=1
EOF
  fi
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  ok "Settings in $ENV_FILE"
}

write_conf_file() {
  cat >"$CONF_FILE" <<EOF
# Answers given to the Academia installer (used by academia-update).
DOMAIN="$DOMAIN"
TLS_MODE="$TLS_MODE"
ACME_EMAIL="$ACME_EMAIL"
HTTP_PORT="$HTTP_PORT"
TRUSTED_PROXIES="$TRUSTED_PROXIES"
REPO_URL="$REPO_URL"
BRANCH="$BRANCH"
EOF
  chmod 0644 "$CONF_FILE"
}

# ---- Source & releases ---------------------------------------------------------------------

ensure_source() {
  if [[ -d $SRC_DIR/.git ]]; then
    run git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
  else
    rm -rf "$SRC_DIR"
    run git clone --no-checkout "$REPO_URL" "$SRC_DIR"
  fi
  # --force: a tag that was moved upstream would otherwise make every later fetch fail.
  run git -C "$SRC_DIR" fetch --prune --tags --force origin
  ok "Source code fetched from $REPO_URL"
}

resolve_commit() { # resolve_commit <ref>  (branch, tag or commit)
  local ref=$1 commit
  for candidate in "origin/$ref" "refs/tags/$ref" "$ref"; do
    if commit=$(git -C "$SRC_DIR" rev-parse --verify --quiet "$candidate^{commit}"); then
      echo "$commit"
      return 0
    fi
  done
  die "Could not find '$ref' in $REPO_URL."
}

current_commit() {
  if [[ -L $CURRENT_LINK ]]; then basename "$(readlink -f "$CURRENT_LINK")"; fi
}

as_build_user() { # as_build_user <dir> <command...>
  local dir=$1
  shift
  # shellcheck disable=SC2016  # $1/$@ are expanded by the inner shell
  runuser -u "$BUILD_USER" -- env -i \
    HOME="$CACHE_DIR/build-home" \
    PATH="$TOOLS_DIR/node/bin:$TOOLS_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
    LANG=C.UTF-8 \
    UV_CACHE_DIR="$CACHE_DIR/uv" \
    UV_PYTHON_INSTALL_DIR="$PYTHON_DIR" \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON="$PYTHON_VERSION" \
    npm_config_cache="$CACHE_DIR/npm" \
    npm_config_update_notifier=false \
    ACADEMIA_BUILD_ID="${BUILD_ID:-}" \
    bash -c 'cd "$1" && shift && exec "$@"' _ "$dir" "$@"
}

build_release() { # build_release <commit>
  local commit=$1 rel=$RELEASES_DIR/$1
  BUILD_ID=${commit:0:12}
  if [[ -f $rel/.complete ]]; then
    ok "Release ${commit:0:12} already built"
    return
  fi
  rm -rf "$rel"
  mkdir -p "$rel"
  git -C "$SRC_DIR" archive "$commit" | tar -x -C "$rel"
  local version
  version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$rel/backend/pyproject.toml" | head -n1)
  cat >"$rel/release.json" <<EOF
{"version": "${version:-0.0.0}", "commit": "$commit", "build_id": "$BUILD_ID", "built_at": "$(date -u +%FT%TZ)"}
EOF
  # The build user gets only the folders it builds in: the dependencies' install scripts run as
  # that user, and root later trusts the rest of the release (deploy/, .complete).
  chown -R "$BUILD_USER:$BUILD_USER" "$rel/backend" "$rel/frontend"
  info "    Installing Python dependencies…"
  run as_build_user "$rel/backend" uv sync --frozen --no-dev --compile-bytecode
  info "    Building the web app…"
  run as_build_user "$rel/frontend" npm ci --no-audit --no-fund
  run as_build_user "$rel/frontend" npm run build
  rm -rf "$rel/frontend/node_modules"
  # Code is owned by root and read-only for the service.
  chown -R root:root "$rel"
  chmod -R go-w,a+rX "$rel"
  touch "$rel/.complete"
  ok "Release ${commit:0:12} built"
}

prune_releases() {
  local keep=() current previous
  current=$(current_commit)
  previous=$(state_get PREVIOUS)
  [[ -n $current ]] && keep+=("$current")
  [[ -n $previous ]] && keep+=("$previous")
  local count=0
  while IFS= read -r dir; do
    local name
    name=$(basename "$dir")
    if [[ " ${keep[*]} " == *" $name "* ]]; then continue; fi
    count=$((count + 1))
    if ((count > KEEP_RELEASES - ${#keep[@]})); then rm -rf "$dir"; fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

switch_current() { # switch_current <commit>
  ln -sfn "$RELEASES_DIR/$1" "$CURRENT_LINK.new"
  mv -T "$CURRENT_LINK.new" "$CURRENT_LINK"
}

state_get() {
  [[ -f $STATE_FILE ]] && grep -E "^$1=" "$STATE_FILE" | tail -n1 | cut -d= -f2- || true
}

state_set() { # state_set KEY VALUE
  touch "$STATE_FILE"
  grep -vE "^$1=" "$STATE_FILE" >"$STATE_FILE.new" || true
  echo "$1=$2" >>"$STATE_FILE.new"
  mv "$STATE_FILE.new" "$STATE_FILE"
}

# ---- Running the app's CLI as the service user ------------------------------------------------

app_cli() { # app_cli <release dir> <academia args...>
  local rel=$1
  shift
  # shellcheck disable=SC2016  # $1/$@ are expanded by the inner shell
  runuser -u "$APP_USER" -- env -i PATH=/usr/bin:/bin HOME="$DATA_DIR" LANG=C.UTF-8 \
    bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' _ "$ENV_FILE" "$rel/backend/.venv/bin/academia" "$@"
}

db_exists() { [[ -s $DATA_DIR/db/academia.db ]]; }

backup_db() { # backup_db <label> -> prints the backup's path (nothing if there is no database)
  # Uses the installed release's own backup command (SQLite online backup API).
  if db_exists && [[ -x $CURRENT_LINK/backend/.venv/bin/academia ]]; then
    app_cli "$CURRENT_LINK" backup --label "$1" --keep 5 | tail -n1
  fi
}

restore_db() { # restore_db <backup file>  (academia.service must be stopped)
  local src=$1 db=$DATA_DIR/db/academia.db
  [[ -f $src ]] || return 0
  # Nothing else may have the database open while it is replaced: a housekeeping or backup job
  # still running would later write its (deleted) WAL into the restored file.
  systemctl stop academia-maint.timer academia-backup.timer academia-maint.service academia-backup.service 2>/dev/null || true
  # As the service account, which owns these files: root would follow symbolic links it made.
  # shellcheck disable=SC2016  # $1/$2 are expanded by the inner shell
  runuser -u "$APP_USER" -- bash -c 'cp "$1" "$2.restore" && chmod 0640 "$2.restore" &&
    rm -f "$2-wal" "$2-shm" && mv -fT "$2.restore" "$2"' _ "$src" "$db"
  systemctl start academia-maint.timer academia-backup.timer 2>/dev/null || true
}

keep_rollback_backup() { # keep_rollback_backup <backup file> -> prints the path to record for --rollback
  # Labelled backups are pruned (backup_db keeps 5), so the one --rollback relies on also gets a
  # name of its own (a hard link: no extra space while both exist).
  local src=$1 dest=$DATA_DIR/backups/academia-rollback.db
  [[ -n $src && -f $src ]] || return 0
  if ln -f "$src" "$dest" 2>/dev/null; then echo "$dest"; else echo "$src"; fi
}

migrate() { # migrate <release dir>
  run app_cli "$1" migrate
}

# ---- System integration --------------------------------------------------------------------

UNIT_HARDENING='NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
ReadWritePaths=/var/lib/academia
UMask=0027'

install_units() {
  cat >/etc/systemd/system/academia.service <<EOF
[Unit]
Description=Academia — notebooks and bookmarks
Documentation=https://github.com/tuxisawesome/Academia
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$CURRENT_LINK/backend
ExecStart=$CURRENT_LINK/backend/.venv/bin/uvicorn --factory academia.main:create_app --host \${ACADEMIA_HOST} --port \${ACADEMIA_PORT} --proxy-headers --forwarded-allow-ips \${ACADEMIA_FORWARDED_ALLOW_IPS} --no-server-header --timeout-graceful-shutdown 20
Restart=on-failure
RestartSec=3
TimeoutStopSec=40
LimitNOFILE=65536
$UNIT_HARDENING

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/systemd/system/academia-maint.service <<EOF
[Unit]
Description=Academia housekeeping (trash, deleted pages, caches)
After=academia.service

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
ExecStart=$CURRENT_LINK/backend/.venv/bin/academia maintenance
Nice=10
IOSchedulingClass=idle
$UNIT_HARDENING
EOF

  cat >/etc/systemd/system/academia-maint.timer <<EOF
[Unit]
Description=Daily Academia housekeeping

[Timer]
OnCalendar=*-*-* 03:30
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF

  cat >/etc/systemd/system/academia-backup.service <<EOF
[Unit]
Description=Academia database backup

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
ExecStart=$CURRENT_LINK/backend/.venv/bin/academia backup --label nightly --keep 14
Nice=10
$UNIT_HARDENING
EOF

  cat >/etc/systemd/system/academia-backup.timer <<EOF
[Unit]
Description=Nightly Academia database backup

[Timer]
OnCalendar=*-*-* 02:45
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  run systemctl enable academia.service academia-maint.timer academia-backup.timer
  run systemctl start academia-maint.timer academia-backup.timer
  ok "systemd services installed"
}

install_wrappers() { # install_wrappers <release dir>
  # Taken from the repository, not from the release: releases built by older installers were
  # writable by the build user (and so by the dependencies' install scripts).
  local commit tmp
  commit=$(basename "$1")
  tmp=$(mktemp -d)
  if ! git -C "$SRC_DIR" archive "$commit" deploy/bin 2>/dev/null | tar -x -C "$tmp" 2>/dev/null ||
    [[ ! -f $tmp/deploy/bin/academia-update || ! -f $tmp/deploy/bin/academia ]]; then
    rm -rf "$tmp"
    warn "Could not read the commands of version ${commit:0:12} from $SRC_DIR; the installed ones were kept."
    return 0
  fi
  install -m 0755 "$tmp/deploy/bin/academia-update" /usr/local/bin/academia-update
  install -m 0755 "$tmp/deploy/bin/academia" /usr/local/bin/academia
  rm -rf "$tmp"
  ok "Commands installed: academia-update, academia"
}

render_caddy_site() {
  local proxy="reverse_proxy 127.0.0.1:$(app_port)"
  if [[ $TLS_MODE == off ]]; then
    # Behind another proxy or tunnel: use the client address and scheme it passes on, and drop
    # the hop Caddy appends to X-Forwarded-For (the app trusts only Caddy), so that the app
    # sees the real client (per-IP sign-in limit) and HTTPS (Secure session cookie).
    printf -v proxy '%s {\n\t\ttrusted_proxies %s\n\t\theader_up X-Forwarded-For ", [^,]+$" ""\n\t}' \
      "$proxy" "$TRUSTED_PROXIES"
  fi
  local errors
  errors=$(
    cat <<'EOF'
	handle_errors 502 503 504 {
		@api path /api/*
		handle @api {
			header Cache-Control no-store
			respond "Academia is restarting. Try again in a moment." 503
		}
		handle {
			header Cache-Control no-store
			root * /opt/academia/current/deploy/static
			rewrite * /maintenance.html
			file_server
		}
	}
EOF
  )
  local headers='	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}'
  {
    echo "# Managed by the Academia installer. Changes are overwritten by academia-update."
    case $TLS_MODE in
      auto)
        echo "$DOMAIN {"
        [[ -n $ACME_EMAIL ]] && printf '\ttls %s\n' "$ACME_EMAIL"
        echo "$headers"
        ;;
      internal)
        echo "$DOMAIN {"
        printf '\ttls internal\n'
        echo "$headers"
        ;;
      off)
        echo "http://:$HTTP_PORT {"
        printf '\theader -Server\n'
        ;;
    esac
    printf '\tencode zstd gzip\n'
    printf '\t%s\n' "$proxy"
    echo "$errors"
    echo "}"
  } >"$CADDY_SITE.new"
}

stock_caddyfile() { # true for the Caddyfile of the caddy package (the "Caddy works!" page)
  [[ $(sed 's/#.*//' "$1" | tr -d '[:space:]') == ':80{root*/usr/share/caddyfile_server}' ]]
}

install_caddy_site() {
  install -d -m 0755 "$CADDY_SITE_DIR"
  render_caddy_site
  local main=$CADDYFILE saved
  # Keep the current files: if Caddy rejects the new configuration they are put back, because
  # Caddy (and every site it serves) wouldn't start again with an invalid one.
  saved=$(mktemp -d)
  [[ -f $CADDY_SITE ]] && cp -p "$CADDY_SITE" "$saved/site"
  [[ -f $main ]] && cp -p "$main" "$saved/main"
  mv "$CADDY_SITE.new" "$CADDY_SITE"
  if [[ ! -f $main ]] || stock_caddyfile "$main"; then
    # Stock Caddyfile: replace it. (Any other Caddyfile is kept, with the import added.)
    [[ -f $main ]] && cp "$main" "$main.orig-$(date +%s)"
    cat >"$main" <<'EOF'
# Sites are defined in /etc/caddy/sites/*.caddy
import /etc/caddy/sites/*.caddy
EOF
  elif ! grep -qE '^\s*import\s+/etc/caddy/sites/\*\.caddy' "$main"; then
    cp "$main" "$main.orig-$(date +%s)"
    printf '\nimport /etc/caddy/sites/*.caddy\n' >>"$main"
  fi
  if ! run caddy validate --config "$main" --adapter caddyfile; then
    if [[ -f $saved/site ]]; then cp -p "$saved/site" "$CADDY_SITE"; else rm -f "$CADDY_SITE"; fi
    if [[ -f $saved/main ]]; then cp -p "$saved/main" "$main"; else rm -f "$main"; fi
    rm -rf "$saved"
    die "Caddy rejected the new web server configuration (see above); the previous one was kept."
  fi
  rm -rf "$saved"
  run systemctl enable caddy
  if systemctl is-active --quiet caddy; then run systemctl reload caddy; else run systemctl restart caddy; fi
  ok "Caddy configured for $([[ $TLS_MODE == off ]] && echo "http://<server>:$HTTP_PORT" || echo "https://$DOMAIN")"
}

configure_firewall() {
  local active=0
  ufw status 2>/dev/null | grep -q "Status: active" && active=1
  # "no" leaves the firewall as it is, as the summary says: with an active UFW it is only "no"
  # when given with --firewall no (otherwise questions() makes it "yes").
  if [[ $FIREWALL != yes ]]; then
    ok "Firewall left unchanged"
    if [[ $active -eq 1 ]]; then
      warn "UFW is active: make sure it allows $([[ $TLS_MODE == off ]] && echo "port $HTTP_PORT" || echo "ports 80 and 443")."
    fi
    return
  fi
  local sshp
  sshp=$(ssh_port)
  run ufw allow "$sshp/tcp" comment 'SSH'
  if [[ $TLS_MODE == off ]]; then
    run ufw allow "$HTTP_PORT/tcp" comment 'Academia'
  else
    run ufw allow 80/tcp comment 'HTTP (redirects to HTTPS)'
    run ufw allow 443/tcp comment 'HTTPS'
    run ufw allow 443/udp comment 'HTTP/3'
  fi
  if [[ $active -eq 0 ]]; then run ufw --force enable; fi
  ok "Firewall allows SSH (port $sshp) and web traffic"
}

wait_healthy() { # wait_healthy <build id> [seconds]
  local want=$1 limit=${2:-60} body port
  port=$(app_port)
  for ((i = 0; i < limit; i++)); do
    if body=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null); then
      if [[ $body == *"\"build_id\":\"$want\""* || $body == *"\"build_id\": \"$want\""* ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

check_public_url() {
  [[ $TLS_MODE == off ]] && return 0
  local url="https://$DOMAIN/api/health" curl_opts=(-fsS --max-time 5)
  # A name is resolved to this server. An IP address is connected to as it is: Caddy picks the
  # certificate of an IP address by the address the connection arrives on.
  is_ipv4 "$DOMAIN" || curl_opts+=(--resolve "$DOMAIN:443:127.0.0.1")
  [[ $TLS_MODE == internal ]] && curl_opts+=(-k)
  for _ in $(seq 1 30); do
    if curl "${curl_opts[@]}" "$url" >/dev/null 2>&1; then
      ok "https://$DOMAIN is serving Academia"
      return 0
    fi
    sleep 2
  done
  warn "https://$DOMAIN didn't answer yet. If DNS was just changed, the certificate is issued as soon as"
  warn "the domain points at this server (check with: sudo journalctl -u caddy -n 50)."
}

# ---- Installer: questions ------------------------------------------------------------------

usage() {
  cat <<EOF
Academia installer

Usage: sudo $0 [options]

Every option pre-answers one of the installer's questions; anything not given is asked
interactively (or takes its default with --yes).

  --domain NAME            Domain name, e.g. academia.example.com (with --tls internal,
                           also a host name or the server's IPv4 address)
  --tls MODE               auto (Let's Encrypt, default), internal (self-signed), or off
                           (plain HTTP, when another proxy or tunnel provides HTTPS)
  --http-port PORT         Port for --tls off (default 8080)
  --trusted-proxies IPS    With --tls off: IP ranges of the proxy or tunnel in front, whose
                           X-Forwarded-For/-Proto headers are used (default: $DEFAULT_TRUSTED_PROXIES)
  --email ADDRESS          Email for Let's Encrypt expiry notices (optional)
  --admin-user NAME        First administrator's username (default: admin)
  --admin-password PASS    Their password (default: generate a secure one)
  --firewall yes|no        Enable UFW allowing SSH and web traffic (no: don't touch it)
  --repo URL               Git repository (default: $DEFAULT_REPO)
  --branch NAME            Branch, tag or commit to install (default: $DEFAULT_BRANCH)
  -y, --yes                Accept defaults for unanswered questions; don't ask to confirm
  -h, --help               Show this help
EOF
}

DOMAIN="" TLS_MODE="" HTTP_PORT="" ACME_EMAIL="" ADMIN_USER="" ADMIN_PASSWORD="" FIREWALL=""
TRUSTED_PROXIES="" REPO_URL="" BRANCH="" ASSUME_YES=0 ADMIN_PASSWORD_GENERATED=0 EXISTING_INSTALL=0
ARG_ADMIN_PASSWORD_SET=0 ARG_EMAIL_SET=0

parse_args() {
  while (($#)); do
    case $1 in
      --domain) DOMAIN=${2:?}; shift ;;
      --tls) TLS_MODE=${2:?}; shift ;;
      --http-port) HTTP_PORT=${2:?}; shift ;;
      --trusted-proxies) TRUSTED_PROXIES=${2:?}; shift ;;
      --email) ACME_EMAIL=${2-}; ARG_EMAIL_SET=1; shift ;;
      --admin-user) ADMIN_USER=${2:?}; shift ;;
      --admin-password) ADMIN_PASSWORD=${2-}; ARG_ADMIN_PASSWORD_SET=1; shift ;;
      --firewall) FIREWALL=${2:?}; shift ;;
      --repo) REPO_URL=${2:?}; shift ;;
      --branch) BRANCH=${2:?}; shift ;;
      -y | --yes) ASSUME_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  case ${TLS_MODE:-auto} in auto | internal | off) ;; *) die "--tls must be auto, internal or off." ;; esac
  case ${FIREWALL:-yes} in yes | no) ;; *) die "--firewall must be yes or no." ;; esac
  [[ -z $ACME_EMAIL ]] || valid_email "$ACME_EMAIL" || die "--email must be one email address, like you@example.com."
  TRUSTED_PROXIES=${TRUSTED_PROXIES//,/ }
  [[ -z $TRUSTED_PROXIES ]] || valid_proxies "$TRUSTED_PROXIES" ||
    die "--trusted-proxies takes IP addresses or ranges, like 10.0.0.0/8 or private_ranges."
}

preflight() {
  require_root
  [[ -r /etc/os-release ]] || die "Cannot identify this operating system."
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ ${ID:-} != ubuntu ]]; then
    warn "This installer is made for Ubuntu Server 24.04/26.04 (found: ${PRETTY_NAME:-unknown})."
  elif [[ ${VERSION_ID%%.*} -lt 24 ]]; then
    die "Ubuntu ${VERSION_ID} is too old. Please use Ubuntu Server 24.04 LTS or newer."
  fi
  arch_name >/dev/null
  command -v systemctl >/dev/null || die "systemd is required."
  if [[ -L $CURRENT_LINK && -f $CONF_FILE ]]; then EXISTING_INSTALL=1; fi
}

is_ipv4() {
  [[ $1 =~ ^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$ ]]
}

# Top-level domains are letters or punycode (xn--…). With a self-signed certificate, a host name
# or an IPv4 address also works.
valid_domain() {
  [[ $1 =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,63}|xn--[A-Za-z0-9-]{0,58}[A-Za-z0-9])$ ]] ||
    { [[ $TLS_MODE == internal ]] && { [[ $1 =~ ^[A-Za-z0-9-]+$ ]] || is_ipv4 "$1"; }; }
}

valid_email() { # one plain address: Caddy's "tls" directive accepts nothing else
  [[ $1 =~ ^[A-Za-z0-9._%+\'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]
}

saved_email() { # ACME_EMAIL from install.conf; older installers saved any answer
  local email
  email=$(conf_get ACME_EMAIL)
  if [[ -n $email ]] && ! valid_email "$email"; then
    warn "Ignoring the saved certificate email '$email': it is not an email address."
    email=""
  fi
  printf '%s' "$email"
}

valid_proxies() { # IP addresses or CIDR ranges, or Caddy's private_ranges
  local range ranges
  read -ra ranges <<<"$1"
  ((${#ranges[@]})) || return 1
  for range in "${ranges[@]}"; do
    [[ $range == private_ranges || $range =~ ^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$ ]] || return 1
  done
}

questions() {
  say ""
  say "${C_BOLD}Academia installer${C_RESET}"
  say "${C_DIM}Answer a few questions; the installation then runs on its own (about 5 minutes).${C_RESET}"
  if [[ $EXISTING_INSTALL -eq 1 ]]; then
    say ""
    say "An existing installation was found. It will be repaired and updated; accounts and data are kept."
    [[ -z $DOMAIN ]] && DOMAIN=$(conf_get DOMAIN)
    [[ -z $TLS_MODE ]] && TLS_MODE=$(conf_get TLS_MODE auto)
    [[ -z $HTTP_PORT ]] && HTTP_PORT=$(conf_get HTTP_PORT 8080)
    [[ -z $TRUSTED_PROXIES ]] && TRUSTED_PROXIES=$(conf_get TRUSTED_PROXIES "$DEFAULT_TRUSTED_PROXIES")
    [[ $ARG_EMAIL_SET -eq 0 ]] && ACME_EMAIL=$(saved_email)
    [[ -z $REPO_URL ]] && REPO_URL=$(conf_get REPO_URL "$DEFAULT_REPO")
    [[ -z $BRANCH ]] && BRANCH=$(conf_get BRANCH "$DEFAULT_BRANCH")
  fi
  say ""

  local defaults_only=$ASSUME_YES
  [[ $HAVE_TTY -eq 0 ]] && defaults_only=1

  # 1. How will people reach the server?
  if [[ -z $TLS_MODE ]]; then
    if [[ $defaults_only -eq 1 ]]; then
      TLS_MODE=auto
    else
      say "  ${C_BOLD}How should Academia be served?${C_RESET}"
      say "    1) HTTPS with a free Let's Encrypt certificate ${C_DIM}(recommended; needs a domain pointing here)${C_RESET}"
      say "    2) HTTPS with a self-signed certificate ${C_DIM}(private networks and testing)${C_RESET}"
      say "    3) Plain HTTP on a port ${C_DIM}(only behind another proxy or tunnel that provides HTTPS)${C_RESET}"
      local choice
      while true; do
        ask choice "Choose 1, 2 or 3" "1"
        case $choice in
          1) TLS_MODE=auto; break ;;
          2) TLS_MODE=internal; break ;;
          3) TLS_MODE=off; break ;;
        esac
      done
    fi
  fi

  # 2. Domain / port
  if [[ $TLS_MODE == off ]]; then
    [[ -z $HTTP_PORT ]] && { if [[ $defaults_only -eq 1 ]]; then HTTP_PORT=8080; else ask HTTP_PORT "Port to listen on" "8080"; fi; }
    if ! [[ $HTTP_PORT =~ ^[0-9]+$ ]] || ((HTTP_PORT < 1 || HTTP_PORT > 65535)); then
      die "Invalid port: $HTTP_PORT"
    fi
    [[ -z $DOMAIN ]] && DOMAIN=$(hostname -f 2>/dev/null || hostname)
  else
    while [[ -z $DOMAIN ]] || ! valid_domain "$DOMAIN"; do
      [[ -n $DOMAIN ]] && say "    ${C_YELLOW}'$DOMAIN' doesn't look like a domain name.${C_RESET}"
      [[ $HAVE_TTY -eq 0 ]] && die "Please pass a valid domain name with --domain."
      ask DOMAIN "Domain name for Academia (e.g. academia.example.com)" ""
    done
    DOMAIN=${DOMAIN,,}
  fi

  # 3. Let's Encrypt email
  if [[ $TLS_MODE == auto && $ARG_EMAIL_SET -eq 0 && $EXISTING_INSTALL -eq 0 && $defaults_only -eq 0 ]]; then
    ask ACME_EMAIL "Email for certificate expiry notices (optional, Enter to skip)" ""
    while [[ -n $ACME_EMAIL ]] && ! valid_email "$ACME_EMAIL"; do
      say "    ${C_YELLOW}'$ACME_EMAIL' doesn't look like an email address.${C_RESET}"
      ask ACME_EMAIL "Email for certificate expiry notices (optional, Enter to skip)" ""
    done
  fi

  # 4. First administrator (asked only on a fresh install; a re-run creates one only if there is
  #    no account at all, when the first run stopped before creating it)
  if [[ $EXISTING_INSTALL -eq 0 ]]; then
    if [[ -z $ADMIN_USER ]]; then
      if [[ $defaults_only -eq 1 ]]; then ADMIN_USER="admin"; else ask ADMIN_USER "Administrator username" "admin"; fi
    fi
    if [[ $ARG_ADMIN_PASSWORD_SET -eq 0 && $defaults_only -eq 0 ]]; then
      say "  ${C_DIM}Choose the administrator's password, or press Enter to generate a secure one.${C_RESET}"
      ask_secret ADMIN_PASSWORD "Administrator password"
    fi
  fi
  ADMIN_USER=${ADMIN_USER:-admin}
  [[ $ADMIN_USER =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "Invalid username: $ADMIN_USER"
  if [[ -n $ADMIN_PASSWORD ]] && ((${#ADMIN_PASSWORD} < 10)); then
    die "The administrator password must be at least 10 characters."
  fi

  # 5. Firewall
  if [[ -z $FIREWALL ]]; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
      FIREWALL=yes
    elif [[ $defaults_only -eq 1 ]]; then
      FIREWALL=no
    elif ask_yes_no "Enable the firewall (UFW), allowing only SSH (port $(ssh_port)) and web traffic?" y; then
      FIREWALL=yes
    else
      FIREWALL=no
    fi
  fi

  REPO_URL=${REPO_URL:-$DEFAULT_REPO}
  BRANCH=${BRANCH:-$DEFAULT_BRANCH}
  TRUSTED_PROXIES=${TRUSTED_PROXIES:-$DEFAULT_TRUSTED_PROXIES}

  # Checks that may need the user's attention — still before anything is installed.
  if [[ $TLS_MODE != off ]]; then
    for p in 80 443; do
      local owner
      owner=$(port_owner "$p")
      if [[ -n $owner && $owner != caddy ]]; then
        die "Port $p is already used by '$owner'. Stop it (or use --tls off behind your existing proxy) and try again."
      fi
    done
  else
    local owner
    owner=$(port_owner "$HTTP_PORT")
    [[ -z $owner || $owner == caddy ]] || die "Port $HTTP_PORT is already used by '$owner'."
  fi
  if [[ $TLS_MODE == auto ]]; then
    local resolved public
    # getent fails for a name without an IPv4 address: that's handled below, not an error.
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
    public=$(public_ipv4)
    if [[ -z $resolved ]] && ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
      warn "$DOMAIN does not resolve yet. Point its DNS A record at this server; the certificate is issued once it does."
      if [[ $defaults_only -eq 0 ]] && ! ask_yes_no "Continue anyway?" y; then exit 1; fi
    elif [[ -n $resolved && -n $public && $resolved != "$public" ]] && ! hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$resolved"; then
      warn "$DOMAIN points to $resolved, but this server's public address seems to be $public."
      if [[ $defaults_only -eq 0 ]] && ! ask_yes_no "Continue anyway?" y; then exit 1; fi
    fi
  fi

  # Summary
  say ""
  say "  ${C_BOLD}Summary${C_RESET}"
  case $TLS_MODE in
    auto) say "    Address:        https://$DOMAIN  (Let's Encrypt${ACME_EMAIL:+, notices to $ACME_EMAIL})" ;;
    internal) say "    Address:        https://$DOMAIN  (self-signed certificate)" ;;
    off)
      say "    Address:        http://<this server>:$HTTP_PORT  (put HTTPS in front of it)"
      say "    Proxies:        $TRUSTED_PROXIES  (trusted to pass on the client's address and HTTPS)"
      ;;
  esac
  if [[ $EXISTING_INSTALL -eq 0 ]]; then
    say "    Administrator:  $ADMIN_USER  ($([[ -n $ADMIN_PASSWORD ]] && echo "password you chose" || echo "password will be generated"))"
  else
    say "    Accounts:       unchanged  ${C_DIM}(an administrator is created only if there is no account yet)${C_RESET}"
  fi
  say "    Firewall:       $([[ $FIREWALL == yes ]] && echo "UFW on (SSH + web)" || echo "unchanged")"
  say "    Source:         $REPO_URL ($BRANCH)"
  say "    Data:           $DATA_DIR"
  say ""
  if [[ $defaults_only -eq 0 ]]; then
    ask_yes_no "Proceed with the installation?" y || {
      say "Nothing was changed."
      exit 0
    }
  fi
}

# ---- Installer: main -----------------------------------------------------------------------

main_install() {
  parse_args "$@"
  preflight
  questions
  : >>"$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  trap 'on_error $LINENO' ERR
  log "Install started: domain=$DOMAIN tls=$TLS_MODE branch=$BRANCH"
  STEP_TOTAL=11

  step "Installing system packages"
  ensure_packages

  step "Installing the web server (Caddy)"
  ensure_caddy

  step "Preparing accounts and folders"
  ensure_users_and_dirs
  write_env_file
  write_conf_file

  step "Downloading Academia"
  ensure_source
  local commit
  commit=$(resolve_commit "$BRANCH")
  # Use the toolchain versions pinned by the release we are about to install.
  local tmpdeploy
  tmpdeploy=$(mktemp -d)
  git -C "$SRC_DIR" archive "$commit" deploy/versions.env | tar -x -C "$tmpdeploy" 2>/dev/null || true
  load_versions "$tmpdeploy/deploy"
  rm -rf "$tmpdeploy"
  ok "Version ${commit:0:12}"

  step "Installing build tools (uv, Python, Node.js)"
  ensure_uv
  ensure_python
  ensure_node

  step "Building Academia"
  build_release "$commit"
  local rel=$RELEASES_DIR/$commit

  step "Setting up the database"
  local previous
  previous=$(current_commit)
  local backup=""
  if db_exists; then
    systemctl stop academia 2>/dev/null || true
    if ! backup=$(backup_db "pre-install"); then
      if [[ -n $previous ]]; then systemctl start academia || true; fi
      die "The database backup failed (is the disk full?). The database was not changed."
    fi
  fi
  if ! migrate "$rel"; then
    [[ -n $backup ]] && restore_db "$backup"
    if [[ -n $previous ]]; then systemctl start academia || true; fi
    die "The database migration failed${backup:+ (the database was restored from $backup)}. Details are in $LOG_FILE."
  fi
  switch_current "$commit"
  state_set CURRENT "$commit"
  if [[ -n $previous && $previous != "$commit" ]]; then
    state_set PREVIOUS "$previous"
    state_set PREVIOUS_DB_BACKUP "$(keep_rollback_backup "$backup")"
  fi
  # Also on a re-run: --if-no-users creates the administrator only if the first run stopped early.
  local out url cred_file=$CREDENTIALS_FILE
  if [[ $TLS_MODE == off ]]; then url="http://$(hostname -I | awk '{print $1}'):$HTTP_PORT"; else url="https://$DOMAIN"; fi
  if [[ -z $ADMIN_PASSWORD ]]; then
    ADMIN_PASSWORD_GENERATED=1
    out=$(app_cli "$rel" create-user "$ADMIN_USER" --admin --display-name "Administrator" --if-no-users)
    ADMIN_PASSWORD=$(sed -n 's/^Temporary password: //p' <<<"$out")
  else
    out=$(printf '%s\n' "$ADMIN_PASSWORD" | app_cli "$rel" create-user "$ADMIN_USER" --admin \
      --display-name "Administrator" --password-stdin --no-force-change --if-no-users)
  fi
  log "${out//Temporary password: */Temporary password: <redacted>}"
  if [[ $out == *"nothing to do"* ]]; then
    ADMIN_PASSWORD="" ADMIN_PASSWORD_GENERATED=0
    ok "Existing accounts kept"
  else
    ok "Administrator '$ADMIN_USER' created"
    if [[ $ADMIN_PASSWORD_GENERATED -eq 1 && -n $ADMIN_PASSWORD ]]; then
      # Saved right away: if a later step fails, a re-run finds the account and can't show it.
      umask 077
      printf 'Academia administrator\nURL:      %s\nUsername: %s\nPassword: %s  (temporary — you will choose a new one at first sign-in)\n' \
        "$url" "$ADMIN_USER" "$ADMIN_PASSWORD" >"$cred_file"
      umask 022
      chmod 0600 "$cred_file"
      state_set ADMIN_CREDENTIALS "$cred_file"
      ok "Its sign-in details are saved in $cred_file"
    fi
  fi
  ok "Database ready"

  step "Starting Academia"
  install_units
  install_wrappers "$rel"
  run systemctl restart academia
  wait_healthy "${commit:0:12}" 90 || die "Academia did not start. See: sudo journalctl -u academia -n 80"
  ok "Academia is running"

  step "Configuring HTTPS and the web server"
  install_caddy_site

  step "Configuring the firewall"
  configure_firewall

  step "Final checks"
  check_public_url
  prune_releases

  local saved_creds
  saved_creds=$(state_get ADMIN_CREDENTIALS)
  say ""
  say "${C_GREEN}${C_BOLD}Academia is installed.${C_RESET}"
  say ""
  say "  Open:       ${C_BOLD}$url${C_RESET}"
  if [[ -n $ADMIN_PASSWORD && $ADMIN_PASSWORD_GENERATED -eq 1 ]]; then
    say "  Sign in as: ${C_BOLD}$ADMIN_USER${C_RESET}   temporary password: ${C_BOLD}$ADMIN_PASSWORD${C_RESET}"
    say "              ${C_DIM}(also saved in $cred_file — delete it after signing in)${C_RESET}"
  elif [[ -n $ADMIN_PASSWORD ]]; then
    say "  Sign in as: ${C_BOLD}$ADMIN_USER${C_RESET} with the password you chose."
  elif [[ -n $saved_creds && -f $saved_creds ]]; then
    # The administrator was created by an earlier run that stopped before this summary.
    say "  Sign in with the details saved in ${C_BOLD}$saved_creds${C_RESET}"
    say "              ${C_DIM}(delete it after signing in)${C_RESET}"
  fi
  state_set ADMIN_CREDENTIALS ""
  say ""
  say "  Update later with:        ${C_BOLD}sudo academia-update${C_RESET}"
  say "  Manage users from a shell: sudo academia list-users | reset-password NAME | create-user NAME"
  say "  Logs:                     sudo journalctl -u academia -f"
  say "  Your data lives in $DATA_DIR (nightly database backups in $DATA_DIR/backups)."
  say ""
  log "Install finished"
}

if [[ ${ACADEMIA_LIB_ONLY:-0} != 1 ]]; then
  main_install "$@"
fi
