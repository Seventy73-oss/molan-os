import { EazoProvider } from "@eazo/sdk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./workspace.css";
import "./atelier.css";
import { applyAppearance, watchSystemTheme } from "./lib/theme";

applyAppearance();
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EazoProvider><App /></EazoProvider>
  </StrictMode>,
);
