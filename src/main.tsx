import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./index.css";
import { App } from "./App";
import { Detached } from "./Detached";
import { SettingsProvider } from "./settings";

// No browser context menu (Print, Save as, Inspect…) — this is a desktop app.
// It stays where it is useful: text fields (cut/copy/paste), the SSH terminal
// (xterm copy/paste) and over a text selection (copy). Dev builds keep it
// everywhere, for Inspect.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .xterm")) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

// a detached device window opens this same page with ?detach=<window label>
const detach = new URLSearchParams(window.location.search).get("detach");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsProvider>{detach ? <Detached winLabel={detach} /> : <App />}</SettingsProvider>
  </React.StrictMode>,
);
