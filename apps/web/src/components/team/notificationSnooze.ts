import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { readTeamThreadSnoozeAccess, updateTeamThreadSnooze } from "./threadSnooze";

export function teamNotificationSnoozeAction(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  timestampFormat: ClientSettings["timestampFormat"],
  dismiss: () => void,
) {
  const access = readTeamThreadSnoozeAccess(scopeThreadRef(environmentId, threadId), registry);
  if (!access?.canSnooze) return {};
  return {
    secondaryActionProps: {
      children: m(msg("Snooze", { $context: "verb, snooze the thread" })),
      onClick: () => {
        const now = new Date();
        const [preset] = resolveSnoozePresets(now, timestampFormat, access.teamEnvironmentId);
        dismiss();
        void updateTeamThreadSnooze(
          registry,
          access.teamEnvironmentId,
          threadId,
          preset?.snoozedUntil ?? new Date(now.getTime() + 3_600_000).toISOString(),
        );
      },
    },
  };
}
