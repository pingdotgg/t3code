import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { MessageCirclePlusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { newThreadId } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SideChatSession } from "./SideChat";

export interface SideChatRequest {
  readonly serial: number;
  readonly prompt: string;
}
interface Tab {
  id: ThreadId;
  prompt: string;
  pending: boolean;
  error?: string;
}

export function SideChat({
  source,
  cwd,
  request,
  onClose,
  settings,
  instanceEntries,
  visible = true,
}: {
  visible?: boolean;
  source: EnvironmentThread;
  cwd: string | undefined;
  request: SideChatRequest;
  onClose: () => void;
  settings: UnifiedSettings;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const snapshot = useAtomValue(environmentSnapshotAtom(source.environmentId));
  const [tabs, setTabs] = useState<Tab[]>(() =>
    (snapshot?.threads ?? [])
      .filter((t) => t.sideChatOf === source.id)
      .map((t) => ({ id: t.id, prompt: "", pending: false })),
  );
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const latestUserMessage = snapshot?.threads.find(
    (thread) => thread.id === source.id,
  )?.latestUserMessageAt;
  const previousUserMessage = useRef(latestUserMessage);
  const [olderTabIds, setOlderTabIds] = useState<ThreadId[]>([]);
  useEffect(() => {
    const previous = previousUserMessage.current;
    if (latestUserMessage === undefined) return;
    previousUserMessage.current = latestUserMessage;
    if (
      latestUserMessage &&
      previous !== undefined &&
      (previous === null || latestUserMessage > previous)
    ) {
      setOlderTabIds(tabsRef.current.map((tab) => tab.id));
    }
  }, [latestUserMessage]);
  const olderTabs = tabs.filter((tab) => olderTabIds.includes(tab.id));
  const [activeId, setActiveId] = useState<ThreadId | null>(null);
  const [closing, setClosing] = useState<ThreadId | null>(null);
  const handled = useRef<number | null>(null);
  const createSideChat = useAtomCommand(threadEnvironment.createSideChat, { reportFailure: false });
  const keep = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const remove = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const host = useRef<HTMLElement>(null);
  const [maxWidth, setMaxWidth] = useState(1600);
  useEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => setMaxWidth(Math.max(320, parent.clientWidth * 0.7)));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const { width, handlers, setWidth } = useResizableWidth({
    storageKey: "t3-side-chat-width",
    defaultWidth: 600,
    minWidth: 320,
    maxWidth,
    edge: "left",
  });
  const add = useCallback(
    async (prompt = "") => {
      const id = newThreadId();
      setTabs((current) => [...current, { id, prompt, pending: true }]);
      setActiveId(id);
      try {
        const result = await createSideChat({
          environmentId: source.environmentId,
          input: { threadId: id, sourceThreadId: source.id },
        });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        setTabs((current) => current.map((t) => (t.id === id ? { ...t, pending: false } : t)));
      } catch (error) {
        setTabs((current) =>
          current.map((t) => (t.id === id ? { ...t, pending: false, error: String(error) } : t)),
        );
      }
    },
    [createSideChat, source.environmentId, source.id],
  );
  useEffect(() => {
    if (handled.current === request.serial) return;
    handled.current = request.serial;
    void add(request.prompt);
  }, [add, request]);
  const forget = (id: ThreadId) => {
    const remaining = tabsRef.current.filter((t) => t.id !== id);
    tabsRef.current = remaining;
    setTabs(remaining);
    setActiveId((current) => (current === id ? (remaining.at(-1)?.id ?? null) : current));
    if (!remaining.length) onClose();
  };
  const close = async (tab: Tab) => {
    if (tab.pending || closing) return;
    if (tab.error && !snapshot?.threads.some((thread) => thread.id === tab.id)) {
      forget(tab.id);
      return;
    }
    setClosing(tab.id);
    try {
      const result = await remove({
        environmentId: source.environmentId,
        input: { threadId: tab.id },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      forget(tab.id);
    } catch (error) {
      setTabs((current) =>
        current.map((t) => (t.id === tab.id ? { ...t, error: String(error) } : t)),
      );
    } finally {
      setClosing(null);
    }
  };
  const keepTab = async (tab: Tab) => {
    if (tab.pending || closing) return;
    setClosing(tab.id);
    try {
      const result = await keep({
        environmentId: source.environmentId,
        input: { threadId: tab.id, sideChatOf: null },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      forget(tab.id);
    } catch (error) {
      setTabs((current) =>
        current.map((t) => (t.id === tab.id ? { ...t, error: String(error) } : t)),
      );
    } finally {
      setClosing(null);
    }
  };
  return (
    <aside
      ref={host}
      aria-hidden={!visible}
      inert={!visible}
      data-side-chat
      role="complementary"
      aria-label="Side chats"
      style={{ "--side-chat-width": `${visible ? width : 0}px` } as CSSProperties}
      className={`${visible ? "" : "invisible !border-0 max-sm:hidden"} absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col border-l border-border bg-background shadow-xl sm:relative sm:inset-auto sm:w-[var(--side-chat-width)] sm:max-w-[70%] sm:shrink-0 motion-safe:transition-[width] motion-safe:duration-200`}
    >
      <div
        role="separator"
        aria-label="Resize side chats"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={320}
        aria-valuemax={Math.round(maxWidth)}
        tabIndex={0}
        onDoubleClick={() => setWidth(600)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setWidth(width + (event.key === "ArrowLeft" ? 32 : -32));
          }
          if (event.key === "Home") {
            event.preventDefault();
            setWidth(320);
          }
          if (event.key === "End") {
            event.preventDefault();
            setWidth(maxWidth);
          }
        }}
        {...handlers}
        className="absolute inset-y-0 -left-1 z-50 hidden w-2 cursor-col-resize touch-none hover:bg-primary/20 sm:block"
      />
      <div className="flex min-h-12 items-center gap-1 border-b border-border py-2 pr-28 pl-2">
        <div role="tablist" aria-label="Side chats" className="flex min-w-0 gap-1 overflow-x-auto">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              className={`flex shrink-0 items-center rounded-xl border ${activeId === tab.id ? "border-border bg-muted" : "border-transparent bg-muted/30"}`}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-controls={`panel-${tab.id}`}
                aria-selected={activeId === tab.id}
                onClick={() => setActiveId(tab.id)}
                className="flex max-w-44 items-center gap-2 truncate py-2 pr-2 pl-3 text-xs"
              >
                <MessageCirclePlusIcon className="size-3.5 shrink-0" />
                Side chat {index + 1}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Close side chat ${index + 1}`}
                disabled={tab.pending || closing !== null}
                onClick={() => void close(tab)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
        {tabs.find((tab) => tab.id === activeId) && (
          <Button
            variant="outline"
            size="sm"
            disabled={closing !== null || tabs.find((tab) => tab.id === activeId)?.pending}
            onClick={() => {
              const tab = tabs.find((tab) => tab.id === activeId);
              if (tab) void keepTab(tab);
            }}
          >
            Keep
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="New side chat" onClick={() => void add()}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {olderTabs.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="flex-1">New message in main chat. Close older side chats?</span>
          <Button
            variant="outline"
            size="sm"
            disabled={closing !== null || olderTabs.some((tab) => tab.pending)}
            onClick={() =>
              void (async () => {
                for (const tab of olderTabs) await close(tab);
              })()
            }
          >
            Close older chats
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOlderTabIds([])}>
            Leave open
          </Button>
        </div>
      )}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={activeId !== tab.id}
          className={activeId === tab.id ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          {tab.error && (
            <p role="alert" className="p-3 text-sm text-destructive">
              {tab.error}
            </p>
          )}
          {tab.pending ? (
            <p className="p-4 text-sm text-muted-foreground">Capturing context…</p>
          ) : (
            <SideChatSession
              source={source}
              cwd={cwd}
              threadId={tab.id}
              prompt={tab.prompt}
              active={visible && activeId === tab.id}
              settings={settings}
              instanceEntries={instanceEntries}
            />
          )}
        </div>
      ))}
    </aside>
  );
}
