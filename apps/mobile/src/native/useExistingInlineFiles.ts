import { useAtomValue } from "@effect/atom-react";
import { AuthFilesystemReadScope } from "@t3tools/contracts";
import { needsWorkspaceBasenameLookup } from "@t3tools/client-runtime/workspace-basename-lookup";
import { useMemo } from "react";

import {
  isAbsolutePath,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../features/files/filePath";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "../lib/enrichedLinkPresentation";
import { inlineCodeFileCandidates } from "../lib/markdownDocument";
import { resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentScope } from "../state/session";
import type { InlineFileScope } from "./SelectableMarkdownText.types";

/** Whether an inline code path in `markdown` names a file that exists in the scope. */
export function useExistingInlineFiles(
  markdown: string,
  scope: InlineFileScope | undefined,
): (path: string) => boolean {
  const canRead = useEnvironmentScope(scope?.environmentId ?? null, AuthFilesystemReadScope);
  // Joined so streaming ticks that add no candidates keep the lookups and render memo unchanged.
  const candidateKey = scope
    ? inlineCodeFileCandidates(markdown, ENRICHED_INLINE_FILE_LINK_REGEX).join("\n")
    : "";
  const workspaceRoot = scope?.workspaceRoot;
  const searchBasenames = scope?.searchBasenames ?? false;
  const candidates = useMemo(() => {
    const byValue = new Map<string, { readonly path: string; readonly lookup: string | null }>();
    if (!workspaceRoot || candidateKey === "") return byValue;
    for (const value of candidateKey.split("\n")) {
      const presentation = resolveMarkdownLinkPresentation(value);
      if (presentation.kind !== "file") continue;
      const resolved = resolveFileLinkPath(workspaceRoot, presentation.path);
      if (resolved === null) continue;
      const relative = resolveWorkspaceRelativeFilePath(workspaceRoot, resolved);
      byValue.set(value, {
        path: isAbsolutePath(resolved) ? resolved : resolveWorkspaceFilePath(workspaceRoot, resolved),
        // Mirrors the link press handler, which searches only for bare file names.
        lookup:
          searchBasenames &&
          relative !== null &&
          !/[\\/]$/.test(presentation.path) &&
          needsWorkspaceBasenameLookup(relative)
            ? relative
            : null,
      });
    }
    return byValue;
  }, [candidateKey, workspaceRoot, searchBasenames]);
  const existing = useAtomValue(
    projectEnvironment.existingFiles(
      scope && canRead && candidates.size > 0
        ? {
            environmentId: scope.environmentId,
            cwd: scope.workspaceRoot,
            candidates: [...candidates.values()],
          }
        : null,
    ),
  );
  return useMemo(
    () => (value: string) => {
      const candidate = candidates.get(value);
      return candidate !== undefined && existing.has(candidate.path);
    },
    [candidates, existing],
  );
}
