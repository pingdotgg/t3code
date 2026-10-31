import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowUpIcon,
  FolderPlusIcon,
  FoldersIcon,
  GitBranchIcon,
  ListFilterIcon,
  MessageSquareDashedIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
} from "lucide-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { peekRememberedThreadTimeline } from "../components/ChatView.logic";
import { PaneNotch, PANE_TAB_CLASS } from "../components/PaneNotch";
import { COMPOSER_PROMPT_PLACEHOLDER } from "../composerPlaceholder";
import { ChatPaneHeaderControls, chatPaneHeaderClassName } from "../components/chat/ChatPaneHeader";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import {
  COMPOSER_PILL_BUTTON_CLASS_NAME,
  ComposerSendPill,
} from "../components/chat/ComposerPrimaryActions";
import {
  DraftProjectGroupLabel,
  DraftProjectRow,
  formatProjectRootForDisplay,
  type ProjectPickerEntry,
  type ProjectPickerModel,
  useProjectPickerModel,
} from "../components/chat/DraftHeroHeadline";
import { ProjectEnvironmentBadge } from "../components/ProjectEnvironmentBadge";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { Button } from "../components/ui/button";
import { Toggle } from "../components/ui/toggle";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { cn } from "../lib/utils";
import type { TimelineEntry } from "../session-logic";
import { useProject, useThreadShell } from "../state/entities";
import type { LayoutTab } from "./layoutModel";
import {
  LAYOUT_TAB_ICON_CLASS,
  LAYOUT_TAB_SLOT_CLASS,
  LayoutPaneTab,
  usePaneSiblingTabs,
  useLayoutTabLabel,
} from "./PaneTabs";

/** The last messages a chat thumbnail draws; the rest would sit above the pane's top. */
const THUMBNAIL_MESSAGES = 10;
/** Each message's last characters, enough to fill a pane at any width. */
const THUMBNAIL_MESSAGE_CHARS = 1200;

const noop = () => {};

/**
 * The icons thumbnails draw, defined once: each thumbnail points at them with
 * <use> instead of carrying every icon's paths, so a 50-pane overview keeps
 * its node count, and with it every keypress and layout, close to the panes'.
 */
const THUMBNAIL_ICONS = {
  "arrow-up": ArrowUpIcon,
  "folder-plus": FolderPlusIcon,
  folders: FoldersIcon,
  "git-branch": GitBranchIcon,
  "list-filter": ListFilterIcon,
  "message-square-dashed": MessageSquareDashedIcon,
  mic: MicIcon,
  paperclip: PaperclipIcon,
  plus: PlusIcon,
};

function ThumbnailIconSprite() {
  return (
    <svg aria-hidden className="pointer-events-none absolute size-0 overflow-hidden">
      {Object.entries(THUMBNAIL_ICONS).map(([name, Icon]) => (
        <symbol key={name} id={`t3-thumbnail-${name}`} viewBox="0 0 24 24">
          <Icon />
        </symbol>
      ))}
    </svg>
  );
}

function ThumbnailIcon({
  name,
  className,
}: {
  name: keyof typeof THUMBNAIL_ICONS;
  className?: string;
}) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className}>
      <use href={`#t3-thumbnail-${name}`} />
    </svg>
  );
}

/**
 * What the thumbnails share, rendered once per host: the icon sprite, and
 * while any draft thumbnail is mounted, its project picker's model.
 */
export function PaneThumbnailServices() {
  const drafting = useSyncExternalStore(subscribePicker, () => draftThumbnails > 0);
  return (
    <>
      <ThumbnailIconSprite />
      {drafting ? <DraftThumbnailPicker /> : null}
    </>
  );
}

// One project picker model for every draft thumbnail, built only while one
// is mounted: it follows every thread shell, which settings and a strip
// without drafts have no use for.
let draftThumbnails = 0;
let pickerModel: ProjectPickerModel | null = null;
const pickerListeners = new Set<() => void>();

function notifyPicker(): void {
  for (const listener of pickerListeners) listener();
}

function subscribePicker(listener: () => void): () => void {
  pickerListeners.add(listener);
  return () => {
    pickerListeners.delete(listener);
  };
}

function useDraftThumbnailPicker(): ProjectPickerModel | null {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Count mounted draft thumbnails so the shared picker service exists only while needed.
  useEffect(() => {
    draftThumbnails += 1;
    if (draftThumbnails === 1) notifyPicker();
    return () => {
      draftThumbnails -= 1;
      if (draftThumbnails === 0) notifyPicker();
    };
  }, []);
  return useSyncExternalStore(subscribePicker, () => pickerModel);
}

