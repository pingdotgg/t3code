import { AuthFilesystemReadScope, type EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope } from "~/state/session";

import { isMarkdownPreviewFile } from "./filePreviewMode";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";

/**
 * Tells whether a listed Markdown file can be offered a rendered preview. Sizes are read as files
 * are listed, so a row menu never waits. An unanswered size is not offered (it may be too large);
 * a failed read (a server without the method) can never confirm one, so it stays offered.
 */
export function useRenderableMarkdown(
  environmentId: EnvironmentId,
  cwd: string,
  entries: readonly ProjectEntry[],
): (relativePath: string) => boolean {
  // Absent until the first answer; `null` once a read has failed.
  const sizes = useRef(new Map<string, number | null>());
  const requested = useRef(new Set<string>());
  const readSize = useStableCallback(async (relativePath: string) => {
    if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) {
      sizes.current.set(relativePath, null);
      return;
    }
    const query = projectEnvironment.statFile({ environmentId, input: { cwd, relativePath } });
    const result = await executeAtomQuery(appAtomRegistry, query, {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
    });
    sizes.current.set(relativePath, result._tag === "Success" ? result.value.byteLength : null);
  });

  const markdownPaths = entries
    .filter((entry) => entry.kind === "file" && isMarkdownPreviewFile(entry.path))
    .map((entry) => entry.path)
    .join("\0");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the size of each Markdown file once it is listed
  useEffect(() => {
    if (markdownPaths === "") return;
    for (const path of markdownPaths.split("\0")) {
      if (requested.current.has(path)) continue;
      requested.current.add(path);
      // Not queued: one read that hangs would leave every file behind it unconfirmed.
      void readSize(path);
    }
  }, [markdownPaths, readSize]);

  return (relativePath) => {
    const size = sizes.current.get(relativePath);
    // A file can change size without its folder being listed again.
    void readSize(relativePath);
    return size === null || (size !== undefined && size <= FULL_TEXT_MAX_BYTES);
  };
}
