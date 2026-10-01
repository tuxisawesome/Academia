import { useState } from "react";
import { Navigate } from "react-router";
import { Copy, KeyRound, MoreHorizontal, ShieldCheck, ShieldOff, Trash2, UserPlus, UserRoundCheck, UserRoundX } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import { queryClient, useAdminUsers, useMe } from "../../api/queries";
import type { AdminUser, User } from "../../api/types";
import { MenuButton, type MenuEntry } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { formatBytes, formatDate } from "../../lib/format";
import { useDocumentTitle } from "../../lib/hooks";
import { confirmDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";

function refresh() {
  return queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
}

function TempPasswordDialog({ info, onClose }: { info: { username: string; password: string } | null; onClose: () => void }) {
  if (!info) return null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Temporary password"
      description={`Give this password to ${info.username}. They'll be asked to choose their own when they sign in.`}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="temp-password">
        <code className="tabular">{info.password}</code>
        <button
          className="btn btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(info.password).then(
              () => toast("Copied to clipboard."),
              () => toast("Couldn't copy — please select and copy the password manually."),
            );
          }}
        >
          <Copy /> Copy
        </button>
      </div>
      <p className="field-hint">This password won't be shown again.</p>
    </Modal>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: string, p: string | null) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add user"
      description="New users choose their own password the first time they sign in."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" form="create-user" disabled={busy || !username.trim()}>
            Create user
          </button>
        </>
      }
    >
      <form
        id="create-user"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api<{ user: User; temporary_password: string | null }>("/admin/users", {
              method: "POST",
              json: { username, display_name: displayName, password: password || null, is_admin: isAdmin },
            });
            await refresh();
            onCreated(res.user.username, res.temporary_password);
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="nu-username">Username</label>
          <input
            id="nu-username"
            className="input"
            autoFocus
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <span className="field-hint">Letters, digits, dots, dashes and underscores.</span>
        </div>
        <div className="field">
          <label htmlFor="nu-display">Display name (optional)</label>
          <input id="nu-display" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="nu-password">Temporary password (optional)</label>
          <input
            id="nu-password"
            className="input"
            type="text"
            autoComplete="off"
            placeholder="Leave empty to generate one"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          <span>
            Administrator
            <small>Can add, disable and remove users.</small>
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function UsersAdminPage() {
  useDocumentTitle("Users");
  const { data: me } = useMe();
  const { data: users, isLoading } = useAdminUsers();
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);

  if (me && !me.is_admin) return <Navigate to="/" replace />;

  const patch = async (user: AdminUser, body: Record<string, unknown>, done?: string) => {
    try {
      const res = await api<{ user: User; temporary_password: string | null }>(`/admin/users/${user.id}`, {
        method: "PATCH",
        json: body,
      });
      await refresh();
      if (res.temporary_password) setTemp({ username: user.username, password: res.temporary_password });
      else if (done) toast(done);
    } catch (err) {
      toastError(err);
    }
  };

  const entries = (user: AdminUser): MenuEntry[] => {
    const self = user.id === me?.id;
    return [
      {
        label: "Reset password",
        icon: <KeyRound />,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Reset ${user.username}'s password?`,
            message: "They'll be signed out everywhere and get a temporary password.",
            confirmLabel: "Reset password",
          });
          if (ok) await patch(user, { reset_password: true });
        },
      },
      user.is_admin
        ? {
            label: "Remove administrator",
            icon: <ShieldOff />,
            disabled: self,
            onSelect: () => void patch(user, { is_admin: false }, `${user.username} is no longer an administrator.`),
          }
        : {
            label: "Make administrator",
            icon: <ShieldCheck />,
            onSelect: () => void patch(user, { is_admin: true }, `${user.username} is now an administrator.`),
          },
      user.disabled
        ? {
            label: "Enable account",
            icon: <UserRoundCheck />,
            onSelect: () => void patch(user, { disabled: false }, `${user.username} can sign in again.`),
          }
        : {
            label: "Disable account",
            icon: <UserRoundX />,
            disabled: self,
            onSelect: () => void patch(user, { disabled: true }, `${user.username} has been disabled.`),
          },
      { type: "sep" },
      {
        label: "Delete user…",
        icon: <Trash2 />,
        danger: true,
        disabled: self,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Delete ${user.username}?`,
            message: `This permanently deletes the account and its entire library (${user.notebook_count} notebooks, ${formatBytes(
              user.storage_bytes,
            )}). This can't be undone.`,
            confirmLabel: "Delete user",
            danger: true,
            typeToConfirm: user.username,
          });
          if (!ok) return;
          try {
            await api(`/admin/users/${user.id}`, { method: "DELETE" });
            await refresh();
            toast(`${user.username} was deleted.`);
          } catch (err) {
            toastError(err);
          }
        },
      },
    ];
  };

  return (
    <div className="page-scroll">
      <div className="page-pad">
        <div className="page-header">
          <div>
            <h1>Users</h1>
            <p className="muted" style={{ margin: 0 }}>
              Each user has a private library. Only administrators can add accounts.
            </p>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <UserPlus /> Add user
            </button>
          </div>
        </div>
        {isLoading ? (
          <div className="spinner lg" />
        ) : (
          <div className="card users-table" role="table" aria-label="Users">
            <div className="ut-row head" role="row">
              <span role="columnheader">User</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Storage</span>
              <span role="columnheader">Last sign-in</span>
              <span />
            </div>
            {users?.map((user) => (
              <div key={user.id} className={`ut-row ${user.disabled ? "disabled" : ""}`} role="row">
                <span className="ut-user" role="cell">
                  <span className="avatar sm" aria-hidden="true">
                    {(user.display_name || user.username).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="ut-names">
                    <strong className="truncate">{user.display_name}</strong>
                    <small className="muted truncate">
                      @{user.username}
                      {user.id === me?.id && " (you)"}
                    </small>
                  </span>
                </span>
                <span role="cell">
                  {user.is_admin && <span className="badge accent">Admin</span>} {user.disabled && <span className="badge">Disabled</span>}
                  {user.must_change_password && !user.disabled && <span className="badge">Pending password</span>}
                  {!user.is_admin && !user.disabled && !user.must_change_password && <span className="muted">User</span>}
                </span>
                <span role="cell" className="tabular muted">
                  {formatBytes(user.storage_bytes)} · {user.notebook_count} notebooks
                </span>
                <span role="cell" className="muted">
                  {user.last_login_at ? formatDate(user.last_login_at) : "Never"}
                </span>
                <span role="cell">
                  <MenuButton entries={entries(user)} label={`Actions for ${user.username}`}>
                    <MoreHorizontal />
                  </MenuButton>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(username, password) => {
          if (password) setTemp({ username, password });
          else toast(`${username} was added.`);
        }}
      />
      <TempPasswordDialog info={temp} onClose={() => setTemp(null)} />
    </div>
  );
}