/**
 * Publishes the picker model while what the rows show changes: the host
 * renders on every layout change and the picker builds a new model each
 * time, which would render every draft thumbnail again on each keypress.
 */
function DraftThumbnailPicker() {
  const model = useProjectPickerModel(null);
  const key = JSON.stringify([
    model.menuEntries.map(({ group, targetProject }) => [
      group.projectKey,
      group.displayName,
      targetProject.workspaceRoot,
    ]),
    model.pinnedEntries.map(({ group }) => group.projectKey),
    model.recentEntries.length,
    model.scratchWorkspaceRoot,
    model.scratchOffReason,
    model.showProjectEnvironments,
    model.noProjectShortcut,
  ]);
  const publishedKey = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the committed picker model to thumbnail subscribers only when its visible rows change.
  useLayoutEffect(() => {
    if (publishedKey.current === key) return;
    publishedKey.current = key;
    pickerModel = model;
    notifyPicker();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Clear the shared picker model when its mounted service leaves.
  useEffect(
    () => () => {
      pickerModel = null;
      notifyPicker();
    },
    [],
  );
  return null;
}

/** Use inert store-backed thumbnails until a chat mounts; a live list and editor per unseen pane
 * would make overview expensive. */
export const PaneThumbnail = memo(function PaneThumbnail({
  tab,
  paneId,
  leadingEdge,
  trailingEdge,
  covering = false,
  hidden = false,
}: {
  tab: LayoutTab;
  paneId: string | null;
  /** The pane's edges against the window (see LayoutPaneState). */
  leadingEdge: boolean;
  trailingEdge: boolean;
  /** Over its live chat, until the chat has loaded. */
  covering?: boolean;
  /**
   * Kept for the overview but not shown: the pane's flat surface. Its
   * contents skip style and layout, so resizing or sliding the strip's
   * panes does not lay out every thumbnail.
   */
  hidden?: boolean;
}) {
  const content = tab.content;
  const target = content.kind === "chat" ? content.target : null;
  // Hidden, its contents skip style and layout. Drawn hidden, it is styled
  // and laid out once first: hidden from the start, the overview would have
  // to style every one as it opens.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const styledRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Prime the committed thumbnail layout once before applying DOM content visibility.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (hidden && !styledRef.current) root.getBoundingClientRect();
    styledRef.current = true;
    root.style.contentVisibility = hidden ? "hidden" : "";
  }, [hidden]);
  return (
    // Inert on its own, so the pane turning inert under the overview does not
    // restyle everything in it.
    <div
      ref={rootRef}
      aria-hidden
      inert
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-background",
        covering && "absolute inset-0 z-50",
      )}
    >
      <PaneThumbnailHeader
        tab={tab}
        paneId={paneId}
        leadingEdge={leadingEdge}
        trailingEdge={trailingEdge}
        hidden={hidden}
      />
      {target?.kind === "draft" ? (
        <DraftThumbnailBody draftId={target.draftId} />
      ) : target?.kind === "server" ? (
        <ThreadThumbnailBody threadRef={target.threadRef} />
      ) : null}
    </div>
  );
});

/** The pane header's notch, as the chat and the launcher draw it. */
function PaneThumbnailHeader({
  tab,
  paneId,
  leadingEdge,
  trailingEdge,
  hidden,
}: {
  tab: LayoutTab;
  paneId: string | null;
  leadingEdge: boolean;
  trailingEdge: boolean;
  hidden: boolean;
}) {
  const label = useLayoutTabLabel(tab);
  const siblingTabs = usePaneSiblingTabs(paneId, tab.id);
  return (
    <header
      data-pane-header=""
      // The live chat's header box, Electron's included, so the notch stays put
      // when the chat takes over.
      className={chatPaneHeaderClassName({
        leadingEdge,
        trailingEdge,
        reserveNativeControlsInset: true,
      })}
    >
      {tab.content.kind === "chat" ? (
        // Where ChatView puts its pane's thread details toggle.
        <ChatPaneHeaderControls local marksHost={!hidden}>
          <Toggle variant="ghost" size="sm" tabIndex={-1}>
            <ThumbnailIcon name="list-filter" className="size-3.5" />
          </Toggle>
        </ChatPaneHeaderControls>
      ) : null}
      {/* Hidden, it leaves its pane unmarked: a marked pane draws its notch cuts. */}
      <PaneNotch marksHost={!hidden}>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {siblingTabs.before.map((sibling) => (
            <LayoutPaneTab key={sibling.id} tab={sibling} />
          ))}
          <span className={cn(LAYOUT_TAB_SLOT_CLASS, "min-w-15 overflow-hidden")}>
            <div className={PANE_TAB_CLASS}>
              <span className={LAYOUT_TAB_ICON_CLASS}>{label.icon}</span>
              <span className="min-w-0 truncate">{label.title}</span>
            </div>
          </span>
          {siblingTabs.after.map((sibling) => (
            <LayoutPaneTab key={sibling.id} tab={sibling} />
          ))}
        </div>
        {tab.content.kind === "chat" ? (
          <Button variant="bare" size="icon-xs" data-pane-notch-add="" tabIndex={-1}>
            <ThumbnailIcon name="plus" />
          </Button>
        ) : null}
      </PaneNotch>
    </header>
  );
}

