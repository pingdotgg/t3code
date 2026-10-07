import { useAtomValue } from "@effect/atom-react";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

// Keep an active toast across remounts, including Strict Mode effect replay.
const shown = new Set<EnvironmentId>();

function EnvironmentPermissionNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const navigate = useNavigate();
  useEffect(() => {
    if (
      session._tag !== "Success" ||
      session.waiting ||
      !sessionHasLegacyPermissions(session.value)
    )
      return;
    if (shown.has(environmentId)) return;
    const key = `t3code:permission-update:v1:${environmentId}`;
    try {
      if (getLocalStorageItem(key, Schema.Boolean)) return;
    } catch {
      // An unavailable store must not prevent the notice.
    }
    shown.add(environmentId);
    const id = toastManager.add({
      title: `Permissions have changed for ${label}`,
      description:
        "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      timeout: 0,
      onClose: () => {
        try {
          setLocalStorageItem(key, true, Schema.Boolean);
        } catch {
          // The in-memory marker still prevents repeats during this launch.
        }
      },
      actionProps: {
        children: "Open Connections",
        onClick: () => {
          toastManager.close(id);
          void navigate({ to: "/settings/connections" });
        },
      },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: { children: "Dismiss", onClick: () => toastManager.close(id) },
        secondaryActionVariant: "ghost",
      },
    });
  }, [environmentId, label, navigate, session]);
  return null;
}

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentPermissionNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}
