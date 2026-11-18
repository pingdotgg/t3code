import { parseDiffFromFile } from "@pierre/diffs";
import type { File as FileInstance, PostRenderPhase } from "@pierre/diffs";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useEffect, type ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { getRenderablePatch } from "~/lib/diffRendering";
import { useStableCallback } from "~/hooks/useStableCallback";
import { fileChangeRanges, paintFileChanges } from "../diffs/changeIndicators";

type FilePostRender = <LAnnotation>(
  node: HTMLElement,
  instance: FileInstance<LAnnotation, undefined>,
  phase: PostRenderPhase,
) => void;

export function FileChangeSurface({
  environmentId,
  cwd,
  path,
  contents,
  mutationId,
  enabled,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly contents: string;
  readonly mutationId: string | null;
  readonly enabled: boolean;
  readonly children: (onPostRender: FilePostRender) => ReactNode;
}) {
  const rootRef = useRef<ShadowRoot | null>(null);
  const preview = useEnvironmentQuery(
    enabled
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId,
            input: {
              cwd,
              sourceKind: "working-tree",
              file: { path, previousPath: null, sourceKind: "working-tree" },
            },
          }),
          mutationId,
        )
      : null,
  );
  const source = preview.data?.sources.find((source) => source.kind === "working-tree");
  const parsed = getRenderablePatch(source?.diff);
  const changedFile = parsed?.kind === "files" ? parsed.files[0] : undefined;
  const baseline = useEnvironmentQuery(
    source && !source.truncated
      ? revisionedQuery(
          reviewEnvironment.fileContents({
            environmentId,
            input: {
              cwd,
              sourceKind: "working-tree",
              changeType: changedFile?.type ?? "change",
              baseRef: source.baseRef,
              headRef: source.headRef,
              oldPath: changedFile?.prevName ?? changedFile?.name ?? path,
              newPath: changedFile?.name ?? path,
            },
          }),
          mutationId,
        )
      : null,
  );
  const fileDiff = baseline.data
    ? parseDiffFromFile(
        { name: path, contents: baseline.data.oldContents },
        { name: path, contents },
      )
    : null;
  const ranges = fileDiff ? fileChangeRanges(fileDiff) : [];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints mounted shadow-DOM lines when the Git baseline or editor contents change
  useEffect(() => {
    if (rootRef.current) paintFileChanges(rootRef.current, ranges);
  }, [ranges]);
  const onPostRender: FilePostRender = useStableCallback((node, _instance, phase) => {
    rootRef.current = phase === "unmount" ? null : node.shadowRoot;
    if (rootRef.current) paintFileChanges(rootRef.current, ranges);
  });
  return children(onPostRender);
}
