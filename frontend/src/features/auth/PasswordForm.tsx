import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { queryClient } from "../../api/queries";
import type { User } from "../../api/types";
import { toast } from "../../state/toasts";

export function PasswordForm({ onDone, submitLabel = "Save password" }: { onDone?: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const user = await api<User>("/auth/password", {
        method: "POST",
        json: { current_password: current, new_password: next },
      });
      queryClient.setQueryData(["me"], user);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Your password has been changed.");
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <input type="text" autoComplete="username" hidden readOnly />
      <div className="field">
        <label htmlFor="pw-current">Current password</label>
        <input
          id="pw-current"
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input
          id="pw-new"
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <span className="field-hint">At least 10 characters.</span>
      </div>
      <div className="field">
        <label htmlFor="pw-confirm">Confirm new password</label>
        <input
          id="pw-confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={busy || !current || next.length < 10 || !confirm}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
