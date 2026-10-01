import { ContextMenu } from "radix-ui";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ChevronRight, FolderOpen, PinOff } from "lucide-react";
import { pinFolders, reorderPins, unpinFolders } from "../api/actions";
import { usePins } from "../api/queries";
import type { PinnedFolder } from "../api/types";
import { FolderGlyph } from "../components/Glyphs";
import { ContextMenuContent } from "../components/Menu";
import { currentDrag, endNodeDrag, isNodeDrag } from "../state/drag";
import { toast, toastError } from "../state/toasts";
import { useFolderDrop } from "./FolderTree";

const PIN_MIME = "application/x-academia-pin";
const OPEN_KEY = "academia-pins-open";

function isPinDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(PIN_MIME);
}

function PinnedItem({
  pin,
  index,
  pins,
  onReorderDrop,
  dropMarker,
  setDropMarker,
}: {
  pin: PinnedFolder;
  index: number;
  pins: PinnedFolder[];
  onReorderDrop: (from: string, to: number) => void;
  dropMarker: number | null;
  setDropMarker: (i: number | null) => void;
}) {
  const navigate = useNavigate();
  const drop = useFolderDrop(pin.id, pin.name);
  const move = (delta: number) => {
    const ids = pins.map((p) => p.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(to, 0, pin.id);
    void reorderPins(ids).catch(toastError);
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          className={`pin-item ${drop.over ? "drop-over" : ""} ${dropMarker === index ? "insert-before" : ""} ${
            dropMarker === index + 1 && index === pins.length - 1 ? "insert-after" : ""
          }`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(PIN_MIME, pin.id);
          }}
          onDragOver={(e) => {
            if (isPinDrag(e)) {
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              setDropMarker(e.clientY < box.top + box.height / 2 ? index : index + 1);
            } else {
              drop.props.onDragOver(e);
            }
          }}
          onDragLeave={drop.props.onDragLeave}
          onDrop={(e) => {
            if (isPinDrag(e)) {
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              onReorderDrop(e.dataTransfer.getData(PIN_MIME), e.clientY < box.top + box.height / 2 ? index : index + 1);
            } else {
              void drop.props.onDrop(e);
            }
          }}
          onDragEnd={() => setDropMarker(null)}
        >
          <NavLink to={`/f/${pin.id}`} className="tree-link" title={`${pin.name} — ${pin.location}`}>
            <FolderGlyph color={pin.color} size={18} />
            <span className="truncate">{pin.name}</span>
          </NavLink>
        </li>
      </ContextMenu.Trigger>
      <ContextMenuContent
        entries={[
          { label: "Open", icon: <FolderOpen />, onSelect: () => navigate(`/f/${pin.id}`) },
          { type: "sep" },
          { label: "Move up", icon: <ArrowUp />, disabled: index === 0, onSelect: () => move(-1) },
          { label: "Move down", icon: <ArrowDown />, disabled: index === pins.length - 1, onSelect: () => move(1) },
          { type: "sep" },
          {
            label: "Unpin from sidebar",
            icon: <PinOff />,
            onSelect: () => void unpinFolders([pin.id]).catch(toastError),
          },
        ]}
      />
    </ContextMenu.Root>
  );
}

/** "Pinned" section at the top of the sidebar (like Explorer's Quick access). */
export function PinnedFolders() {
  const { data: pins = [] } = usePins();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "0");
  const [over, setOver] = useState(false);
  const [dropMarker, setDropMarker] = useState<number | null>(null);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      /* ignore */
    }
  };

  const reorderDrop = (fromId: string, to: number) => {
    setDropMarker(null);
    const ids = pins.map((p) => p.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return;
    ids.splice(from, 1);
    ids.splice(to > from ? to - 1 : to, 0, fromId);
    void reorderPins(ids).catch(toastError);
  };

  // Dropping folders on the section header (or the empty hint) pins them.
  const pinDrop = {
    onDragOver: (e: React.DragEvent) => {
      if (isNodeDrag(e) && (currentDrag()?.folderIds.size ?? 0) > 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: async (e: React.DragEvent) => {
      setOver(false);
      const drag = currentDrag();
      if (!isNodeDrag(e) || !drag) return;
      e.preventDefault();
      const folderIds = [...drag.folderIds];
      endNodeDrag();
      try {
        await pinFolders(folderIds);
        if (!open) toggle();
        toast(folderIds.length === 1 ? "Folder pinned to the sidebar." : `${folderIds.length} folders pinned.`);
      } catch (err) {
        toastError(err);
      }
    },
  };

  return (
    <section className="pinned" aria-label="Pinned folders">
      <button className={`pinned-head ${over ? "drop-over" : ""}`} onClick={toggle} aria-expanded={open} {...pinDrop}>
        <ChevronRight size={14} className={`tree-toggle ${open ? "open" : ""}`} />
        <span>Pinned</span>
      </button>
      {open && (
        <ul
          className="pinned-list"
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropMarker(null);
          }}
        >
          {pins.length === 0 ? (
            <li className={`pin-empty ${over ? "drop-over" : ""}`} {...pinDrop}>
              Drag folders here, or right-click a folder and choose <em>Pin to sidebar</em>.
            </li>
          ) : (
            pins.map((pin, i) => (
              <PinnedItem
                key={pin.id}
                pin={pin}
                index={i}
                pins={pins}
                onReorderDrop={reorderDrop}
                dropMarker={dropMarker}
                setDropMarker={setDropMarker}
              />
            ))
          )}
        </ul>
      )}
    </section>
  );
}
