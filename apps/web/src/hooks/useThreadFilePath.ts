import { useContext } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
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
  const rootQuery = useFileMetadataQuery(environmentId, candidate ? root : null);
  const candidateQuery = useFileMetadataQuery(environmentId, candidate);
  return connection._tag === "Some" &&
    candidateQuery.isSuccess &&
    !candidateQuery.isPending &&
    candidateQuery.data?.kind === "file" &&
    (root === null || (rootQuery.isSuccess && !rootQuery.isPending && rootQuery.data === null))
    ? candidate
    : null;
}
