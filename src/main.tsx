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

// a detached device window opens this same page with ?detach=<window label>
const detach = new URLSearchParams(window.location.search).get("detach");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {detach ? <Detached winLabel={detach} /> : <App />}
  </React.StrictMode>,
);
