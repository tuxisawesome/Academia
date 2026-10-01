#!/usr/bin/env bash
#
# Applies an Academia update. Normally started by `sudo academia-update`, which fetches the
# new version and runs *that version's* update.sh (so the update logic is always current).
#
# The new release is built while the old one keeps serving. The database is backed up
# before migrating; if migration or the post-start health check fails, the previous
# release and database are restored automatically.

set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=install.sh
ACADEMIA_LIB_ONLY=1 . "$HERE/install.sh"

usage() {
  cat <<EOF
Usage: sudo academia-update [options]

  (no options)     Update to the latest version of the installed branch
  --ref REF        Update to a specific branch, tag or commit
  --check          Only report whether an update is available
  --rollback       Go back to the version before the last update (restores its database backup)
  --force          Rebuild and restart even if already up to date
  -y, --yes        Don't ask for confirmation (for --rollback)
EOF
}

COMMIT="" CHECK=0 ROLLBACK=0 FORCE=0 ASSUME_YES=0

while (($#)); do
  case $1 in
    --commit) COMMIT=${2:?}; shift ;;
    --ref) shift ;; # handled by the academia-update wrapper
    --check) CHECK=1 ;;
    --rollback) ROLLBACK=1 ;;
    --force) FORCE=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

require_root
[[ -f $CONF_FILE && -L $CURRENT_LINK ]] || die "Academia doesn't seem to be installed here. Run deploy/install.sh first."
: >>"$LOG_FILE"

DOMAIN=$(conf_get DOMAIN)
TLS_MODE=$(conf_get TLS_MODE auto)
ACME_EMAIL=$(conf_get ACME_EMAIL)
HTTP_PORT=$(conf_get HTTP_PORT 8080)
REPO_URL=$(conf_get REPO_URL "$DEFAULT_REPO")
BRANCH=$(conf_get BRANCH "$DEFAULT_BRANCH")
load_versions "$HERE"

rollback() {
  local current previous backup
  current=$(current_commit)
  previous=$(state_get PREVIOUS)
  backup=$(state_get PREVIOUS_DB_BACKUP)
  [[ -n $previous && -f $RELEASES_DIR/$previous/.complete ]] ||
    die "There is no previous version to roll back to."
  say "Roll back from ${current:0:12} to ${previous:0:12}."
  if [[ -n $backup && -f $backup ]]; then
    say "The database will be restored from $backup."
    say "${C_YELLOW}Changes made in Academia since that update will be lost.${C_RESET}"
  else
    say "No database backup from that update was found; the current database is kept."
  fi
  if [[ $ASSUME_YES -eq 0 ]]; then
    ask_yes_no "Continue?" n || exit 0
  fi
  trap 'on_error $LINENO' ERR
  STEP_TOTAL=2
  step "Restoring the previous version"
  run systemctl stop academia
  local safety
  safety=$(backup_db "pre-rollback")
  [[ -n $safety ]] && ok "Current database saved to $safety"
  [[ -n $backup && -f $backup ]] && restore_db "$backup"
  switch_current "$previous"
  install_wrappers "$RELEASES_DIR/$previous"
  run systemctl start academia
  step "Checking"
  wait_healthy "${previous:0:12}" 90 || die "Academia did not start after the rollback. See: sudo journalctl -u academia -n 80"
  state_set CURRENT "$previous"
  state_set PREVIOUS ""
  state_set PREVIOUS_DB_BACKUP ""
  ok "Rolled back to ${previous:0:12}"
}

main_update() {
  local old new
  old=$(current_commit)
  new=$COMMIT
  [[ -n $new ]] || die "No version given. Run this through: sudo academia-update"

  if [[ $CHECK -eq 1 ]]; then
    if [[ $old == "$new" ]]; then
      say "Academia is up to date (${old:0:12})."
    else
      say "An update is available: ${old:0:12} → ${new:0:12}. Install it with: sudo academia-update"
    fi
    exit 0
  fi
  if [[ $old == "$new" && $FORCE -eq 0 ]]; then
    say "Academia is already up to date (${new:0:12})."
    exit 0
  fi

  trap 'on_error $LINENO' ERR
  log "Update started: ${old:0:12} -> ${new:0:12}"
  say "${C_BOLD}Updating Academia${C_RESET} ${old:0:12} → ${new:0:12}"
  STEP_TOTAL=5

  step "Refreshing system packages and build tools"
  ensure_packages
  ensure_caddy
  ensure_users_and_dirs
  ensure_uv
  ensure_python
  ensure_node

  step "Building the new version (Academia stays online meanwhile)"
  if [[ $FORCE -eq 1 ]]; then rm -f "$RELEASES_DIR/$new/.complete"; fi
  build_release "$new"
  local rel=$RELEASES_DIR/$new

  step "Backing up and migrating the database"
  run systemctl stop academia
  local backup
  backup=$(backup_db "pre-update")
  [[ -n $backup ]] && ok "Backup: $backup"
  if ! migrate "$rel"; then
    warn "The database migration failed — restoring the previous version."
    [[ -n $backup ]] && restore_db "$backup"
    run systemctl start academia
    die "Update aborted. Academia is running the previous version (${old:0:12}) again."
  fi
  ok "Database migrated"

  step "Starting the new version"
  switch_current "$new"
  install_units
  install_wrappers "$rel"
  run systemctl restart academia
  if ! wait_healthy "${new:0:12}" 90; then
    warn "The new version did not start correctly — rolling back."
    systemctl stop academia || true
    [[ -n $backup ]] && restore_db "$backup"
    if [[ -n $old && -d $RELEASES_DIR/$old ]]; then
      switch_current "$old"
      install_wrappers "$RELEASES_DIR/$old"
    fi
    systemctl start academia || true
    wait_healthy "${old:0:12}" 60 || true
    die "Update failed and was rolled back to ${old:0:12}. See: sudo journalctl -u academia -n 80"
  fi
  ok "Academia is running ${new:0:12}"

  step "Refreshing the web server configuration"
  install_caddy_site
  state_set CURRENT "$new"
  if [[ -n $old && $old != "$new" ]]; then
    state_set PREVIOUS "$old"
    state_set PREVIOUS_DB_BACKUP "$backup"
  fi
  prune_releases
  log "Update finished"
  say ""
  say "${C_GREEN}${C_BOLD}Academia was updated to ${new:0:12}.${C_RESET}"
  say "Open browser tabs will offer to reload. If something is wrong: sudo academia-update --rollback"
}

if [[ $ROLLBACK -eq 1 ]]; then
  rollback
else
  main_update
fi
