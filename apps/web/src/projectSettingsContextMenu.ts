import type { MouseEvent } from "react";

import { readLocalApi } from "./localApi";

/**
 * Right-click menu for a draft's project: the chat header breadcrumb and the
 * draft headline both offer this single "Project settings" action.
 */
export function showProjectSettingsContextMenu(
  event: MouseEvent,
  onOpenProjectSettings: () => void,
) {
  event.preventDefault();
  const api = readLocalApi();
  if (!api) return;
  void api.contextMenu
    .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action === "project-settings") onOpenProjectSettings();
    });
}
