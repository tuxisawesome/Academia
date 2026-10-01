import { ContextMenu, DropdownMenu } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { FolderColor } from "../api/types";
import { FOLDER_COLORS, folderColorVar } from "../lib/colors";

/** Menu contents as data, so the same entries render as a right-click menu or a dropdown. */
export type MenuEntry =
  | {
      type?: "item";
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      shortcut?: string;
      checked?: boolean;
    }
  | { type: "sep" }
  | { type: "label"; label: string }
  | { type: "sub"; label: string; icon?: ReactNode; items: MenuEntry[]; disabled?: boolean }
  | { type: "colors"; value: FolderColor | null | "mixed"; onSelect: (color: FolderColor | null) => void };

type Parts = typeof ContextMenu | typeof DropdownMenu;

function tidy(entries: MenuEntry[]): MenuEntry[] {
  // Drop leading/trailing/double separators left behind by conditional entries.
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.type === "sep" && (out.length === 0 || out[out.length - 1].type === "sep")) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1].type === "sep") out.pop();
  return out;
}

function Entries({ parts: P, entries }: { parts: Parts; entries: MenuEntry[] }) {
  return (
    <>
      {tidy(entries).map((entry, i) => {
        if (entry.type === "sep") return <P.Separator key={i} className="menu-sep" />;
        if (entry.type === "label")
          return (
            <P.Label key={i} className="menu-label">
              {entry.label}
            </P.Label>
          );
        if (entry.type === "sub")
          return (
            <P.Sub key={i}>
              <P.SubTrigger className="menu-item" disabled={entry.disabled}>
                {entry.icon}
                <span>{entry.label}</span>
                <ChevronRight className="chev" />
              </P.SubTrigger>
              <P.Portal>
                <P.SubContent className="menu" sideOffset={4} alignOffset={-5} collisionPadding={8}>
                  <Entries parts={P} entries={entry.items} />
                </P.SubContent>
              </P.Portal>
            </P.Sub>
          );
        if (entry.type === "colors")
          return (
            <div key={i} className="color-grid" role="group" aria-label="Folder color">
              <P.Item
                className="color-swatch none"
                onSelect={() => entry.onSelect(null)}
                aria-label="No color"
                title="No color"
              >
                {entry.value === null && <Check />}
              </P.Item>
              {FOLDER_COLORS.map((c) => (
                <P.Item
                  key={c.key}
                  className="color-swatch"
                  style={{ background: folderColorVar(c.key) }}
                  onSelect={() => entry.onSelect(c.key)}
                  aria-label={c.label}
                  title={c.label}
                >
                  {entry.value === c.key && <Check />}
                </P.Item>
              ))}
            </div>
          );
        return (
          <P.Item
            key={i}
            className={`menu-item ${entry.danger ? "danger" : ""}`}
            disabled={entry.disabled}
            onSelect={entry.onSelect}
          >
            {entry.checked !== undefined ? (
              <span style={{ width: 16, display: "inline-grid" }}>{entry.checked && <Check />}</span>
            ) : (
              entry.icon
            )}
            <span>{entry.label}</span>
            {entry.shortcut && <span className="shortcut">{entry.shortcut}</span>}
          </P.Item>
        );
      })}
    </>
  );
}

export function ContextMenuContent({ entries }: { entries: MenuEntry[] }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu" collisionPadding={8}>
        <Entries parts={ContextMenu} entries={entries} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

export function DropdownMenuContent({
  entries,
  align = "end",
}: {
  entries: MenuEntry[];
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" align={align} sideOffset={4} collisionPadding={8}>
        <Entries parts={DropdownMenu} entries={entries} />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

/** A button that opens a dropdown menu. */
export function MenuButton({
  entries,
  children,
  label,
  className = "icon-btn",
  align = "end",
}: {
  entries: MenuEntry[];
  children: ReactNode;
  label: string;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button className={className} aria-label={label} title={label}>
          {children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenuContent entries={entries} align={align} />
    </DropdownMenu.Root>
  );
}
