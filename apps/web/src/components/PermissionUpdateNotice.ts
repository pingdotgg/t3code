import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { msg } from "gt-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

interface LegacyPermissionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Environments whose settled session still carries pre-scope permissions. */
const legacyPermissionEnvironmentsAtom = Atom.make((get) =>
  get(environmentSummaries.identitiesAtom).filter(({ environmentId }) => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      session._tag === "Success" && !session.waiting && sessionHasLegacyPermissions(session.value)
    );
  }),
).pipe(Atom.withLabel("web-legacy-permission-environments"));

const dismissalKey = (environmentId: EnvironmentId) =>
  `t3code:permission-update:v1:${environmentId}`;

/** Shows the notice and returns a withdraw that closes it without recording a dismissal. */
function showPermissionNotice(
  router: AnyRouter,
  { environmentId, label }: LegacyPermissionEnvironment,
) {
  const key = dismissalKey(environmentId);
  let withdrawn = false;
  const persistDismissal = () => {
    if (withdrawn) return;
    try {
      setLocalStorageItem(key, true, Schema.Boolean);
    } catch {}
  };
  const dismiss = () => {
    persistDismissal();
    toastManager.close(id);
  };
  const id = toastManager.add({
    title: m(msg("Permissions have changed for {label}", { label })),
    description: m(
      msg(
        "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      ),
    ),
    timeout: 0,
    onClose: persistDismissal,
    actionProps: {
      children: "Open Environments",
      onClick: () => {
        dismiss();
        void router.navigate({ to: "/settings/connections", hash: "authorized-clients" });
      },
    },
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: { children: m(msg("Dismiss")), onClick: dismiss },
      secondaryActionVariant: "ghost",
    },
  });
  return () => {
    withdrawn = true;
    toastManager.close(id);
  };
}

/**
 * Asks once per environment, until dismissed, to re-pair a connection that predates scoped
 * permissions. Removing the environment withdraws its notice.
 */
export function startPermissionUpdateNotices(router: AnyRouter): () => void {
  const shown = new Map<EnvironmentId, () => void>();
  const stopShowing = appAtomRegistry.subscribe(
    legacyPermissionEnvironmentsAtom,
    (environments) => {
      for (const environment of environments) {
        if (shown.has(environment.environmentId)) continue;
        try {
          if (getLocalStorageItem(dismissalKey(environment.environmentId), Schema.Boolean))
            continue;
        } catch {}
        shown.set(environment.environmentId, showPermissionNotice(router, environment));
      }
    },
    { immediate: true },
  );
  const stopWithdrawing = appAtomRegistry.subscribe(
    environmentSummaries.environmentIdsAtom,
    (environmentIds) => {
      const present = new Set(environmentIds);
      for (const [environmentId, withdraw] of shown) {
        if (present.has(environmentId)) continue;
        shown.delete(environmentId);
        withdraw();
      }
    },
  );
  return () => {
    stopShowing();
    stopWithdrawing();
  };
}
