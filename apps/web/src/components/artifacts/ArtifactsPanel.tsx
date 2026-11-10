import { FileTree, useFileTree } from "@pierre/trees/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  publishedArtifactsFromTurnItems,
  type PublishedArtifact,
} from "@t3tools/shared/publishedArtifacts";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { HtmlRenderFrame } from "~/components/chat/HtmlRenderFrame";
import { FILE_SURFACE_SUBHEADER_CLASS } from "~/components/files/fileSurfaceChrome";
import { openPreviewSession } from "~/components/preview/openPreviewSession";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadProjection } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { artifactTreeEntries } from "./artifactTreeEntries";

interface ArtifactsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly visible: boolean;
}

export function ArtifactsPanel(props: ArtifactsPanelProps) {
  void props.visible;
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const published = publishedArtifactsFromTurnItems(projection?.turnItems ?? []);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [selectedHtml, setSelectedHtml] = useState<PublishedArtifact | null>(null);

  const reportFailure = useStableCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  const openPublished = useStableCallback(async (artifact: PublishedArtifact) => {
    if (artifact.kind === "html-render" && artifact.htmlRender) {
      setSelectedHtml(artifact);
      return;
    }
    if (artifact.url) {
      const result = await openPreviewSession({
        openPreview,
        threadRef,
        url: artifact.url,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Unable to open artifact", squashAtomCommandFailure(result));
        }
        return;
      }
      useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
      return;
    }
    if (artifact.path) {
      useRightPanelStore.getState().openFile(threadRef, artifact.path);
    }
  });

  if (selectedHtml?.htmlRender) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Back to artifacts"
            onClick={() => setSelectedHtml(null)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <div className="min-w-0 truncate text-sm font-medium">{selectedHtml.title}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <HtmlRenderFrame
            environmentId={props.environmentId}
            htmlRender={selectedHtml.htmlRender}
            threadRef={threadRef}
          />
        </div>
      </div>
    );
  }

  return (
    <ArtifactsIndex artifacts={published} onOpen={(artifact) => void openPublished(artifact)} />
  );
}

function ArtifactsIndex(props: {
  readonly artifacts: ReadonlyArray<PublishedArtifact>;
  readonly onOpen: (artifact: PublishedArtifact) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const entries = artifactTreeEntries(props.artifacts);
  const artifactByPath = new Map(entries.map((entry) => [entry.path, entry.artifact]));
  const treePaths = entries.map((entry) => entry.path);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePaths =
    normalizedQuery.length === 0
      ? treePaths
      : treePaths.filter((path) => {
          const artifact = artifactByPath.get(path);
          const haystack = `${path} ${artifact?.title ?? ""} ${artifact?.url ?? ""} ${artifact?.path ?? ""}`;
          return haystack.toLowerCase().includes(normalizedQuery);
        });
  const syncingSelectionRef = useRef(false);
  const previousPathsRef = useRef<readonly string[] | null>(null);

  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (!modelPath) return;
    const artifact = artifactByPath.get(modelPath);
    if (artifact) props.onOpen(artifact);
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: handleSelectionChange,
    paths: [],
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies session artifact paths to the imperative Pierre tree model
  useEffect(() => {
    const previous = previousPathsRef.current;
    previousPathsRef.current = visiblePaths;
    if (
      previous !== null &&
      previous.length === visiblePaths.length &&
      previous.every((path, index) => path === visiblePaths[index])
    ) {
      return;
    }
    syncingSelectionRef.current = true;
    model.resetPaths(visiblePaths);
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [model, visiblePaths]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-artifacts-panel="">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
          <InputGroupInput
            type="search"
            name="artifacts-search"
            size="sm"
            value={query}
            aria-label="Search artifacts"
            placeholder="Search artifacts"
            data-workspace-focus-default
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              event.currentTarget.blur();
            }}
          />
        </InputGroup>
      </div>
      {visiblePaths.length === 0 ? (
        <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
          {normalizedQuery.length > 0
            ? "No matching artifacts."
            : "Artifacts made in this thread appear here: Claude Artifact publishes, HTML renders, and temp file writes."}
        </div>
      ) : (
        <FileTree
          model={model}
          aria-label="Artifacts"
          onClickCapture={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            const selected = model.getSelectedPaths();
            const path = selected.length === 1 ? selected[0] : undefined;
            if (!path || !visiblePaths.includes(path)) return;
            const clickedSelectedRow = event.nativeEvent
              .composedPath()
              .some(
                (node) =>
                  node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
              );
            if (!clickedSelectedRow) return;
            handleSelectionChange([path]);
          }}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
        />
      )}
    </div>
  );
}
