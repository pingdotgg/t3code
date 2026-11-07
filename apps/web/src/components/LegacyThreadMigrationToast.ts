import { createTranslator } from "@t3tools/client-runtime/i18n";

import { getUiLocale } from "../hooks/useI18n";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

/** A loading toast for as long as the primary server reports a legacy thread migration running. */
export function startLegacyThreadMigrationToast(): () => void {
  let toastId: MigrationToastId | null = null;

  const unsubscribe = appAtomRegistry.subscribe(
    primaryServerLegacyThreadMigrationAtom,
    (migration) => {
      if (migration?.status === "running") {
        if (toastId !== null) return;
        const t = createTranslator(getUiLocale());
        toastId = toastManager.add({
          type: "loading",
          title: t("app.migration.title"),
          description: t(
            migration.totalThreadCount === 1
              ? "app.migration.descriptionOne"
              : "app.migration.descriptionMany",
            { count: migration.totalThreadCount.toLocaleString() },
          ),
          timeout: 0,
        });
        return;
      }

      if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }
    },
    { immediate: true },
  );

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
