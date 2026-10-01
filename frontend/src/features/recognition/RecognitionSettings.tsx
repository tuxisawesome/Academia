import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { ReadingStatus } from "../../api/types";
import { confirmDialog } from "../../state/dialogs";
import { toast, toastError } from "../../state/toasts";
import { currentEngine, ENGINES, storedTier, storeTier, type TierChoice } from "./engine";
import { pokeRecognition, recognitionEnabled, restartRecognition, setRecognitionEnabled } from "./index";
import { useRecognition } from "./store";

const PHASE_TEXT: Record<string, string> = {
  checking: "Checking what this device supports…",
  off: "Turned off on this device.",
  unsupported:
    "This browser can't run the handwriting reader (it needs WebGPU). Use a recent Chrome, Edge, Safari or Firefox on a computer.",
  "other-tab": "Another Academia tab in this browser is reading pages.",
  loading: "Preparing the handwriting reader…",
  reading: "Reading pages on this device.",
  idle: "Everything has been read. New pages are read automatically.",
  error: "The handwriting reader stopped because of an error.",
};

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function RecognitionSettings() {
  const { phase, loaded, total, server, error, readThisSession } = useRecognition();
  const [enabled, setEnabled] = useState(recognitionEnabled);
  const [status, setStatus] = useState<ReadingStatus | null>(server);
  const [tier, setTier] = useState<TierChoice>(storedTier);
  const engine = currentEngine();

  useEffect(() => {
    if (server) setStatus(server);
  }, [server]);

  useEffect(() => {
    api<ReadingStatus>("/ocr/status", { query: { rank: currentEngine().rank } }).then(setStatus, () => undefined);
  }, [tier]);

  const pct = status && status.total ? Math.round((status.read / status.total) * 100) : 0;

  return (
    <>
      <section className="card settings-card">
        <h2>Text recognition</h2>
        <p className="muted">
          Academia reads the handwriting in your notebooks so that search can find it. The reading happens on your
          own devices, in the browser, so the server stays small and cheap. The recognised text is only used for
          search: it's never shown and never added to downloaded PDFs. Typed PDFs are searchable right after upload.
        </p>
        {status && (
          <div className="reading-progress">
            <div className="rp-numbers tabular">
              <strong>{status.read.toLocaleString()}</strong> of {status.total.toLocaleString()} pages read
              {status.remaining > 0 && <span className="muted"> · {status.remaining.toLocaleString()} to go</span>}
            </div>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </section>

      <section className="card settings-card">
        <h2>This device</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={phase === "unsupported"}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setRecognitionEnabled(e.target.checked);
            }}
          />
          <span>
            Use this device to read handwriting
            <small>
              While Academia is open, this device reads pages in the background using its graphics card. It's on by
              default for computers and off for phones.
            </small>
          </span>
        </label>
        <p className="device-phase" role="status">
          {PHASE_TEXT[phase] ?? ""}
          {phase === "loading" && total > 0 && (
            <span className="tabular">
              {" "}
              {mb(loaded)} of {mb(total)}
            </span>
          )}
          {phase === "error" && error && <span className="error-text"> {error}</span>}
          {readThisSession > 0 && <span className="muted"> {readThisSession} pages read since you opened Academia.</span>}
        </p>
        {phase === "loading" && total > 0 && (
          <div className="progress">
            <div style={{ width: `${Math.round((loaded / total) * 100)}%` }} />
          </div>
        )}
        <div className="field" style={{ marginTop: 16, maxWidth: 520 }}>
          <label htmlFor="rec-model">Model</label>
          <select
            id="rec-model"
            className="select"
            value={tier}
            onChange={(e) => {
              const next = e.target.value as TierChoice;
              storeTier(next);
              setTier(next);
              restartRecognition();
            }}
          >
            <option value="auto">Automatic (currently {engine.key === "standard" ? "standard" : "light"})</option>
            <option value="standard">Standard — best for handwriting (about {ENGINES.standard.downloadMB} MB)</option>
            <option value="light">Light — for smaller graphics cards (about {ENGINES.light.downloadMB} MB)</option>
          </select>
          <span className="field-hint">
            {engine.label}. Downloaded once per browser and kept for next time. Pages read with the light model are read
            again when a device with the standard model is available.
          </span>
        </div>
        <button
          className="btn"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Read all pages again?",
              message:
                "Every page will be read again in the background. Search keeps working with the current text in the meantime.",
              confirmLabel: "Read again",
            });
            if (!ok) return;
            try {
              await api("/ocr/reset", { method: "POST" });
              pokeRecognition();
              toast("All pages will be read again.");
            } catch (err) {
              toastError(err);
            }
          }}
        >
          Read everything again
        </button>
      </section>
    </>
  );
}
