import { msg } from "gt-react";
import { HistoryIcon } from "lucide-react";
import { createElement } from "react";

import { m } from "../i18n/messages";
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
        toastId = toastManager.add({
          type: "loading",
          title: m(msg("Restoring your threads…")),
          description: m(
            msg(
              "{count, plural, one {Moving {total} thread from the old store. You can keep working.} other {Moving {total} threads from the old store. You can keep working.}}",
              {
                count: migration.totalThreadCount,
                total: migration.totalThreadCount.toLocaleString(),
              },
            ),
          ),
          timeout: 0,
          data: {
            leadingIcon: createElement(HistoryIcon, {
              "aria-hidden": true,
              className: "size-[15px] text-info-foreground",
            }),
          },
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
