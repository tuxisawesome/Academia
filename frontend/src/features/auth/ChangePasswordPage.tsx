import { useNavigate } from "react-router";
import { logout } from "../../api/actions";
import { useMe } from "../../api/queries";
import { Wordmark } from "../../components/Glyphs";
import { useDocumentTitle } from "../../lib/hooks";
import { PasswordForm } from "./PasswordForm";

export function ChangePasswordPage() {
  useDocumentTitle("Choose a password");
  const { data: me } = useMe();
  const navigate = useNavigate();
  const forced = !!me?.must_change_password;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Wordmark />
        </div>
        <h1>{forced ? "Choose your password" : "Change password"}</h1>
        <p className="muted">
          {forced
            ? "Your account uses a temporary password. Please choose a new one to continue."
            : "Enter your current password and a new one."}
        </p>
        <PasswordForm onDone={() => navigate("/", { replace: true })} />
        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={async () => {
            await logout();
            navigate("/login", { replace: true });
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
