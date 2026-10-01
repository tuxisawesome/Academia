import { Link } from "react-router";
import { ScanText } from "lucide-react";
import { useRecognition } from "./store";

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** One-line status of handwriting recognition, shown at the bottom of the sidebar. */
export function RecognitionStatus() {
  const { phase, loaded, total, server } = useRecognition();
  let text: string | null = null;
  let progress: number | null = null;
  if (phase === "loading") {
    text = total ? `Preparing handwriting reader… ${mb(loaded)} of ${mb(total)}` : "Preparing handwriting reader…";
    progress = total ? loaded / total : null;
  } else if (phase === "reading" && server) {
    text = `Reading handwriting… ${server.remaining.toLocaleString()} pages left`;
    progress = server.total ? server.read / server.total : null;
  } else if (phase === "error") {
    text = "Handwriting reader stopped";
  }
  if (!text) return null;
  return (
    <Link to="/settings/recognition" className="recognition-status" title="Text recognition settings">
      <ScanText size={15} />
      <span className="truncate">{text}</span>
      {progress !== null && (
        <span className="progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </Link>
  );
}
