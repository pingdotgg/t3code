import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useAssetUrlState } from "../../state/assets";

// Whole-file reads past this stay on the 1 MB RPC preview; a phone lays out every source row.
export const MOBILE_FULL_FILE_MAX_BYTES = 8 * 1024 * 1024;

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
  // A refresh can keep the URL, so a result counts only for the revision it was downloaded for.
  const [result, setResult] = useState<{
    readonly uri: string;
    readonly revision: string;
    readonly text: string;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file download and cancels it when the URL changes or the screen closes.
  useEffect(() => {
    if (uri === null) return;
    const controller = new AbortController();
    fetch(uri, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // The file can grow after the preview read; never buffer past the cap. React Native's fetch
        // buffers the whole body, so a response without a length is refused rather than trusted.
        const length = Number(response.headers.get("content-length") ?? Number.NaN);
        if (!Number.isFinite(length) || length > MOBILE_FULL_FILE_MAX_BYTES) {
          controller.abort();
          throw new Error("File too large");
        }
        return response.text();
      })
      .then((text) => setResult({ uri, revision: input.revision, text }))
      // The caller keeps showing the 1 MB preview and its partial-file notice.
      .catch(() => undefined);
    return () => controller.abort();
  }, [uri, input.revision]);
  return uri !== null && result?.uri === uri && result.revision === input.revision
    ? result.text
    : null;
}
