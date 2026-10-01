import { create } from "zustand";

declare const __APP_BUILD__: string;
export const APP_BUILD: string = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev";

type Status = "online" | "offline" | "updating";

interface ConnectionState {
  status: Status;
  updateAvailable: boolean;
  setStatus: (status: Status) => void;
  setUpdateAvailable: () => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online",
  updateAvailable: false,
  setStatus: (status) => set({ status }),
  setUpdateAvailable: () => set({ updateAvailable: true }),
}));

export function reportNetworkError(): void {
  if (useConnection.getState().status === "online") useConnection.getState().setStatus("offline");
}

export function reportServerUnavailable(): void {
  if (useConnection.getState().status === "online") useConnection.getState().setStatus("updating");
}

/** Called with the X-App-Version header of every API response. */
export function checkServerVersion(version: string | null): void {
  if (!version || version === "dev" || APP_BUILD === "dev") return;
  if (version !== APP_BUILD && !useConnection.getState().updateAvailable) {
    useConnection.getState().setUpdateAvailable();
  }
}
