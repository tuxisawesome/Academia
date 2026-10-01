import { useEffect } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { invalidateLibrary, queryClient } from "../api/queries";
import { useConnection } from "../state/connection";

export async function serverReachable(): Promise<"ok" | "down" | "offline"> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
    if (res.ok) return "ok";
    return "down";
  } catch {
    return "offline";
  }
}

/**
 * Academia is online-only: when the connection drops (or the server is restarting during an
 * update), a blocking overlay explains what happened and retries automatically.
 */
export function ConnectionGuard() {
  const status = useConnection((s) => s.status);
  const setStatus = useConnection((s) => s.setStatus);

  useEffect(() => {
    const onOffline = () => setStatus("offline");
    const onOnline = () => void check();
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function check() {
    const result = await serverReachable();
    if (result === "ok") {
      if (useConnection.getState().status !== "online") {
        setStatus("online");
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        await invalidateLibrary();
      }
    } else {
      setStatus(result === "down" ? "updating" : "offline");
    }
  }

  useEffect(() => {
    if (status === "online") return;
    const t = setInterval(() => void check(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (status === "online") return null;
  const updating = status === "updating";
  return (
    <div className="overlay-block" role="alertdialog" aria-modal="true" aria-labelledby="conn-title">
      <div className="overlay-card">
        {updating ? <RefreshCw className="big" /> : <WifiOff className="big" />}
        <h2 id="conn-title">{updating ? "Academia is restarting" : "You're offline"}</h2>
        <p>
          {updating
            ? "The server is being updated or restarted. This usually takes a few seconds."
            : "Academia needs an internet connection. Connect to the internet and try again."}
        </p>
        <button className="btn btn-primary" onClick={() => void check()}>
          Try again
        </button>
      </div>
    </div>
  );
}

export function UpdateBanner() {
  const updateAvailable = useConnection((s) => s.updateAvailable);
  if (!updateAvailable) return null;
  return (
    <div className="update-banner" role="status">
      <span>Academia has been updated.</span>
      <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
