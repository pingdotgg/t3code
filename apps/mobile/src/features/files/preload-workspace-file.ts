import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { isBrowserPreviewFile, isImagePreviewFile } from "./filePath";
import { prepareSourceFileDocument } from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";

const inFlightPreloads = new Map<string, Promise<void>>();
const MAX_HIGHLIGHT_PRELOAD_CHARACTERS = 256 * 1024;

function preloadKey(input: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
}): string {
  return JSON.stringify([input.environmentId, input.cwd, input.relativePath]);
}

export function preloadWorkspaceFileContents(input: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly theme: ReviewDiffTheme;
}): void {
  if (isBrowserPreviewFile(input.relativePath) || isImagePreviewFile(input.relativePath)) {
    return;
  }

  const key = preloadKey(input);
  if (inFlightPreloads.has(key)) {
    return;
  }

  const preload = executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, relativePath: input.relativePath },
    }),
    {
      label: "workspace file preload",
      reportDefect: false,
      reportFailure: false,
    },
  )
    .then(async (result) => {
      if (result._tag === "Success") {
        const document = prepareSourceFileDocument(result.value.contents);
        if (document.contents.length <= MAX_HIGHLIGHT_PRELOAD_CHARACTERS) {
          await executeAtomQuery(
            appAtomRegistry,
            sourceHighlightAtom({
              path: input.relativePath,
              contents: document.contents,
              theme: input.theme,
            }),
            {
              label: "workspace source highlight preload",
              reportDefect: false,
              reportFailure: false,
            },
          );
        }
      }
    })
    .finally(() => {
      inFlightPreloads.delete(key);
    });

  inFlightPreloads.set(key, preload);
}
