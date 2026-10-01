import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource-variable/eb-garamond/wght.css";
import "@fontsource-variable/eb-garamond/wght-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/explorer.css";
import "./styles/pages.css";
import "./styles/settings.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { reloadForNewBuild } from "./lib/staleBuild";
import { guardFileDrops } from "./state/drag";

guardFileDrops();
// A chunk of an older build failed to load (the server was updated): reload to get the new one.
// If the reload is suppressed, the route's error page offers it instead.
window.addEventListener("vite:preloadError", () => void reloadForNewBuild());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* the app works without it; only installability and the offline page depend on it */
    });
  });
}
