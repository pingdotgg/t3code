import { AuthFilesystemReadScope, type EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { getFileMetadataQueryAtom } from "~/hooks/useFileMetadata";
import { useStableCallback } from "~/hooks/useStableCallback";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentScope } from "~/state/session";

import { joinHostPath } from "./filePath";
import { isMarkdownPreviewFile } from "./filePreviewMode";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";

/**
 * Tells whether a listed Markdown file is known to be too large to render. Sizes are read as
 * files are listed, so a row menu never waits on the server; a size that is not known (no answer
 * yet, a failed read, a path the server does not stat) counts as renderable.
 */
export function useOversizedMarkdown(
  environmentId: EnvironmentId,
  cwd: string,
  entries: readonly ProjectEntry[],
): (relativePath: string) => boolean {
  const sizes = useRef(new Map<string, number>());
  const requested = useRef(new Set<string>());
  const readSize = useStableCallback((relativePath: string) => {
    if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return;
    const query = getFileMetadataQueryAtom(environmentId, joinHostPath(cwd, relativePath));
    if (!query) return;
    requested.current.add(relativePath);
    void executeAtomQuery(appAtomRegistry, query, {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
    }).then((result) => {
      const byteLength = result._tag === "Success" ? result.value?.byteLength : undefined;
      if (byteLength === undefined) sizes.current.delete(relativePath);
      else sizes.current.set(relativePath, byteLength);
    });
  });

  const markdownPaths = entries
    .filter((entry) => entry.kind === "file" && isMarkdownPreviewFile(entry.path))
    .map((entry) => entry.path)
    .join("\0");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the size of each Markdown file once it is listed
  useEffect(() => {
    if (markdownPaths === "") return;
    for (const path of markdownPaths.split("\0")) {
      if (!requested.current.has(path)) readSize(path);
    }
  }, [markdownPaths, readSize]);

  return (relativePath) => {
    const oversized = (sizes.current.get(relativePath) ?? 0) > FULL_TEXT_MAX_BYTES;
    // A file can change size without its folder being listed again.
    readSize(relativePath);
    return oversized;
  };
}
