import { t, plural } from "@palamedes/core/macro";
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
        const migrationTotalThreadCountToLocaleStringText =
          migration.totalThreadCount.toLocaleString();

        toastId = toastManager.add({
          type: "loading",
          title: t({ message: "Restoring your threads…" }),
          description: plural(migration.totalThreadCount, {
            one: `Migrating ${migrationTotalThreadCountToLocaleStringText} thread from the previous version. You can keep working while this finishes.`,
            other: `Migrating ${migrationTotalThreadCountToLocaleStringText} threads from the previous version. You can keep working while this finishes.`,
          }),
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
