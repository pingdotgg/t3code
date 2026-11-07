import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { draftPenClassName, draftSurfaceClassName } from "./SidebarThreadRow";

type DraftListState = Pick<
  ReturnType<typeof useComposerDraftStore.getState>,
  "draftThreadsByThreadKey" | "draftsByThreadKey"
>;

function isListedDraft(store: DraftListState, draftKey: string): boolean {
  const session = store.draftThreadsByThreadKey[draftKey];
  return (
    session !== undefined &&
    session.promotedTo == null &&
    composerDraftHasUserContent(store.draftsByThreadKey[draftKey])
  );
}

function listedRouteDraftComposer(routeDraftId: string | null): ComposerThreadDraftState | null {
  if (routeDraftId === null) return null;
  const store = useComposerDraftStore.getState();
  return isListedDraft(store, routeDraftId)
    ? (store.draftsByThreadKey[routeDraftId] ?? null)
    : null;
}

export interface SidebarDrafts {
  /** Listed drafts, newest first. The block renders exactly these rows. */
  readonly draftIds: readonly DraftId[];
  /** The route draft as it was on arrival, or null when it is not listed. */
  readonly routeDraftComposer: ComposerThreadDraftState | null;
}

/**
 * Drafts the sidebar lists; numbered jumps count these rows. The route draft
 * keeps its arrival row and preview. This lives in the sidebar, not the block,
 * because search unmounts the block and must not split a row from its number.
 */
export function useSidebarDrafts(
  scopedProjectKeys: ReadonlySet<string> | null,
  routeDraftId: string | null,
): SidebarDrafts {
  // Ids only, not composers, so typing does not re-render the sidebar.
  const candidateIds = useComposerDraftStore(
    useShallow((store) =>
      Object.entries(store.draftThreadsByThreadKey)
        .filter(
          ([draftKey, session]) =>
            session.promotedTo == null &&
            (scopedProjectKeys === null ||
              scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)) &&
            (draftKey === routeDraftId || isListedDraft(store, draftKey)),
        )
        .toSorted(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt))
        .map(([draftKey]) => DraftId.make(draftKey)),
    ),
  );
  const [frozenRoute, setFrozenRoute] = useState<{
    routeDraftId: string | null;
    composer: ComposerThreadDraftState | null;
  }>({ routeDraftId: null, composer: null });
  if (frozenRoute.routeDraftId !== routeDraftId) {
    // Read once on arrival inside the updater; React re-runs this render with it.
    setFrozenRoute(() => ({ routeDraftId, composer: listedRouteDraftComposer(routeDraftId) }));
  }
  const routeDraftComposer =
    frozenRoute.routeDraftId === routeDraftId ? frozenRoute.composer : null;
  return {
    draftIds:
      routeDraftComposer !== null
        ? candidateIds
        : candidateIds.filter((draftId) => draftId !== routeDraftId),
    routeDraftComposer,
  };
}

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested discard button belong to the button:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of discarding.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(draftId, { x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY });
  };
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDiscard(draftId);
  };
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`draft:${draftId}`}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : draftSurfaceClassName,
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span
              className={cn(
                "ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end",
                props.jumpLabel && "[&>:not([data-jump-hint])]:hidden",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
              {props.jumpLabel ? (
                <Kbd aria-hidden data-jump-hint>
                  {props.jumpLabel}
                </Kbd>
              ) : null}
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {preview}
          </div>
        </div>
      </div>
    </li>
  );
});

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  draftIds: readonly DraftId[];
  routeDraftComposer: ComposerThreadDraftState | null;
  /** Labels by list position, or null while hints are hidden. */
  jumpLabels: readonly (string | null)[] | null;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        Object.keys(store.draftThreadsByThreadKey).map(
          (key) => [key, store.draftsByThreadKey[key]] as const,
        ),
      ),
    ),
  );
  const drafts = props.draftIds.flatMap((draftId, slot) => {
    const session = draftThreadsByThreadKey[draftId];
    const composer =
      (draftId === props.routeDraftId ? props.routeDraftComposer : null) ??
      draftsByThreadKey[draftId];
    return session && composer ? [{ draftId, slot, session, composer }] : [];
  });
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session, slot }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            jumpLabel={props.jumpLabels?.[slot] ?? null}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
