import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type BotWorkersBoard,
  type BotGroups,
  botWorkersBoard,
} from "@t3tools/client-runtime/state/thread-grouping";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { contextMenuSourceOf } from "~/contextMenuSource";
import { useScratchProject } from "~/hooks/useScratchProject";
import { cn } from "~/lib/utils";
import { botFilesEnvironment } from "~/state/botFiles";
import { BotAvatar } from "../bot/BotAvatar";
import { type BotAvatarState, botLiveMomentMs, resolveBotStatus } from "../bot/botStatus";
import { openNewBotDialog } from "../chat/NewBotDialog";
import { Badge } from "../ui/badge";
import { ThreadRenameInput } from "./SidebarThreadRow";

// Long enough for a state change to read as the Bot reacting, short enough not to keep painting.
// Now and then each avatar comes alive for a moment, then settles; never a running loop.
const FIDGET_EVERY_MS = 7000;
const FIDGET_SPREAD_MS = 4000;
const jitter = (maxMs: number) => Math.random() * maxMs;

type ThreadContextMenuHandler = (
  threadRef: ScopedThreadRef,
  position: { x: number; y: number },
  source: ContextMenuSource,
) => void;

const ROW_CLASS =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The sidebar's one inline rename, shared with thread rows. */
export interface SidebarRename {
  readonly threadKey: string | null;
  readonly title: string;
  readonly onTitleChange: (title: string) => void;
  readonly onCommit: (threadRef: ScopedThreadRef, title: string) => void;
  readonly onCancel: () => void;
}

function BotRow(props: {
  bot: EnvironmentThreadShell;
  board: BotWorkersBoard<EnvironmentThreadShell>;
  isActive: boolean;
  rename: SidebarRename;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: ThreadContextMenuHandler;
}) {
  const gt = useGT();
  const threadRef = scopeThreadRef(props.bot.environmentId, props.bot.id);
  const status = resolveBotStatus(props.bot, props.board);
  const [hovered, setHovered] = useState(false);
  const [shownState, setShownState] = useState(status.state);
  const [reactingTo, setReactingTo] = useState<BotAvatarState | null>(null);
  if (shownState !== status.state) {
    setShownState(status.state);
    setReactingTo(status.state);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer ends the avatar's short live reaction to a state change
  useEffect(() => {
    if (reactingTo === null) return;
    const timer = setTimeout(() => setReactingTo(null), botLiveMomentMs(reactingTo));
    return () => clearTimeout(timer);
  }, [reactingTo]);
  const [fidgeting, setFidgeting] = useState(false);
  const state = status.state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer chain wakes the avatar briefly every few seconds
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const rest = () => {
      timer = setTimeout(wake, FIDGET_EVERY_MS + jitter(FIDGET_SPREAD_MS));
    };
    const wake = () => {
      if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        rest();
        return;
      }
      setFidgeting(true);
      timer = setTimeout(() => {
        setFidgeting(false);
        rest();
      }, botLiveMomentMs(state));
    };
    // A random first wait spreads the Bots so they rarely move together.
    timer = setTimeout(wake, jitter(FIDGET_EVERY_MS + FIDGET_SPREAD_MS));
    return () => clearTimeout(timer);
  }, [state]);
  const avatar = (
    <BotAvatar
      threadId={props.bot.id}
      choice={props.bot.botConfig?.avatar}
      state={status.state}
      mood={status.mood}
      size={20}
      live={hovered || reactingTo !== null || fidgeting}
    />
  );
  // An input cannot sit inside the row's button, so renaming swaps the row for a plain one.
  if (props.rename.threadKey === scopedThreadKey(threadRef)) {
    return (
      <li>
        <div className={cn(ROW_CLASS, "bg-sidebar-row-active text-sidebar-foreground")}>
          {avatar}
          <ThreadRenameInput
            title={props.rename.title}
            onTitleChange={props.rename.onTitleChange}
            onCommit={() => props.rename.onCommit(threadRef, props.rename.title)}
            onCancel={props.rename.onCancel}
          />
        </div>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onNavigate(threadRef)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            threadRef,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className={cn(
          ROW_CLASS,
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        {avatar}
        <span className="min-w-0 flex-1 truncate">{props.bot.title}</span>
        {status.needsYou > 0 ? (
          <Badge variant="warning" size="sm">
            {gt("{count, plural, one {Needs you} other {{count} need you}}", {
              count: status.needsYou,
            })}
          </Badge>
        ) : status.state === "blocked" ? (
          <span className="shrink-0 text-2xs text-destructive-foreground">
            <T>Stopped</T>
          </span>
        ) : status.state === "working" || status.state === "thinking" ? (
          <span className="shrink-0 text-2xs text-sidebar-muted-foreground">
            <T>Working</T>
          </span>
        ) : null}
      </button>
    </li>
  );
}

function NewBotRow() {
  const { scratchEnvironmentId } = useScratchProject();
  const environmentId = scratchEnvironmentId(null);
  const canCreate = useAtomValue(botFilesEnvironment.create.permissionAtom(environmentId));
  if (environmentId === null || !canCreate) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => openNewBotDialog(environmentId)}
        className={cn(
          ROW_CLASS,
          "h-7 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <PlusIcon aria-hidden className="mx-0.5 size-4 shrink-0" />
        <T>New Bot</T>
      </button>
    </li>
  );
}

/** Bots sit above the thread list as their own rows; their workers live on the Bot's page. */
export function SidebarBotBlock(props: {
  botGroups: BotGroups<EnvironmentThreadShell>;
  routeThreadKey: string | null;
  rename: SidebarRename;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: ThreadContextMenuHandler;
}) {
  const gt = useGT();
  return (
    <ul aria-label={gt("Bots")} className="mb-2 flex flex-col gap-px">
      {props.botGroups.bots.map((bot) => {
        const key = scopedThreadKey(scopeThreadRef(bot.environmentId, bot.id));
        const board = botWorkersBoard(props.botGroups, key);
        const routeKey = props.routeThreadKey;
        // A worker thread opens inside its Bot, so the Bot's row stays current there.
        const isActive =
          routeKey !== null &&
          (routeKey === key ||
            [...board.needsYou, ...board.working, ...board.done].some(
              (member) =>
                scopedThreadKey(scopeThreadRef(member.environmentId, member.id)) === routeKey,
            ));
        return (
          <BotRow
            key={key}
            bot={bot}
            board={board}
            isActive={isActive}
            rename={props.rename}
            onNavigate={props.onNavigate}
            onContextMenu={props.onContextMenu}
          />
        );
      })}
      <NewBotRow />
    </ul>
  );
}
