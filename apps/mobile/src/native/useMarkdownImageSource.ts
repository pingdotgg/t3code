import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { resolveMobileMarkdownMediaSource } from "../lib/markdownMediaSource";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { useCallback } from "react";
import * as Option from "effect/Option";

import { assetEnvironment } from "../state/assets";
import { environmentSession, usePreparedConnection } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

/** Native nested images use the same signed asset queries as app-owned media. */
export function useMarkdownImageSource(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly workspaceRoot: string | null;
  readonly captured?: boolean;
}): MarkdownImageSourceResolver {
  const { environmentId, threadId, workspaceRoot, captured } = props;
  const connection = usePreparedConnection(environmentId);
  const environment = useEnvironmentPresentation(environmentId);
  const connectionPhase = environment.presentation?.connection.phase;
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  return useCallback(
    async (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: threadId ?? undefined,
        workspaceRoot,
        imageEmbed: true,
      });
      if (media?.access === "direct") return { uri: normalizeNativeMarkdownUrl(media.uri) };
      if (
        captured ||
        !fileAccess.canReadFiles ||
        media === null ||
        media.access === "unavailable" ||
        httpBaseUrl === null ||
        connectionPhase === "offline" ||
        connectionPhase === "error" ||
        connectionPhase === "unsupported" ||
        connectionPhase === "reconnecting"
      )
        throw new Error("Markdown image is unavailable");
      const result = await createUrl({ environmentId, input: { resource: media.resource } });
      if (result._tag !== "Success") throw new Error("Could not authorize Markdown image");
      const uri = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (uri === null) throw new Error("Markdown image URL is invalid");
      return { uri };
    },
    [
      captured,
      fileAccess.canReadFiles,
      connectionPhase,
      createUrl,
      environmentId,
      httpBaseUrl,
      threadId,
      workspaceRoot,
    ],
  );
}
