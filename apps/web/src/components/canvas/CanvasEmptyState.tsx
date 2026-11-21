import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { FileUp, PenTool, Plus, Shapes } from "lucide-react";

import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { useEnvironmentQuery } from "~/state/query";
import { definePluginComponent } from "~/plugins/features";

import type { CanvasImporter } from "./canvasImport";

const formatUpdated = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const CanvasEmptyState = definePluginComponent(
  "component:components/canvas/CanvasEmptyState",
  PluginOriginalCanvasEmptyState,
);

/** The `canvas:new` tab: open one of the project's canvases, start one, or import one. */
function PluginOriginalCanvasEmptyState(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly importer: CanvasImporter;
}) {
  const { threadRef, projectId, importer } = props;
  const gt = useGT();
  const list = useEnvironmentQuery(
    projectId === null
      ? null
      : canvasEnvironment.list({ environmentId: threadRef.environmentId, input: { projectId } }),
  );
  const documents = (list.data ?? []).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const actions = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!importer.available || importer.importing}
        onClick={() => void importer.createBlank()}
      >
        <Plus />
        <T>New canvas</T>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!importer.available || importer.importing}
        onClick={importer.pickFile}
      >
        <FileUp />
        <T>Import</T>
      </Button>
    </div>
  );

  if (projectId === null) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <PenTool className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>
          <T>No project</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>Canvases belong to a project. Open a project thread first.</T>
        </EmptyDescription>
      </Empty>
    );
  }

  // No list yet: still loading (or reconnecting), or it failed.
  if (list.data === null) {
    if (!list.error) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="sm" />
        </div>
      );
    }
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <PenTool className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>
          <T>Canvases unavailable</T>
        </EmptyTitle>
        <EmptyDescription>{list.error}</EmptyDescription>
        <Button variant="outline" size="sm" onClick={list.refresh}>
          <T>Retry</T>
        </Button>
      </Empty>
    );
  }

  if (documents.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <PenTool className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>
          <T>No canvases yet</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>
            Start a blank canvas, or import a Pencil, Figma, SVG, image, or ZIP file. You can also
            drop one here.
          </T>
        </EmptyDescription>
        {actions}
      </Empty>
    );
  }

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shapes className="size-4 shrink-0" />
            <h2 className="font-medium">
              <T>Canvases</T>
            </h2>
          </div>
          <DiscoveryList>
            {documents.map((document) => (
              <DiscoveryListRow
                key={document.id}
                icon={
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                    <PenTool className="size-4" />
                  </span>
                }
                title={document.name}
                description={
                  formatUpdated(document.updatedAt)
                    ? gt(
                        "{count, plural, one {{count} layer · {updated}} other {{count} layers · {updated}}}",
                        { count: document.nodeCount, updated: formatUpdated(document.updatedAt) },
                      )
                    : gt("{count, plural, one {{count} layer} other {{count} layers}}", {
                        count: document.nodeCount,
                      })
                }
                onClick={() =>
                  useRightPanelStore.getState().openCanvas(threadRef, document.id, document.name)
                }
              />
            ))}
          </DiscoveryList>
        </div>
        {actions}
      </div>
    </div>
  );
}
