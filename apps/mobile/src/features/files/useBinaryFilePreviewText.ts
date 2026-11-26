import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { msg } from "gt-react-native";
import { useMemo } from "react";

import { m } from "../../i18n/messages";
import { resolveWorkspaceFilePath } from "./filePath";
import { useAssetUrlState } from "../../state/assets";

const previewTextAtom = Atom.family((key: string) => {
  const [uri] = JSON.parse(key) as [string, string];
  return Atom.make(
    Effect.tryPromise({
      try: async (signal) =>
        readFilePreviewResponse(
          await fetch(uri, {
            signal,
            headers: {
              Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}`,
              "Cache-Control": "no-cache",
            },
          }),
          signal,
        ),
      catch: (cause) => errorDisplayMessage(cause, m) ?? m(msg("Could not read this file.")),
    }),
  ).pipe(Atom.withLabel(`binary-file-preview-text:${key}`));
});

const noPreviewText = Atom.make(
  AsyncResult.initial<{ readonly text: string; readonly truncated: boolean }, string>(),
);

/**
 * The read RPC refuses non-UTF-8 text as binary so it is never edited lossily. This reads the
 * same file's bytes read-only and decodes them like attachments (UTF-8, then GB18030).
 */
export function useBinaryFilePreviewText(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
  /** Null disables the read. */
  readonly relativePath: string | null;
  readonly revision: string;
}) {
  const { threadId, cwd, relativePath } = input;
  const resource = useMemo<AssetResource | null>(() => {
    if (cwd === null || relativePath === null) return null;
    return threadId === null
      ? { _tag: "draft-workspace-file", cwd, path: relativePath, disposition: "attachment" }
      : {
          _tag: "media-file",
          threadId,
          path: resolveWorkspaceFilePath(cwd, relativePath),
          disposition: "attachment",
        };
  }, [threadId, cwd, relativePath]);
  const assetUrl = useAssetUrlState(input.environmentId, resource, input.revision);
  const uri = resource !== null && assetUrl._tag === "Success" ? assetUrl.url : null;
  const result = useAtomValue(
    uri === null ? noPreviewText : previewTextAtom(JSON.stringify([uri, input.revision])),
  );
  return {
    content: AsyncResult.isSuccess(result) ? result.value : null,
    error: AsyncResult.isFailure(result)
      ? Option.getOrNull(AsyncResult.error(result))
      : assetUrl._tag === "Failure"
        ? m(msg("Could not read this file."))
        : null,
  };
}
