import { type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { FileChange } from "../../session-logic";
import { expandPartialPatchWithCurrentFile, getRenderablePatch } from "../../lib/diffRendering";
import { readProjectFileFresh } from "../files/projectFilesQueryState";

type ExpansionError = "changed" | "patch" | "read-error" | "missing-hash" | "truncated" | null;

export function useExpandedFileDiff(
  change: FileChange,
  fileDiff: FileDiffMetadata,
  environmentId: EnvironmentId,
  workspaceRoot: string | undefined,
): { expandedFileDiff: FileDiffMetadata; expansionError: ExpansionError } {
  const [expandedFileDiff, setExpandedFileDiff] = useState(fileDiff);
  const [expansionError, setExpansionError] = useState<ExpansionError>(null);

  useEffect(() => {
    setExpandedFileDiff(fileDiff);
    setExpansionError(null);
    if (!fileDiff.isPartial) return;
    if (!workspaceRoot) {
      setExpansionError("read-error");
      return;
    }
    if (!change.postFileHash) {
      setExpansionError("missing-hash");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
        const normalizedPath = change.filePath.replaceAll("\\", "/");
        const relativePath = normalizedPath
          .toLowerCase()
          .startsWith(`${normalizedRoot.toLowerCase()}/`)
          ? normalizedPath.slice(normalizedRoot.length + 1)
          : normalizedPath.replace(/^\.?\//, "");
        const file = await readProjectFileFresh(environmentId, workspaceRoot, relativePath);
        if (!file) throw new Error("read");
        if (file.truncated) throw new Error("truncated");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(file.contents),
        );
        const currentHash = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (currentHash !== change.postFileHash) throw new Error("changed");
        const fullPatch = expandPartialPatchWithCurrentFile(
          change.patch ?? "",
          relativePath,
          file.contents,
        );
        const renderable = getRenderablePatch(fullPatch ?? undefined, `expanded:${currentHash}`, {
          upgradeFullContextFiles: true,
        });
        const [nextFileDiff] = renderable?.kind === "files" ? renderable.files : [];
        if (!nextFileDiff) throw new Error("patch");
        if (!cancelled) setExpandedFileDiff(nextFileDiff);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        if (!cancelled) {
          setExpansionError(
            reason === "changed"
              ? "changed"
              : reason === "patch"
                ? "patch"
                : reason === "truncated"
                  ? "truncated"
                  : "read-error",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [change.filePath, change.patch, change.postFileHash, environmentId, fileDiff, workspaceRoot]);

  return { expandedFileDiff, expansionError };
}
