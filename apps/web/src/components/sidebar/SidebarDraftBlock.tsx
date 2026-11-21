import { discardComposerDraft } from "../../lib/discardComposerDraft";
import type { ContextMenuSource } from "@t3tools/contracts";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { T, useGT } from "gt-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { markdownProseDirection } from "~/textDirection";
import { BidiMarkdownText } from "../chat/BidiMarkdownText";
import {
  draftPenClassName,
  draftSurfaceClassName,
  JUMP_HINT_SLOT_CLASS_NAME,
  JumpHintBadge,
} from "./SidebarThreadRow";

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (
    draftId: DraftId,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const gt = useGT();
  const promptPreview =
    assistantCitationsToPlainText(
      replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label),
    )
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
      : gt("{count, plural, one {{count} attachment} other {{count} attachments}}", {
          count: attachmentCount,
        });
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: gt("Unsent draft"),
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
      onContextMenu(draftId, { x: rect.left, y: rect.bottom }, "keyboard");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
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
                props.jumpLabel && JUMP_HINT_SLOT_CLASS_NAME,
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Discard draft")}
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  <T>Discard draft</T>
                </TooltipPopup>
              </Tooltip>
              {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
            </span>
          </div>
          <div
            className="mt-0.5 truncate text-sm font-medium text-foreground/90"
            dir={markdownProseDirection(preview)}
          >
            <BidiMarkdownText text={preview} />
          </div>
        </div>
      </div>
    </li>
  );
});

function listedDraftComposer(draftId: string | null): ComposerThreadDraftState | null {
  if (draftId === null) return null;
  const store = useComposerDraftStore.getState();
  const session = store.draftThreadsByThreadKey[draftId];
  const composer = store.draftsByThreadKey[draftId];
  return session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
    ? composer
    : null;
}

/**
 * Unsent drafts listed above the threads, newest first. The open draft keeps the
 * row it had on arrival (frozen content), so its row and jump number stay put.
 */
export function useSidebarDrafts(
  scopedProjectKeys: ReadonlySet<string> | null,
  routeDraftId: string | null,
): { draftIds: readonly DraftId[]; routeDraftComposer: ComposerThreadDraftState | null } {
  const [frozenRoute, setFrozenRoute] = useState<{
    routeDraftId: string | null;
    composer: ComposerThreadDraftState | null;
  }>({ routeDraftId: null, composer: null });
  if (frozenRoute.routeDraftId !== routeDraftId) {
    setFrozenRoute({ routeDraftId, composer: listedDraftComposer(routeDraftId) });
  }
  const routeDraftComposer =
    frozenRoute.routeDraftId === routeDraftId ? frozenRoute.composer : null;
  const draftIds = useComposerDraftStore(
    useShallow((store) => {
      const listed: [string, DraftSessionState][] = [];
      for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
        if (session.promotedTo != null) continue;
        if (
          scopedProjectKeys !== null &&
          !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
        ) {
          continue;
        }
        const isListed =
          draftKey === routeDraftId
            ? routeDraftComposer !== null
            : composerDraftHasUserContent(store.draftsByThreadKey[draftKey]);
        if (isListed) listed.push([draftKey, session]);
      }
      listed.sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt));
      return listed.map(([draftKey]) => DraftId.make(draftKey));
    }),
  );
  return { draftIds, routeDraftComposer };
}

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  draftIds: readonly DraftId[];
  routeDraftComposer: ComposerThreadDraftState | null;
  jumpLabelByDraftId: ReadonlyMap<DraftId, string> | null;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (
    draftId: DraftId,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        props.draftIds.map((draftId) => [draftId, store.draftsByThreadKey[draftId]] as const),
      ),
    ),
  );
  const drafts = props.draftIds.flatMap((draftId) => {
    const session = draftThreadsByThreadKey[draftId];
    const composer =
      draftId === props.routeDraftId ? props.routeDraftComposer : draftsByThreadKey[draftId];
    return session && composer ? [{ draftId, session, composer }] : [];
  });
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            jumpLabel={props.jumpLabelByDraftId?.get(draftId) ?? null}
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
