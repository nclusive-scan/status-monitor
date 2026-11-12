// The status page entry: applies the theme before the first paint (the CSP allows no inline script), then renders.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, storedTheme } from "./theme.ts";
import "./app.css";

applyTheme(storedTheme());
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
