import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { DragEvent } from "react";

import { hostEnvironmentIdAtom } from "./state/primaryEnvironment";
import { useEnvironmentScope } from "./state/session";
import { toastManager } from "./components/ui/toast";

export function useNativeFileDrag(
  environmentId: EnvironmentId | null | undefined,
  resolvePath: () => string | Promise<string>,
) {
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const canOperate = useEnvironmentScope(environmentId ?? null, AuthOrchestrationOperateScope);
  const enabled =
    typeof window.desktopBridge?.startFileDrag === "function" &&
    (isMacPlatform(navigator.platform) || isWindowsPlatform(navigator.platform)) &&
    environmentId != null &&
    environmentId === hostEnvironmentId &&
    canOperate;
  return {
    draggable: enabled || undefined,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      // Electron replaces the HTML drag with a native file drag.
      event.preventDefault();
      event.stopPropagation();
      let released = false;
      window.addEventListener("pointerup", () => (released = true), { once: true });
      void (async () => {
        const { path } = splitFilePathPosition(await resolvePath());
        if (released) return;
        const started = await window.desktopBridge?.startFileDrag({ environmentId, path });
        if (!started) throw new Error("The file is unavailable on this computer.");
      })().catch((error: unknown) => {
        if (released) return;
        toastManager.add({
          type: "error",
          title: "Unable to drag file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
  };
}
