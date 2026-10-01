import { useEffect } from "react";
import { X } from "lucide-react";
import { useToasts, type Toast } from "../state/toasts";

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, dismiss]);
  return (
    <div className={`toast ${toast.kind === "error" ? "error" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="toast-msg">{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <X size={15} />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
