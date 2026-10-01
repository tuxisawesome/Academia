import type { FolderColor, NodeKind } from "../api/types";
import { folderColorVar } from "../lib/colors";

export function FolderGlyph({ color, size = 20, open = false }: { color?: FolderColor | null; size?: number; open?: boolean }) {
  const fill = folderColorVar(color);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="folder-glyph">
      <path
        d="M2.5 6.2c0-1 .8-1.7 1.7-1.7h5l2 2.2h8.6c1 0 1.7.8 1.7 1.7v9.9c0 1-.8 1.7-1.7 1.7H4.2c-1 0-1.7-.8-1.7-1.7z"
        fill={fill}
      />
      <path
        d={open ? "M4.4 10.2h17.1l-2 8.3c-.2.6-.7 1-1.3 1H3.2z" : "M2.5 9.4h19v8.9c0 1-.8 1.7-1.7 1.7H4.2c-1 0-1.7-.8-1.7-1.7z"}
        fill={fill}
        style={{ filter: "brightness(1.12)" }}
      />
      <path d="M2.5 9.4h19" stroke="rgba(0,0,0,.12)" strokeWidth=".6" fill="none" />
    </svg>
  );
}

export function NotebookGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="2.5" width="15" height="19" rx="1.6" fill="var(--bg-raised)" stroke="var(--ink-muted)" strokeWidth="1.3" />
      <path d="M8 2.5v19" stroke="var(--accent)" strokeWidth="1.6" />
      <path d="M11 7.5h6M11 10.5h6M11 13.5h4" stroke="var(--ink-faint)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function BookmarkGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 2.8h11c.6 0 1 .4 1 1v17.3l-6.5-4.6-6.5 4.6V3.8c0-.6.4-1 1-1z" fill="var(--accent)" />
      <path d="M9.5 7.5h5" stroke="var(--accent-ink)" strokeWidth="1.3" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

export function NodeGlyph({ kind, color, size = 20 }: { kind: NodeKind; color?: FolderColor | null; size?: number }) {
  if (kind === "folder") return <FolderGlyph color={color} size={size} />;
  if (kind === "notebook") return <NotebookGlyph size={size} />;
  return <BookmarkGlyph size={size} />;
}

export function Wordmark() {
  return (
    <span className="wordmark-lockup">
      <svg viewBox="0 0 512 512" width="28" height="28" aria-hidden="true">
        <rect width="512" height="512" rx="112" fill="#7B2D26" />
        <path d="M256 170c-38-26-92-36-150-30v214c58-6 112 4 150 30z" fill="#F7F1E5" />
        <path d="M256 170c38-26 92-36 150-30v214c-58-6-112 4-150 30z" fill="#EADFC8" />
        <path d="M322 128h44v146l-22-18-22 18z" fill="#CDA864" />
      </svg>
      <span className="wordmark-text">Academia</span>
    </span>
  );
}
