import { discardComposerDraft } from "../../lib/discardComposerDraft";
import type { ContextMenuSource } from "@t3tools/contracts";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import { T, useGT } from "gt-react";
import { SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useTerminalLabelsByThreadKey } from "~/state/terminalSessions";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import {
  draftPenClassName,
  JUMP_HINT_SLOT_CLASS_NAME,
  JumpHintBadge,
  SIDEBAR_CARD_BODY_CLASS_NAME,
  SIDEBAR_CARD_META_LINE_CLASS_NAME,
  SIDEBAR_CARD_PROJECT_LABEL_CLASS_NAME,
} from "./SidebarThreadRow";

const EMPTY_COMPOSER_PARTS = {
  prompt: "",
  images: [],
  persistedAttachments: [],
  files: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
} as const;

/** Terminal labels for draft threads; an unsent draft stays listed while it has a terminal. */
export function useDraftTerminalLabels(): ReadonlyMap<string, string> {
  const environmentIds = useComposerDraftStore((store) => {
    const ids = new Set<string>();
    for (const session of Object.values(store.draftThreadsByThreadKey)) {
      if (session.promotedTo == null) ids.add(session.environmentId);
    }
    return [...ids].toSorted().join("\n");
  });
  return useTerminalLabelsByThreadKey(
    environmentIds === "" ? [] : (environmentIds.split("\n") as EnvironmentId[]),
  );
}

function draftTerminalLabel(
  session: DraftSessionState,
  terminalLabels: ReadonlyMap<string, string>,
): string | null {
  return terminalLabels.get(`${session.environmentId}:${session.threadId}`) ?? null;
}

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState | null;
  terminalLabel: string | null;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
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
  const { draftId, onContextMenu, onDiscard, onNavigate } = props;
  const composer = props.composer ?? EMPTY_COMPOSER_PARTS;
  const gt = useGT();
  const promptPreview =
    assistantCitationsToPlainText(
      composerFileLinksToPlainText(
        replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label),
      ),
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
      : attachmentCount === 0 && props.terminalLabel !== null
        ? props.terminalLabel
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
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-control text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "surface-sidebar-row-selected"
            : "bg-transparent hover:surface-sidebar-row-hover active:surface-sidebar-row-active",
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <div className={SIDEBAR_CARD_BODY_CLASS_NAME}>
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            {props.projectDisplayName ? (
              <span className={SIDEBAR_CARD_PROJECT_LABEL_CLASS_NAME}>
                {props.projectDisplayName}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <span
              className={cn(
                "ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end",
                props.jumpLabel && JUMP_HINT_SLOT_CLASS_NAME,
              )}
            >
              <span className="pointer-events-none inline-flex opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 motion-reduce:transition-none">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-micro"
                        aria-label={gt("Discard draft")}
                        onClick={handleDiscard}
                      />
                    }
                  >
                    <XIcon aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>Discard draft</T>
                  </TooltipPopup>
                </Tooltip>
              </span>
              {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <span
              className="min-w-0 flex-1 truncate text-start text-label leading-5 text-(--sidebar-thread-title-foreground)"
              dir={textDirection(preview)}
            >
              {preview}
            </span>
          </div>
          <div className={SIDEBAR_CARD_META_LINE_CLASS_NAME}>
            {props.environmentLabel !== null ? (
              <>
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={props.environmentMachine}
                  className="size-3.5 shrink-0 text-icon-muted"
                />
                <span className="min-w-0 flex-1 truncate">{props.environmentLabel}</span>
              </>
            ) : null}
            <span className="inline-flex shrink-0 items-center gap-1">
              <SquarePenIcon aria-hidden className={draftPenClassName} />
              <T>Draft</T>
            </span>
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
  terminalLabels: ReadonlyMap<string, string>,
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
        // Composer edits stay frozen while open; terminals come and go live.
        const isListed =
          draftTerminalLabel(session, terminalLabels) !== null ||
          (draftKey === routeDraftId
            ? routeDraftComposer !== null
            : composerDraftHasUserContent(store.draftsByThreadKey[draftKey]));
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
  terminalLabels: ReadonlyMap<string, string>;
  jumpLabelByDraftId: ReadonlyMap<DraftId, string> | null;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  environmentLabelById?: ReadonlyMap<EnvironmentId, string>;
  environmentMachineById?: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
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
      (draftId === props.routeDraftId ? props.routeDraftComposer : null) ??
      draftsByThreadKey[draftId] ??
      null;
    return session ? [{ draftId, session, composer }] : [];
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
            terminalLabel={draftTerminalLabel(session, props.terminalLabels)}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            environmentLabel={props.environmentLabelById?.get(session.environmentId) ?? null}
            environmentMachine={
              props.environmentMachineById?.get(session.environmentId) ?? "server"
            }
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
