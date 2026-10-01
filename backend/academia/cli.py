"""``academia`` command-line tool for server administration.

On an installed server run it through the wrapper, which runs it as the service user:

    sudo academia list-users
    sudo academia reset-password alice
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Annotated

import typer

from .config import build_info, get_settings
from .db import init_engine, read_session, write_session
from .errors import AppError
from .storage import ensure_dirs

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Academia server administration.")


def _init() -> None:
    ensure_dirs()
    init_engine(get_settings().db_path)


def _fail(message: str) -> None:
    typer.secho(message, fg=typer.colors.RED, err=True)
    raise typer.Exit(1)


@app.command()
def migrate() -> None:
    """Upgrade the database schema to the latest version."""
    _init()
    from .migrations import current_and_head, upgrade_head

    upgrade_head()
    current, head = current_and_head()
    typer.echo(f"Database schema at {current} (head {head}).")


@app.command("db-status")
def db_status() -> None:
    """Show whether the database schema is up to date (exit 1 if not)."""
    _init()
    from .migrations import current_and_head

    current, head = current_and_head()
    typer.echo(json.dumps({"current": current, "head": head, **build_info()}))
    if current != head:
        raise typer.Exit(1)


@app.command("create-user")
def create_user(
    username: str,
    admin: Annotated[bool, typer.Option("--admin", help="Give the user administrator rights.")] = False,
    password: Annotated[str | None, typer.Option(help="Initial password (default: generate one).")] = None,
    password_stdin: Annotated[bool, typer.Option("--password-stdin", help="Read the password from stdin.")] = False,
    display_name: Annotated[str, typer.Option(help="Display name.")] = "",
    no_force_change: Annotated[
        bool, typer.Option("--no-force-change", help="Don't require a new password at first sign-in.")
    ] = False,
    if_no_users: Annotated[bool, typer.Option("--if-no-users", help="Do nothing if any user already exists.")] = False,
) -> None:
    """Create a user account."""
    _init()
    from sqlalchemy import func, select

    from .models import User
    from .services.users import create_user as svc_create

    if password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    with write_session() as db:
        if if_no_users and (db.scalar(select(func.count()).select_from(User)) or 0) > 0:
            typer.echo("Users already exist; nothing to do.")
            return
        try:
            user, generated = svc_create(
                db,
                username,
                display_name=display_name,
                password=password,
                is_admin=admin,
                must_change=not no_force_change,
            )
        except AppError as exc:
            _fail(exc.message)
            return
        name = user.username
    typer.echo(f"Created {'administrator' if admin else 'user'} '{name}'.")
    if generated:
        typer.echo(f"Temporary password: {generated}")


@app.command("reset-password")
def reset_password(
    username: str,
    password: Annotated[str | None, typer.Option(help="New password (default: generate one).")] = None,
    password_stdin: Annotated[bool, typer.Option("--password-stdin")] = False,
) -> None:
    """Reset a user's password and sign them out everywhere."""
    _init()
    from .security import generate_password, hash_password, revoke_user_sessions, validate_new_password
    from .services.users import find_user

    if password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    with write_session() as db:
        user = find_user(db, username)
        if user is None:
            _fail(f"No user named '{username}'.")
            return
        generated = None
        if password:
            try:
                validate_new_password(password)
            except AppError as exc:
                _fail(exc.message)
        else:
            password = generated = generate_password()
        user.password_hash = hash_password(password)
        user.must_change_password = True
        user.disabled_at = None
        revoke_user_sessions(db, user.id)
    typer.echo(f"Password for '{username}' reset; they must choose a new one at next sign-in.")
    if generated:
        typer.echo(f"Temporary password: {generated}")


@app.command("list-users")
def list_users() -> None:
    """List user accounts."""
    _init()
    from .services.users import list_users as svc_list

    with read_session() as db:
        users = svc_list(db)
    for u in users:
        flags = ",".join(f for f, on in (("admin", u["is_admin"]), ("disabled", u["disabled"])) if on)
        typer.echo(f"{u['username']:<24} {u['display_name']:<28} {flags:<16} {u['storage_bytes'] / 1e6:10.1f} MB")


@app.command("set-admin")
def set_admin(username: str, off: Annotated[bool, typer.Option("--off", help="Remove admin rights.")] = False) -> None:
    """Grant (or with --off, remove) administrator rights."""
    _init()
    from .services.users import _guard_last_admin, find_user

    with write_session() as db:
        user = find_user(db, username)
        if user is None:
            _fail(f"No user named '{username}'.")
            return
        if off:
            try:
                _guard_last_admin(db, user)
            except AppError as exc:
                _fail(exc.message)
        user.is_admin = not off
    typer.echo(f"'{username}' is {'no longer' if off else 'now'} an administrator.")


@app.command("enable")
def enable(username: str) -> None:
    """Re-enable a disabled account."""
    _init()
    from .services.users import find_user

    with write_session() as db:
        user = find_user(db, username)
        if user is None:
            _fail(f"No user named '{username}'.")
            return
        user.disabled_at = None
    typer.echo(f"'{username}' enabled.")


@app.command()
def maintenance() -> None:
    """Purge old trash, deleted pages and orphaned files; trim caches."""
    _init()
    from .services.maintenance import run_maintenance

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    stats = run_maintenance()
    typer.echo(json.dumps(stats))


@app.command()
def backup(
    dest: Annotated[Path | None, typer.Option(help="Directory for the backup (default: <data>/backups).")] = None,
    keep: Annotated[int, typer.Option(help="How many backups with this label to keep (0 = all).")] = 14,
    label: Annotated[str, typer.Option(help="Backup file label.")] = "nightly",
) -> None:
    """Make a consistent copy of the database while the app is running."""
    _init()
    from .services.maintenance import backup_database

    path = backup_database(dest, keep=keep, label=label)
    typer.echo(str(path))


@app.command()
def version() -> None:
    """Print version information."""
    typer.echo(json.dumps(build_info()))


def main() -> None:
    app()


if __name__ == "__main__":
    main()
