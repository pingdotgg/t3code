import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Alert } from "react-native";

import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { fileChipShareSource, type FileChipTarget } from "./fileChipMenu";

/** Fetches host files through the selected environment before opening the native save/share sheet. */
export function useFileChipShare(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sourceIdentifier: string,
) {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const connectionRef = useRef(httpBaseUrl);
  useLayoutEffect(() => {
    connectionRef.current = httpBaseUrl;
  }, [httpBaseUrl]);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const share = useCallback(
    (target: FileChipTarget) => {
      const source = fileChipShareSource(target, threadId);
      if (!source || requestRef.current) return;
      const request = new AbortController();
      requestRef.current = request;
      const httpBaseUrl = connectionRef.current;
      void (async () => {
        if (httpBaseUrl === null) throw new Error("Reconnect to the environment and try again.");
        const result = await createUrl({ environmentId, input: { resource: source.resource } });
        if (request.signal.aborted) return;
        const url =
          result._tag === "Success" ? resolveAssetUrl(httpBaseUrl, result.value.relativeUrl) : null;
        if (url === null) throw new Error("The file could not be loaded. Reconnect and try again.");
        await downloadAndShareAttachment({
          url,
          attachment: source,
          signal: request.signal,
          sourceIdentifier,
        });
      })()
        .catch((error: unknown) => {
          if (!request.signal.aborted) {
            Alert.alert(
              "Could not share file",
              error instanceof Error ? error.message : "Try again.",
            );
          }
        })
        .finally(() => {
          if (requestRef.current === request) {
            requestRef.current = null;
          }
        });
    },
    [createUrl, environmentId, sourceIdentifier, threadId],
  );
  return share;
}
