import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ShiftTracker from "./ShiftTracker.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ShiftTracker />
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/shift-tracker/sw.js").catch(() => {});
}
