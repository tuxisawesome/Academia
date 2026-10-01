import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { useUploads } from "../state/uploads";

/** Bottom-right panel listing background uploads (files dropped into the library). */
export function UploadTray() {
  const items = useUploads((s) => s.items);
  const clearFinished = useUploads((s) => s.clearFinished);
  const active = items.filter((i) => i.status === "uploading" || i.status === "processing").length;
  const failed = items.some((i) => i.status === "error");
  // Close automatically a few seconds after everything finished successfully.
  useEffect(() => {
    if (items.length === 0 || active > 0 || failed) return;
    const t = setTimeout(clearFinished, 4000);
    return () => clearTimeout(t);
  }, [items.length, active, failed, clearFinished]);
  if (items.length === 0) return null;
  return (
    <section className="upload-tray" aria-label="Uploads">
      <header>
        <strong>{active ? `Uploading ${active} ${active === 1 ? "file" : "files"}…` : "Uploads complete"}</strong>
        {!active && (
          <button className="icon-btn icon-btn-sm" aria-label="Close" onClick={clearFinished}>
            <X />
          </button>
        )}
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <div className="upload-row">
              <span className="truncate" title={item.name}>
                {item.name}
              </span>
              {item.status === "done" && <CheckCircle2 className="ok" size={16} />}
              {item.status === "error" && <CircleAlert className="bad" size={16} />}
              {item.abort && item.status === "uploading" && (
                <button className="icon-btn icon-btn-sm" aria-label="Cancel upload" onClick={item.abort}>
                  <X />
                </button>
              )}
            </div>
            {item.status === "error" ? (
              <div className="upload-error">{item.error}</div>
            ) : item.status !== "done" ? (
              <div className={`progress ${item.status === "processing" ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
