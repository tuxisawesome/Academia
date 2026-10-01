import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api, errorMessage } from "../../api/client";
import { endedSessionUser, queryClient, useMe } from "../../api/queries";
import type { User } from "../../api/types";
import { Wordmark } from "../../components/Glyphs";
import { useDocumentTitle } from "../../lib/hooks";
import { safeNext } from "./next";

export function LoginPage() {
  useDocumentTitle("Sign in");
  const { data: me } = useMe();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"));
  // `next` is where the previous session left off; another user starts in their own library.
  const target = (user: User) => {
    if (user.must_change_password) return "/change-password";
    const ended = endedSessionUser();
    return ended && ended !== user.id ? "/" : next;
  };

  if (me) return <Navigate to={target(me)} replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api<User>("/auth/login", { method: "POST", json: { username, password } });
      queryClient.setQueryData(["me"], user);
      navigate(target(user), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Wordmark />
        </div>
        <h1>Welcome back</h1>
        <p className="muted">Sign in to your library.</p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="auth-foot faint">Accounts are created by your administrator.</p>
      </div>
    </div>
  );
}
