import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAssetUrlState } from "../../state/assets";

// Whole-file reads past this stay on the 1 MB RPC preview; a phone lays out every source row.
export const MOBILE_FULL_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A refresh can keep the URL, so the key also carries the revision it downloads for. No idle TTL:
 * the revision cannot see a same-size edit, so a reopened file downloads its text again.
 */
const fullFileTextAtom = Atom.family((key: string) => {
  const [uri] = JSON.parse(key) as [string, string];
  return connectionAtomRuntime
    .atom(
      HttpClient.get(uri).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => {
          // The file can grow after the preview read; never buffer past the cap. React Native's
          // fetch buffers the whole body, so a response without a length is refused, not trusted.
          const length = Number(response.headers["content-length"] ?? Number.NaN);
          return Number.isFinite(length) && length <= MOBILE_FULL_FILE_MAX_BYTES
            ? response.text
            : Effect.succeed(null);
        }),
        Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
      ),
    )
    .pipe(Atom.withLabel(`full-file-text:${key}`));
});

const noFullFileTextAtom = Atom.make(AsyncResult.success(null));

/**
 * Downloads a thread file's full text past the 1 MB RPC preview; null while loading, after a
 * failure, or when disabled. A new `revision` downloads it again.
 */
export function useFullFileText(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly absolutePath: string | null;
  readonly revision: string;
}): string | null {
  const { threadId, absolutePath } = input;
  // Workspace-file URLs serve only previewable types; an attachment download serves any file.
  const resource = useMemo<AssetResource | null>(
    () =>
      threadId === null || absolutePath === null
        ? null
        : { _tag: "media-file", threadId, path: absolutePath, disposition: "attachment" },
    [threadId, absolutePath],
  );
  const assetUrl = useAssetUrlState(input.environmentId, resource, input.revision);
  const uri = resource !== null && assetUrl._tag === "Success" ? assetUrl.url : null;
  const result = useAtomValue(
    uri === null ? noFullFileTextAtom : fullFileTextAtom(JSON.stringify([uri, input.revision])),
  );
  // The caller keeps showing the 1 MB preview and its partial-file notice.
  return AsyncResult.isSuccess(result) ? result.value : null;
}
