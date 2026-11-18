import { discardComposerDraft } from "../../lib/discardComposerDraft";
import type { ContextMenuSource } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { T, useGT } from "gt-react";
import { AlarmClockIcon, AlarmClockOffIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { isDraftSnoozed, resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { snoozeWakeLabel, type SnoozePreset } from "../Sidebar.snooze";
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
import { draftPenClassName, draftSurfaceClassName, SnoozeMenuButton } from "./SidebarThreadRow";

type SidebarDraftSection = "drafts" | "snoozed";

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  /** Set only in the Snoozed shelf; rows get the label, not the clock, so the memo holds. */
  wakeLabel: string | null;
  /** An emptied draft has nothing to come back to, so it offers no snooze. */
  canSnooze: boolean;
  timestampFormat: TimestampFormat;
  onSnooze: (draftId: DraftId, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (draftId: DraftId) => void;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (
    draftId: DraftId,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate, onSnooze, onUnsnooze } = props;
  const gt = useGT();
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
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
    statusLabel: props.wakeLabel === null ? gt("Unsent draft") : gt("Snoozed draft"),
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested discard button belong to the button:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of discarding.
    if ((event.target as HTMLElement).closest("button")) return;
    // The snooze menu is portaled, but React still bubbles its keys here.
    if (!event.currentTarget.contains(event.target as Node)) return;
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
  const handleUnsnooze = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(draftId);
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
            <span className="relative ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              {props.wakeLabel !== null ? (
                <span className="inline-flex items-center gap-1 text-xs text-info-foreground tabular-nums transition-opacity group-focus-within/sidebar-row:opacity-0 group-hover/sidebar-row:opacity-0">
                  <AlarmClockIcon aria-hidden className="size-3" />
                  {props.wakeLabel}
                </span>
              ) : null}
              <span
                className={cn(
                  "pointer-events-none flex h-full items-center opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                  props.wakeLabel !== null && "absolute inset-y-0 right-0",
                  snoozeMenuOpen && "pointer-events-auto opacity-100",
                )}
              >
                {props.wakeLabel !== null ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-micro"
                          variant="ghost-muted"
                          aria-label={gt("Wake draft now")}
                          onClick={handleUnsnooze}
                        >
                          <AlarmClockOffIcon />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">
                      <T>Wake draft now</T>
                    </TooltipPopup>
                  </Tooltip>
                ) : !props.canSnooze ? null : (
                  <SnoozeMenuButton
                    open={snoozeMenuOpen}
                    onOpenChange={setSnoozeMenuOpen}
                    onSnooze={(preset) => onSnooze(draftId, preset)}
                    timestampFormat={props.timestampFormat}
                    environmentId={props.session.environmentId}
                    label={gt("Snooze draft")}
                  />
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-label={gt("Discard draft")}
                        onClick={handleDiscard}
                      >
                        <XIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">
                    <T>Discard draft</T>
                  </TooltipPopup>
                </Tooltip>
              </span>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{preview}</div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  section: SidebarDraftSection;
  /** A collapsed Snoozed shelf still shows the open draft, like it does the open thread. */
  routeOnly?: boolean;
  snoozeNowMs: number;
  timestampFormat: TimestampFormat;
  onSnoozeDraft: (draftId: DraftId, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnoozeDraft: (draftId: DraftId) => void;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
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
        Object.keys(store.draftThreadsByThreadKey).map(
          (key) => [key, store.draftsByThreadKey[key]] as const,
        ),
      ),
    ),
  );
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const session = draftThreadsByThreadKey[draftId];
      const composer = draftsByThreadKey[draftId];
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = (() => {
    const rows: SidebarDraftRowData[] = [];
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (isDraftSnoozed(session, props.snoozeNowMs) !== (props.section === "snoozed")) {
        continue;
      }
      if (props.routeOnly && draftKey !== props.routeDraftId) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (draftKey === props.routeDraftId) {
        // The open snoozed draft shows its live text, and stays even when emptied, as counted.
        if (props.section === "snoozed" && composer) {
          rows.push({ draftId: DraftId.make(draftKey), session, composer });
        } else if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push({ ...frozenActive.row, session });
        }
        continue;
      }
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) =>
      props.section === "snoozed"
        ? (left.session.snoozedUntil ?? "").localeCompare(right.session.snoozedUntil ?? "")
        : right.session.createdAt.localeCompare(left.session.createdAt),
    );
    return rows;
  })();
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
            session={session}
            composer={composer}
            wakeLabel={
              props.section === "snoozed" && session.snoozedUntil
                ? snoozeWakeLabel(session.snoozedUntil, {
                    now: new Date(props.snoozeNowMs).toISOString(),
                  })
                : null
            }
            canSnooze={composerDraftHasUserContent(draftsByThreadKey[draftId])}
            timestampFormat={props.timestampFormat}
            onSnooze={props.onSnoozeDraft}
            onUnsnooze={props.onUnsnoozeDraft}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      {props.section === "drafts" ? (
        <li
          aria-hidden
          data-testid="sidebar-draft-divider"
          className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
        />
      ) : null}
    </>
  );
});
