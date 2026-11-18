import * as Dialog from "../../components/ui/Dialog";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useGT } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useEffect, useRef } from "react";

import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { fileChipShareSource, type FileChipTarget } from "./fileChipMenu";

export function useFileChipShare(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  sourceIdentifier: string,
  options?: {
    readonly draftCwd?: string | null;
    readonly filePath?: string | null;
    readonly failureTitle?: string;
  },
) {
  const gt = useGT();
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const requestRef = useRef<{ scope: string; controller: AbortController } | null>(null);
  const scope = JSON.stringify([environmentId, threadId, options?.draftCwd, options?.filePath]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the download when its viewer target changes or unmounts
  useEffect(
    () => () => {
      const request = requestRef.current;
      if (request?.scope === scope) request.controller.abort();
    },
    [scope],
  );

  return (target: FileChipTarget): Promise<void> => {
    const source = fileChipShareSource(target, threadId, options?.draftCwd ?? null);
    if (!source || requestRef.current || environmentId === null) return Promise.resolve();
    const request = new AbortController();
    requestRef.current = { scope, controller: request };
    return (async () => {
      if (httpBaseUrl === null) throw new Error(gt("Reconnect to the environment and try again."));
      const result = await createUrl({ environmentId, input: { resource: source.resource } });
      if (request.signal.aborted) return;
      const url =
        result._tag === "Success" ? resolveAssetUrl(httpBaseUrl, result.value.relativeUrl) : null;
      if (url === null)
        throw new Error(gt("The file could not be loaded. Reconnect and try again."));
      await downloadAndShareAttachment({
        url,
        attachment: source,
        signal: request.signal,
        sourceIdentifier,
      });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            options?.failureTitle ?? gt("Could not share file"),
            errorDisplayMessage(error, m) ?? gt("Try again."),
          );
        }
      })
      .finally(() => {
        if (requestRef.current?.controller === request) {
          requestRef.current = null;
        }
      });
  };
}
