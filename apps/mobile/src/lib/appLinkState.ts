import { getStateFromPath } from "@react-navigation/native";

import { startDevAutoConnect, withoutPairingTarget } from "../features/connection/devAutoConnect";
import { takeNewTaskPromptLink } from "../features/prompt-links/newTaskPromptLink";
import { takeThreadPromptLink } from "../features/prompt-links/threadPromptLink";
import { takeScheduledTaskNewLink } from "../features/settings/scheduled-task-editor-state";
import { restoreSettingsLinkState } from "../features/settings/settings-navigation";
import { settingsLinkPage } from "../features/workspace/workspace-selection-store";
import { restoreDraftLinkState } from "./appLinking";

/** Parses an app link into navigation state, taking each link-owned side effect on the way. */
export function getAppStateFromPath(path: string, options: Parameters<typeof getStateFromPath>[1]) {
  return takeScheduledTaskNewLink(
    startDevAutoConnect(
      withoutPairingTarget(
        takeNewTaskPromptLink(
          takeThreadPromptLink(
            restoreSettingsLinkState(
              restoreDraftLinkState(getStateFromPath(path, options), path),
              settingsLinkPage(),
            ),
          ),
        ),
      ),
    ),
  );
}
