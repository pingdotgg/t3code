import { createTranslator } from "@t3tools/client-runtime/i18n";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { getUiLocale } from "../hooks/useI18n";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
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

function showPermissionNotice(
  router: AnyRouter,
  { environmentId, label }: LegacyPermissionEnvironment,
) {
  const t = createTranslator(getUiLocale());
  const key = dismissalKey(environmentId);
  const persistDismissal = () => {
    try {
      setLocalStorageItem(key, true, Schema.Boolean);
    } catch {}
  };
  const dismiss = () => {
    persistDismissal();
    toastManager.close(id);
  };
  const id = toastManager.add({
    title: t("app.permissionNotice.title", { label }),
    description: t("app.permissionNotice.description"),
    timeout: 0,
    onClose: persistDismissal,
    actionProps: {
      children: t("app.permissionNotice.open"),
      onClick: () => {
        dismiss();
        void router.navigate({ to: "/settings/access" });
      },
    },
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: { children: t("app.starPrompt.dismiss"), onClick: dismiss },
      secondaryActionVariant: "ghost",
    },
  });
}

/** Asks once per environment, until dismissed, to re-pair a connection that predates scoped permissions. */
export function startPermissionUpdateNotices(router: AnyRouter): () => void {
  const shown = new Set<EnvironmentId>();
  return appAtomRegistry.subscribe(
    legacyPermissionEnvironmentsAtom,
    (environments) => {
      for (const environment of environments) {
        if (shown.has(environment.environmentId)) continue;
        try {
          if (getLocalStorageItem(dismissalKey(environment.environmentId), Schema.Boolean))
            continue;
        } catch {}
        shown.add(environment.environmentId);
        showPermissionNotice(router, environment);
      }
    },
    { immediate: true },
  );
}
