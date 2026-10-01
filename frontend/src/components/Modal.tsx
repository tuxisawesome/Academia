import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "normal" | "wide" | "xwide";
  /** Prevent closing by clicking outside (e.g. while work is in progress). */
  modalLock?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
}

/** Toasts, the connection overlay and the update banner sit above dialogs; using them shouldn't dismiss one. */
function isAppChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".toaster, .overlay-block, .update-banner") !== null;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "normal",
  modalLock,
  onOpenAutoFocus,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`modal ${size === "normal" ? "" : size}`}
          onPointerDownOutside={(e) => (modalLock || isAppChrome(e.detail.originalEvent.target)) && e.preventDefault()}
          onEscapeKeyDown={(e) => modalLock && e.preventDefault()}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <div className="dialog-header">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="dialog-description">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn icon-btn-sm" aria-label="Close" disabled={modalLock}>
                <X />
              </button>
            </Dialog.Close>
          </div>
          {children !== undefined && <div className="dialog-body">{children}</div>}
          {footer && <div className="dialog-footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
