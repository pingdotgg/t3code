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
 * Tells whether a listed Markdown file is known to be too large to render. Sizes are read as
 * files are listed, so a row menu never waits on the server; a size that is not known (no answer
 * yet, a failed read, a server without the method) counts as renderable. The size comes from the
 * workspace stat, which reaches what the preview reads, a network workspace included.
 */
export function useOversizedMarkdown(
  environmentId: EnvironmentId,
  cwd: string,
  entries: readonly ProjectEntry[],
): (relativePath: string) => boolean {
  const sizes = useRef(new Map<string, number>());
  const requested = useRef(new Set<string>());
  // A folder of notes can list hundreds of files; their sizes are read one at a time.
  const listed = useRef(Promise.resolve());
  const readSize = useStableCallback(async (relativePath: string) => {
    if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return;
    const query = projectEnvironment.statFile({ environmentId, input: { cwd, relativePath } });
    requested.current.add(relativePath);
    const result = await executeAtomQuery(appAtomRegistry, query, {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
    });
    if (result._tag === "Success") sizes.current.set(relativePath, result.value.byteLength);
    else sizes.current.delete(relativePath);
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
      listed.current = listed.current.then(() => readSize(path));
    }
  }, [markdownPaths, readSize]);

  return (relativePath) => {
    const oversized = (sizes.current.get(relativePath) ?? 0) > FULL_TEXT_MAX_BYTES;
    // A file can change size without its folder being listed again.
    void readSize(relativePath);
    return oversized;
  };
}
