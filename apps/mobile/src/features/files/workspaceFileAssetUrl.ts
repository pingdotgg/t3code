import {
  isAssetPreviewTypeValidationFailure,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { assetEnvironment, useAssetUrl } from "../../state/assets";
import { resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileAssetUrl(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const absolutePath = useMemo(
    () =>
      props.cwd !== null && props.relativePath !== null
        ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
        : null,
    [props.cwd, props.relativePath],
  );

  return useAssetUrl(
    props.environmentId,
    absolutePath !== null && props.threadId !== null
      ? {
          _tag: "workspace-file",
          threadId: props.threadId,
          path: absolutePath,
        }
      : null,
  );
}

/** One-shot imperative mint for flows that must not reuse a failed or expired
    grant: every call refreshes the signed URL. Throws with the server's
    message on failure, except a preview-type refusal — an older server's
    answer to any external-open file — which becomes upgrade guidance. */
export async function requestWorkspaceFileAssetUrl(input: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}): Promise<string> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId: input.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: input.threadId,
          path: resolveWorkspaceFilePath(input.cwd, input.relativePath),
        },
      },
    }),
    {
      label: "workspace file asset url request",
      refresh: true,
      reportDefect: false,
      reportFailure: false,
    },
  );
  if (result._tag !== "Success") {
    const failure = squashAtomCommandFailure(result);
    // Classified on the raw squashed failure: the generic wrap below hides
    // the failure's `_tag` from callers, so this is the last place the
    // structured failure is guaranteed intact.
    if (isAssetPreviewTypeValidationFailure(failure)) {
      throw new Error(
        "This environment's server doesn't support opening files in another app yet. Update its T3 server and retry.",
        { cause: failure },
      );
    }
    throw failure instanceof Error
      ? failure
      : new Error("The file could not be authorized.", { cause: failure });
  }
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) {
    throw new Error("The file URL could not be resolved.");
  }
  return url;
}
