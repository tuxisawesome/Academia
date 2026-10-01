import { isEditableTarget } from "../../lib/hooks";

/**
 * Whether a keydown that reached the notebook page's handler may act on the selected pages.
 * React bubbles events from portaled menus and dialogs (context menu, page preview, move dialog)
 * through the component tree, so only keys from inside the page's own DOM count. Enter on a
 * button or link keeps its native meaning (the button's own action) instead of opening the reader.
 */
export function isPageShortcut(e: { key: string; target: EventTarget | null; currentTarget: EventTarget | null }) {
  const target = e.target as Element | null;
  if (!target || !(e.currentTarget as Node | null)?.contains(target)) return false;
  if (isEditableTarget(target)) return false;
  if (e.key === "Enter" && target.closest("button, a, [role=menuitem]")) return false;
  return true;
}
