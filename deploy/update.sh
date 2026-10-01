#!/usr/bin/env bash
#
# Applies an Academia update. Normally started by `sudo academia-update`, which fetches the
# new version and runs *that version's* update.sh (so the update logic is always current).
#
# The new release is built while the old one keeps serving (except when --force rebuilds the
# running release, which is first stopped and moved aside). The database is backed up
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
  --force          Rebuild and restart even if already up to date (offline during the rebuild)
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
ACME_EMAIL=$(saved_email)
HTTP_PORT=$(conf_get HTTP_PORT 8080)
TRUSTED_PROXIES=$(conf_get TRUSTED_PROXIES "$DEFAULT_TRUSTED_PROXIES")
REPO_URL=$(conf_get REPO_URL "$DEFAULT_REPO")
BRANCH=$(conf_get BRANCH "$DEFAULT_BRANCH")
load_versions "$HERE"

SET_ASIDE="" # the running release, moved aside while --force rebuilds it

put_back_release() { # undoes the move-aside of a --force rebuild (no-op otherwise)
  [[ -n $SET_ASIDE && -d $SET_ASIDE ]] || return 0
  local rel=${SET_ASIDE%.old}
  rm -rf "$rel"
  mv -T "$SET_ASIDE" "$rel"
  SET_ASIDE="" ON_ERROR_CLEANUP=""
}

restart_set_aside_release() { # on_error cleanup during a --force rebuild
  put_back_release
  systemctl start academia || true
}

on_interrupt() { # Ctrl+C or SIGTERM: undo what on_error would undo, then stop
  trap '' INT TERM
  printf '\n' >&2
  warn "Interrupted."
  if [[ -n $ON_ERROR_CLEANUP ]]; then $ON_ERROR_CLEANUP || true; fi
  exit 130
}

caddy_refresh_failed() { # on_error note for the last step (re-running the update would only say "up to date")
  warn "Academia ${COMMIT:0:12} is installed and running; only the web server configuration could not be refreshed."
  warn "Fix the problem (check with: sudo caddy validate --config /etc/caddy/Caddyfile), then run: sudo systemctl reload caddy"
}

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
    # Housekeeping deletes unused PDFs for good after 21 days, so an older backup can refer to
    # files that are gone (the README promises safety for backups from the last two weeks).
    local age_days=$((($(date +%s) - $(stat -c %Y "$backup")) / 86400))
    if ((age_days > 14)); then
      say "${C_YELLOW}That backup is $age_days days old. PDFs that were deleted since then may already be gone"
      say "for good, and pages that used them would no longer open.${C_RESET}"
    fi
  else
    say "No database backup from that update was found; the current database is kept."
  fi
  if [[ $ASSUME_YES -eq 0 ]]; then
    ask_yes_no "Continue?" n || exit 0
  fi
  trap 'on_error $LINENO' ERR
  # Seconds from here to the end: an interruption would leave Academia stopped or half restored,
  # so Ctrl+C and SIGTERM are ignored (by the commands run here, too).
  trap '' INT TERM
  STEP_TOTAL=2
  step "Restoring the previous version"
  run systemctl stop academia
  local safety
  if ! safety=$(backup_db "pre-rollback"); then
    systemctl start academia || true
    die "The database backup failed (is the disk full?). Nothing was changed."
  fi
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
  trap on_interrupt INT TERM
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

  local rel=$RELEASES_DIR/$new
  if [[ $FORCE -eq 1 && $new == "$old" ]]; then
    # The running release can't be rebuilt beside itself (its virtualenv contains absolute
    # paths), so Academia is stopped and the release moved aside; it is put back on failure.
    step "Rebuilding ${new:0:12} (Academia is offline meanwhile)"
    run systemctl stop academia
    if [[ -f $rel/.complete ]]; then
      rm -rf "$rel.old"
      mv -T "$rel" "$rel.old"
    fi
    # (A complete copy left by an interrupted --force run is put back on failure, too.)
    if [[ -f $rel.old/.complete ]]; then
      SET_ASIDE=$rel.old ON_ERROR_CLEANUP=restart_set_aside_release
    fi
  else
    step "Building the new version (Academia stays online meanwhile)"
    if [[ $FORCE -eq 1 ]]; then rm -f "$rel/.complete"; fi
  fi
  build_release "$new"

  # From here until the new version answers (seconds), an interruption would leave Academia
  # stopped or half migrated, so Ctrl+C and SIGTERM are ignored (by the commands run here, too).
  trap '' INT TERM
  step "Backing up and migrating the database"
  run systemctl stop academia
  local backup
  if ! backup=$(backup_db "pre-update"); then
    put_back_release
    systemctl start academia || true
    die "The database backup failed (is the disk full?). Nothing was changed; Academia is running ${old:0:12} again."
  fi
  [[ -n $backup ]] && ok "Backup: $backup"
  if ! migrate "$rel"; then
    warn "The database migration failed — restoring the previous version."
    [[ -n $backup ]] && restore_db "$backup"
    put_back_release
    run systemctl start academia
    die "Update aborted. Academia is running the previous version (${old:0:12}) again."
  fi
  ok "Database migrated"

  step "Starting the new version"
  switch_current "$new"
  install_units
  install_wrappers "$rel"
  if ! run systemctl restart academia || ! wait_healthy "${new:0:12}" 90; then
    warn "The new version did not start correctly — rolling back."
    systemctl stop academia || true
    [[ -n $backup ]] && restore_db "$backup"
    put_back_release
    if [[ -n $old && -d $RELEASES_DIR/$old ]]; then
      switch_current "$old"
      install_wrappers "$RELEASES_DIR/$old"
    fi
    systemctl start academia || true
    wait_healthy "${old:0:12}" 60 || true
    die "Update failed and was rolled back to ${old:0:12}. See: sudo journalctl -u academia -n 80"
  fi
  ok "Academia is running ${new:0:12}"
  trap on_interrupt INT TERM
  if [[ -n $SET_ASIDE ]]; then
    rm -rf "$SET_ASIDE"
    SET_ASIDE="" ON_ERROR_CLEANUP=""
  fi
  # Recorded now, so that --rollback is right even if the web server step below fails.
  state_set CURRENT "$new"
  if [[ -n $old && $old != "$new" ]]; then
    state_set PREVIOUS "$old"
    state_set PREVIOUS_DB_BACKUP "$(keep_rollback_backup "$backup")"
  fi

  step "Refreshing the web server configuration"
  ON_ERROR_CLEANUP=caddy_refresh_failed
  install_caddy_site
  ON_ERROR_CLEANUP=""
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
