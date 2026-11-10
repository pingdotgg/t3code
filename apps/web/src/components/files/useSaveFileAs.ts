import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { downloadMedia } from "../media/mediaContent";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Copies a host file to the viewing device, wherever the environment runs.
 * Desktop asks where to save it; browsers follow their download settings.
 */
export function useSaveFileAs() {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** Absolute host path, or a lookup that finds it. */
    readonly path: string | (() => Promise<string>);
  }) => {
    const toast = toastManager.add({ type: "loading", title: "Preparing file…" });
    try {
      const path = typeof input.path === "string" ? input.path : await input.path();
      const fileName = path.split(/[\\/]/).at(-1) || path;
      const connection = readPreparedConnection(input.environmentId);
      if (!connection) throw new Error("Reconnect to this environment and try again.");
      const result = await createAssetUrl({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "media-file",
            threadId: input.threadId,
            path,
            disposition: "attachment",
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error("The environment returned an invalid file URL.");
      await downloadMedia(url, fileName);
      toastManager.update(toast, { type: "success", title: "Download started" });
    } catch (error) {
      toastManager.update(
        toast,
        stackedThreadToast({
          type: "error",
          title: "Could not save file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}
