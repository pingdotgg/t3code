import { T } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Hash from "effect/Hash";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { Button } from "../ui/button";
import { useProjectFileQuery } from "./projectFilesQueryState";
import ReadOnlySourcePreview from "./ReadOnlySourcePreview";

/** The explorer opens ordinary source without changing the active Git comparison. */
export function WorkspaceSourcePreview(props: {
  environmentId: EnvironmentId;
  cwd: string;
  path: string | null;
  revision: string | null;
  onOpenFile: (path: string) => void;
}) {
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.path);
  useWorkspaceMutationRefresh({
    mutationId: props.revision,
    resourceKey: `${props.environmentId}:${props.cwd}:${props.path}`,
    refresh: file.refresh,
  });
  if (!props.path)
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        <T>Select a file to view its contents.</T>
      </p>
    );
  if (file.error)
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs">
        <p>{file.error}</p>
        <Button size="xs" variant="outline" onClick={file.refresh}>
          <T>Retry</T>
        </Button>
        <Button size="xs" variant="outline" onClick={() => props.onOpenFile(props.path!)}>
          <T>Open file</T>
        </Button>
      </div>
    );
  if (!file.data)
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        <T>Loading file…</T>
      </p>
    );
  return (
    <>
      {file.data.truncated ? (
        <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          <T>Showing the first 1 MB of this file.</T>
        </p>
      ) : null}
      <ReadOnlySourcePreview
        name={props.path}
        text={file.data.contents}
        cacheKey={`${props.cwd}:${props.path}:${Hash.string(file.data.contents)}`}
      />
    </>
  );
}
