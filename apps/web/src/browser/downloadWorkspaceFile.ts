import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";

function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments.findLast(Boolean) ?? "download";
}

export function startBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadWorkspaceFile<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;
  readonly startDownload?: (url: string, fileName: string) => void;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
        disposition: "attachment",
      },
    },
  });
  if (result._tag === "Failure") {
    return AsyncResult.failure(result.cause);
  }

  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }

  try {
    (input.startDownload ?? startBrowserDownload)(url, fileNameFromPath(input.filePath));
    return AsyncResult.success(undefined);
  } catch (cause) {
    return AsyncResult.failure(Cause.die(cause));
  }
}
