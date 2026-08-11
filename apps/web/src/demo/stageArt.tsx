import React from "react";
import ReactDOM from "react-dom/client";

import "../index.css";

import {
  StageBackdropArt,
  type SidebarStageBackdropVariant,
} from "../components/SidebarStageBackdrop";

// Renders the app's real per-channel stage art (the sidebar backdrop) as a
// standalone page so the marketing site can decorate elements with it without
// duplicating the artwork.
function resolveVariant(): SidebarStageBackdropVariant {
  const variant = new URLSearchParams(window.location.search).get("variant");
  return variant === "dev" ? "dev" : "nightly";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <div className="h-full w-full">
      <StageBackdropArt variant={resolveVariant()} />
    </div>
  </React.StrictMode>,
);
