import { useContext } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  resolveMarkdownFileLinkTarget,
  resolveThreadFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { ThreadFilePathsContext } from "../threadFilePathsContext";
import { usePreparedConnection } from "../state/session";
import { useFileMetadataQuery } from "./useFileMetadata";

export function useThreadFilePath(
  href: string,
  cwd: string | undefined,
  environmentId: EnvironmentId | null,
) {
  const index = useContext(ThreadFilePathsContext);
  const candidate = index ? resolveThreadFilePathCandidate(href, cwd, index) : null;
  const root = resolveMarkdownFileLinkTarget(href, cwd);
  const connection = usePreparedConnection(candidate ? environmentId : null);
  // The server reports unreadable paths as missing too, so the root's folder must be missing as well.
  const rootPath = root === null ? null : splitFilePathPosition(root).path;
  const rootFolder =
    rootPath === null
      ? null
      : rootPath.slice(0, Math.max(rootPath.lastIndexOf("/"), rootPath.lastIndexOf("\\")));
  const rootQuery = useFileMetadataQuery(environmentId, candidate ? root : null);
  const rootFolderQuery = useFileMetadataQuery(environmentId, candidate ? rootFolder : null);
  const candidateQuery = useFileMetadataQuery(environmentId, candidate);
  const missing = (query: typeof rootQuery) =>
    query.isSuccess && !query.isPending && query.data === null;
  return connection._tag === "Some" &&
    candidateQuery.isSuccess &&
    !candidateQuery.isPending &&
    candidateQuery.data?.kind === "file" &&
    (root === null || (missing(rootQuery) && missing(rootFolderQuery)))
    ? candidate
    : null;
}
