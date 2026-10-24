import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { newThreadId } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SideChatSession } from "./SideChat";
import { useComposerMenuState } from "./useComposerMenuState";

export interface SideChatRequest {
  readonly serial: number;
  readonly prompt: string;
}
interface Tab {
  id: ThreadId;
  prompt: string;
  pending: boolean;
  error?: string;
  unavailable?: boolean;
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
  source: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  cwd: string | undefined;
  request: SideChatRequest | null;
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
  const [activeId, setActiveId] = useState<ThreadId | null>(tabs.at(-1)?.id ?? null);
  const actionInFlight = useRef(false);
  const [closing, setClosing] = useState<ThreadId | null>(null);
  const handled = useRef<number | null>(null);
  const branch = useOrchestrationCommand(threadEnvironment.createSideChat, {
    reportFailure: false,
  });
  const remove = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const add = useStableCallback(async (prompt: string = "") => {
    const id = newThreadId();
    setTabs((current) => [...current, { id, prompt, pending: true }]);
    setActiveId(id);
    const result = await branch({
      environmentId: source.environmentId,
      input: { targetThreadId: id, sourceThreadId: source.id },
    });
    const error = result._tag === "Failure" ? String(Cause.squash(result.cause)) : null;
    setTabs((current) =>
      current.map((tab) =>
        tab.id !== id
          ? tab
          : error
            ? { ...tab, pending: false, error, unavailable: true }
            : { ...tab, pending: false },
      ),
    );
  });
  useEffect(() => {
    if (!request || handled.current === request.serial) return;
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
    if (tab.pending || actionInFlight.current) return;
    if (tab.unavailable && !snapshot?.threads.some((thread) => thread.id === tab.id)) {
      forget(tab.id);
      return;
    }
    actionInFlight.current = true;
    setClosing(tab.id);
    const result = await remove({
      environmentId: source.environmentId,
      input: { threadId: tab.id },
    });
    actionInFlight.current = false;
    setClosing(null);
    if (result._tag === "Failure") {
      const error = String(Cause.squash(result.cause));
      setTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, error } : item)));
    } else {
      forget(tab.id);
    }
  };
  return (
    <aside
      aria-hidden={!visible}
      inert={!visible}
      data-side-chat
      role="complementary"
      aria-label="Side chats"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <div className="flex min-h-10 items-center gap-1 px-3 py-1">
        <div role="tablist" aria-label="Side chats" className="flex min-w-0 gap-1 overflow-x-auto">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              className={`flex shrink-0 items-center rounded-lg ${activeId === tab.id ? "bg-muted/60" : ""}`}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-controls={`panel-${tab.id}`}
                aria-selected={activeId === tab.id}
                onClick={() => setActiveId(tab.id)}
                className="flex max-w-44 items-center gap-2 truncate py-1.5 pr-2 pl-2 text-xs"
              >
                Side chat {index + 1}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Close side chat ${index + 1}`}
                disabled={tab.pending || closing !== null}
                onClick={() => void close(tab)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New side chat"
          onClick={() => void add()}
        >
          <PlusIcon className="size-4" />
        </Button>
        <div className="ml-auto shrink-0">
          <SideChatContext visible={visible} />
        </div>
      </div>
      {tabs.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Explore a question with a snapshot of this chat.
          </p>
          <Button variant="outline" onClick={() => void add()}>
            Start side chat
          </Button>
        </div>
      )}
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
          ) : tab.unavailable &&
            !snapshot?.threads.some((thread) => thread.id === tab.id) ? null : (
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

export function SideChatContext({ visible }: { visible: boolean }) {
  const [open, setOpen] = useComposerMenuState(!visible);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="icon-sm" aria-label="Side chat context" />}
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="sm" aria-label="Side chat context">
        <p className="text-xs text-muted-foreground">
          Each side chat uses the main conversation as it was when that tab opened. Later main-chat
          messages do not change its context.
        </p>
      </PopoverPopup>
    </Popover>
  );
}
