import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { basename } from "./filePath";
import {
  workspaceFileDownloadMimeType,
  workspaceFileDownloadResource,
} from "./workspaceFileDownload";

export function useWorkspaceFileSave(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const connection = usePreparedConnection(input.environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const requestRef = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight file download when the component unmounts
  useEffect(() => () => requestRef.current?.abort(), []);

  const save = () => {
    const { environmentId, cwd, relativePath, threadId } = input;
    if (
      environmentId === null ||
      cwd === null ||
      relativePath === null ||
      requestRef.current !== null
    ) {
      return;
    }
    const resource = workspaceFileDownloadResource({ cwd, relativePath, threadId });
    const request = new AbortController();
    requestRef.current = request;
    setSaving(true);
    void (async () => {
      if (httpBaseUrl === null) throw new Error("Reconnect to this environment and try again.");
      const result = await createUrl({ environmentId, input: { resource } });
      if (request.signal.aborted) return;
      const url =
        result._tag === "Success" ? resolveAssetUrl(httpBaseUrl, result.value.relativeUrl) : null;
      if (url === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      await downloadAndShareAttachment({
        url,
        attachment: {
          name: basename(relativePath),
          mimeType: workspaceFileDownloadMimeType(relativePath),
        },
        signal: request.signal,
      });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            "Could not save file",
            error instanceof Error ? error.message : "Please try again.",
          );
        }
      })
      .finally(() => {
        if (requestRef.current === request) {
          requestRef.current = null;
          if (!request.signal.aborted) setSaving(false);
        }
      });
  };

  return { save, saving };
}