/** A new thread: the project picker above its composer, as ChatView's draft hero. */
const DraftThumbnailBody = memo(function DraftThumbnailBody({ draftId }: { draftId: DraftId }) {
  const model = useDraftThumbnailPicker();
  const session = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const prompt = useComposerDraftStore((store) => store.getComposerDraft(draftId)?.prompt ?? "");
  const projectRef = session ? scopeProjectRef(session.environmentId, session.projectId) : null;
  const project = useProject(projectRef);
  if (session?.promotedTo) return <ThreadThumbnailBody threadRef={session.promotedTo} />;
  const scratch =
    model !== null && project !== null && isScratchProject(project, model.scratchWorkspaceRoot);
  const selectedProjectKey =
    scratch || !projectRef
      ? null
      : (model?.menuEntries.find(({ group }) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === projectRef.environmentId &&
              ref.projectId === projectRef.projectId,
          ),
        )?.group.projectKey ?? null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col justify-end pt-1.5 [container:draft-hero/size] sm:pt-2">
      <div className="chat-composer-lane flex min-h-0 w-full flex-1 items-center overflow-hidden py-4 [@container_draft-hero_(max-height:440px)]:hidden">
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col items-center gap-1.5">
          {model ? (
            <div className="mx-auto flex w-full max-w-110 flex-col">
              <div className="flex max-h-[calc(50dvh-7rem)] flex-col gap-0.5 overflow-y-auto">
                <ThumbnailPickerRows
                  model={model}
                  selectedProjectKey={selectedProjectKey}
                  scratchSelected={scratch}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <ComposerThumbnail prompt={prompt} branch={session?.branch ?? null} />
    </div>
  );
});

/**
 * The draft hero's project rows (ProjectPickerRows) as a picture: the same
 * rows without their hidden pin buttons and with the icons from the sprite.
 */
function ThumbnailPickerRows({
  model,
  selectedProjectKey,
  scratchSelected,
}: {
  model: ProjectPickerModel;
  selectedProjectKey: string | null;
  scratchSelected: boolean;
}) {
  const projectRow = ({ group, targetProject }: ProjectPickerEntry) => (
    <DraftProjectRow
      key={group.projectKey}
      selected={group.projectKey === selectedProjectKey}
      icon={<ProjectFavicon project={group} className="size-4 shrink-0" />}
      label={group.displayName}
      badge={
        model.showProjectEnvironments ? (
          <ProjectEnvironmentBadge
            group={group}
            primaryEnvironmentId={model.primaryEnvironmentId}
            machineByEnvironmentId={model.environmentMachineById}
          />
        ) : null
      }
      detail={formatProjectRootForDisplay(targetProject.workspaceRoot)}
      detailIsPath
      onSelect={noop}
    />
  );
  // The draft's own project always shows among the recent rows, as in the hero.
  const recentEntries = model.menuEntries
    .filter(({ group }) => !model.pinnedKeySet.has(group.projectKey))
    .filter(
      ({ group }, index) =>
        index < model.recentEntries.length || group.projectKey === selectedProjectKey,
    );
  const hiddenProjectCount =
    model.menuEntries.length - model.pinnedEntries.length - recentEntries.length;
  const iconClass = "size-4 shrink-0 text-muted-foreground";
  return (
    <>
      {model.pinnedEntries.length > 0 ? (
        <>
          <DraftProjectGroupLabel>Pinned</DraftProjectGroupLabel>
          {model.pinnedEntries.map(projectRow)}
        </>
      ) : null}
      {recentEntries.length > 0 ? (
        <>
          <DraftProjectGroupLabel>Recent</DraftProjectGroupLabel>
          {recentEntries.map(projectRow)}
        </>
      ) : null}
      {hiddenProjectCount > 0 ? (
        <DraftProjectRow
          icon={<ThumbnailIcon name="folders" className={iconClass} />}
          label="All projects…"
          detail={String(model.menuEntries.length)}
          onSelect={noop}
        />
      ) : null}
      {model.menuEntries.length > 0 ? (
        <div aria-hidden className="mx-2.5 my-1 h-px bg-border" />
      ) : null}
      {model.scratchWorkspaceRoot !== null || model.scratchOffReason !== null ? (
        <DraftProjectRow
          selected={scratchSelected}
          disabled={model.scratchWorkspaceRoot === null}
          icon={<ThumbnailIcon name="message-square-dashed" className={iconClass} />}
          label="No project"
          detail={
            model.scratchWorkspaceRoot !== null
              ? "Its own folder, no git"
              : (model.scratchOffReason ?? "")
          }
          shortcut={model.scratchWorkspaceRoot !== null ? model.noProjectShortcut : null}
          onSelect={noop}
        />
      ) : null}
      <DraftProjectRow
        icon={<ThumbnailIcon name="folder-plus" className={iconClass} />}
        label="Add project…"
        detail="Open a folder or clone a repository"
        onSelect={noop}
      />
    </>
  );
}

/**
 * A thread: the messages it last painted (ChatView remembers the recent
 * threads') above its composer. A thread's shell has its title and times
 * but no message text, so a thread not painted since load, or one that has
 * moved on since, shows its header and composer only.
 */
const ThreadThumbnailBody = memo(function ThreadThumbnailBody({
  threadRef,
}: {
  threadRef: ScopedThreadRef;
}) {
  const shell = useThreadShell(threadRef);
  const prompt = useComposerDraftStore((store) => store.getComposerDraft(threadRef)?.prompt ?? "");
  // Read on each render: a shell update (a new turn) shows what ChatView remembers since.
  const messages = rememberedMessages(threadRef, shell?.latestUserMessageAt ?? null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="chat-composer-lane flex min-h-0 flex-1 flex-col justify-end overflow-hidden pb-4">
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col">
          {messages.map((message) => (
            <ThumbnailMessage key={message.id} role={message.role} text={message.text} />
          ))}
        </div>
      </div>
      <ComposerThumbnail prompt={prompt} branch={shell?.branch ?? null} />
    </div>
  );
});

/**
 * The last messages ChatView painted for the thread, if it remembers them
 * and no message has been sent since (`latestUserMessageAt`, from its shell).
 */
function rememberedMessages(
  threadRef: ScopedThreadRef,
  latestUserMessageAt: string | null,
): { id: string; role: string; text: string }[] {
  const remembered =
    peekRememberedThreadTimeline<readonly TimelineEntry[]>(scopedThreadKey(threadRef)) ?? [];
  const recent: { id: string; role: string; text: string; createdAt: string }[] = [];
  for (let index = remembered.length - 1; index >= 0; index--) {
    const entry = remembered[index]!;
    if (entry.kind !== "message" || entry.message.role === "system") continue;
    recent.unshift(entry.message);
    if (recent.length === THUMBNAIL_MESSAGES) break;
  }
  const last = recent.at(-1);
  if (
    last &&
    latestUserMessageAt !== null &&
    Date.parse(latestUserMessageAt) > Date.parse(last.createdAt)
  ) {
    return [];
  }
  return recent;
}

/** A message row as the timeline draws it, through the thumbnail's markdown. */
function ThumbnailMessage({ role, text }: { role: string; text: string }) {
  const body = (
    <div className="chat-markdown w-full min-w-0 text-body leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {markdownBlocks(messageTail(text), role === "user")}
    </div>
  );
  if (role === "user") {
    return (
      <div className="flex w-full flex-col items-end pb-3">
        <div className="relative max-w-[80%] rounded-pane surface-bubble px-3.5 py-2.5 text-foreground">
          {body}
        </div>
      </div>
    );
  }
  return <div className="min-w-0 px-1 py-0.5 pb-4">{body}</div>;
}

/** A long message's last paragraphs, reopening the code block it cuts into. */
function messageTail(text: string): string {
  if (text.length <= THUMBNAIL_MESSAGE_CHARS) return text;
  const paragraph = text.indexOf("\n\n", text.length - THUMBNAIL_MESSAGE_CHARS);
  const cut = paragraph === -1 ? text.length - THUMBNAIL_MESSAGE_CHARS : paragraph + 2;
  const fences = text.slice(0, cut).match(/^```/gm)?.length ?? 0;
  return (fences % 2 === 1 ? "```\n" : "") + text.slice(cut);
}

/**
 * Markdown's paragraphs, lists, code blocks and inline marks as the elements
 * .chat-markdown styles, so a thumbnail reads like the timeline; images go,
 * links keep their text. A user's line breaks stay, as in their bubble.
 */
function markdownBlocks(text: string, lineBreaks: boolean): ReactNode[] {
  const blocks: ReactNode[] = [];
  text.split(/^```[^\n]*$\n?/m).forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push(
        <pre key={blocks.length}>
          <code>{part.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    for (const block of part.split(/\n\s*\n/)) {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) continue;
      const bullets = lines.every((line) => /^\s*[-*+] /.test(line));
      const numbers = lines.every((line) => /^\s*\d+[.)] /.test(line));
      if (bullets || numbers) {
        let item = 0;
        const items = lines.map((line) => (
          <li key={item++}>{inlineMarkdown(line.replace(/^\s*(?:[-*+]|\d+[.)]) /, ""))}</li>
        ));
        blocks.push(
          bullets ? <ul key={blocks.length}>{items}</ul> : <ol key={blocks.length}>{items}</ol>,
        );
      } else if (/^#{1,6} /.test(lines[0]!)) {
        blocks.push(
          <p key={blocks.length}>
            <strong>{inlineMarkdown(lines.join(" ").replace(/^#{1,6} /, ""))}</strong>
          </p>,
        );
      } else {
        blocks.push(
          <p key={blocks.length} className={lineBreaks ? "whitespace-pre-line" : undefined}>
            {inlineMarkdown(lines.join(lineBreaks ? "\n" : " "))}
          </p>,
        );
      }
    }
  });
  return blocks;
}

const INLINE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

function inlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    nodes.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [, link, bold, code] = match;
    if (link !== undefined) nodes.push(<a key={last}>{link}</a>);
    else if (bold !== undefined) nodes.push(<strong key={last}>{bold}</strong>);
    else if (code !== undefined) nodes.push(<code key={last}>{code}</code>);
  }
  nodes.push(text.slice(last));
  return nodes;
}

/** The composer tray at rest: the prompt or its placeholder, the send pill and the branch. */
function ComposerThumbnail({ prompt, branch }: { prompt: string; branch: string | null }) {
  return (
    <div className="chat-composer-lane w-full pt-1.5 pb-4 sm:pt-2">
      <div className="relative z-10 mx-auto w-full max-w-(--chat-content-max-width)">
        <ComposerSurface.Shell contextRow>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <div className="relative flex min-w-0 items-center gap-1.5 py-2 ps-3.5 pe-2">
                <div
                  className={cn(
                    "min-w-0 flex-1 truncate text-prompt leading-8",
                    prompt ? "text-foreground" : "text-placeholder",
                  )}
                >
                  {prompt || COMPOSER_PROMPT_PLACEHOLDER}
                </div>
                <span className="flex size-8 shrink-0 items-center justify-center">
                  <ThumbnailIcon name="paperclip" className="size-[15px] text-composer-icon" />
                </span>
                <ComposerSendPill>
                  <span className={cn(COMPOSER_PILL_BUTTON_CLASS_NAME, "w-7.5")}>
                    <ThumbnailIcon name="mic" className="size-3.5 text-composer-icon" />
                  </span>
                  <span
                    className={cn(
                      COMPOSER_PILL_BUTTON_CLASS_NAME,
                      "w-7.5",
                      !prompt && "opacity-64",
                    )}
                  >
                    <ThumbnailIcon name="arrow-up" className="size-3.5" />
                  </span>
                </ComposerSendPill>
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
          <ComposerSurface.ContextStrip>
            <span className="flex min-w-0 items-center gap-1.5 px-1.5">
              <ThumbnailIcon name="git-branch" className="size-3 shrink-0" />
              {branch ? <span className="min-w-0 truncate">{branch}</span> : null}
            </span>
          </ComposerSurface.ContextStrip>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
