import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  type CSSProperties,
  type FocusEvent,
  Fragment,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  isChatSplitOpen,
  resolveChatPanes,
  useChatPanesStore,
  type ResolvedChatPane,
} from "../chatPanesStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import { useStableCallback } from "../hooks/useStableCallback";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRoutePathname,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { ChatPaneContext, type ChatPaneContextValue } from "./chat/chatPane";
import { ThreadRouteContent } from "./ThreadRouteView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** Below this, a pane's composer controls overflow; matches the preview panel's sibling column. */
const CHAT_PANE_MIN_WIDTH = 360;
/** Room for the chat column and the right panel beside it at their 360px minimums. */
const CHAT_PANE_INLINE_RIGHT_PANEL_MIN_WIDTH = 720;
const KEYBOARD_FOCUS = "keyboard";

/**
 * One thread, or two side by side. The route shows the focused pane, so focusing a pane navigates
 * to it; with one pane this is the plain thread view.
 */
export function ChatPanes({
  routeTarget,
  background,
}: {
  routeTarget: ThreadRouteTarget;
  background: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const layout = useChatPanesStore((state) => state.layout);
  const panes = resolveChatPanes(layout, routeTarget);
  const paneThreadKeys = useComposerDraftStore(
    useShallow((store) => panes.map((pane) => paneThreadKey(pane.target, store))),
  );
  const splitOpen = isChatSplitOpen(layout);
  // Too narrow for two panes: only the focused one renders, and the split returns with room.
  // The store holds it so notifications treat the hidden pane's thread as not visible.
  const fitsSplit = useChatPanesStore((state) => state.splitFits);
  const observeContainer = (container: HTMLDivElement) => {
    const measure = () =>
      useChatPanesStore
        .getState()
        .setSplitFits(container.clientWidth >= CHAT_PANE_MIN_WIDTH * 2 + 1);
    measure();
    return observeResize(container, measure);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the routed thread into the pane layout
  useEffect(() => {
    if (!background) useChatPanesStore.getState().commit(routeTarget);
  }, [background, routeTarget]);
  const activePaneId = panes.find((pane) => pane.active)?.id ?? null;
  // Which pane the user is moving into: the one pressed last, or any pane after Tab or F6.
  const focusIntentRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window listeners that record whether the user, not code, is moving focus
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      focusIntentRef.current = event.key === "Tab" || event.key === "F6" ? KEYBOARD_FOCUS : null;
    };
    const onPointerDown = (event: PointerEvent) => {
      focusIntentRef.current =
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>("[data-chat-pane]")?.dataset.chatPane ?? null)
          : null;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases DOM focus left in a pane that the route just unfocused
  useEffect(() => {
    // Focus moved by the sidebar or palette can leave a terminal or composer in the other pane
    // focused, where keystrokes would keep landing.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const focusedPane = focused.closest<HTMLElement>("[data-chat-pane]");
    if (focusedPane && focusedPane.dataset.chatPane !== activePaneId) focused.blur();
  }, [activePaneId]);

  const focusPane = (target: ThreadRouteTarget) => {
    // A pointerdown and the focus it causes both land here before the route re-renders.
    if (isRouteFor(router.latestLocation.pathname, target)) return;
    void (target.kind === "server"
      ? navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        })
      : navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(target.draftId) }));
  };
  const closePane = (paneId: string) => {
    const focusTarget = useChatPanesStore.getState().closePane(paneId);
    if (focusTarget) focusPane(focusTarget);
  };

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
      data-background-thread-view={background || undefined}
    >
      <div ref={observeContainer} className="flex min-h-0 min-w-0 flex-1 flex-row">
        {panes.map((pane, index) => {
          if (!fitsSplit && !pane.active) return null;
          const alone = !splitOpen || !fitsSplit;
          return (
            <Fragment key={pane.id}>
              {index > 0 && !alone ? (
                <div aria-hidden className="h-full w-px shrink-0 bg-border" />
              ) : null}
              <ChatPane
                pane={pane}
                inSplit={splitOpen}
                alone={alone}
                first={alone || index === 0}
                last={alone || index === panes.length - 1}
                background={background}
                onFocus={() => focusPane(pane.target)}
                focusIntentRef={focusIntentRef}
                threadKey={paneThreadKeys[index] ?? null}
                hostsHiddenTerminals={alone || index === 0}
                otherPaneThreadKeys={
                  alone
                    ? ""
                    : paneThreadKeys
                        .filter((key, keyIndex) => keyIndex !== index && key !== null)
                        .join("\n")
                }
                onClose={() => closePane(pane.id)}
              />
            </Fragment>
          );
        })}
      </div>
    </SidebarInset>
  );
}

function paneThreadKey(
  target: ThreadRouteTarget,
  drafts: Pick<ReturnType<typeof useComposerDraftStore.getState>, "getDraftSession">,
): string | null {
  if (target.kind === "server") return scopedThreadKey(target.threadRef);
  const session = drafts.getDraftSession(target.draftId);
  return session ? scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)) : null;
}

/**
 * Window chrome (traffic lights, native title bar controls) sits only at the window's outer edges,
 * so the inner side of each pane drops the inset that edge reserves.
 */
function windowEdgeStyle(first: boolean, last: boolean): CSSProperties {
  return {
    ...(last
      ? {}
      : { "--workspace-controls-right": "0.75rem", "--workspace-native-controls-inset": "0px" }),
    ...(first ? {} : { "--workspace-titlebar-content-left": "var(--workspace-gutter)" }),
  } as CSSProperties;
}

function isRouteFor(pathname: string, target: ThreadRouteTarget): boolean {
  return target.kind === "server"
    ? isThreadRoutePathname(pathname, target.threadRef)
    : pathname.replace(/\/$/, "") === `/draft/${target.draftId}`;
}

function ChatPane({
  pane,
  inSplit,
  alone,
  first,
  last,
  background,
  threadKey,
  hostsHiddenTerminals,
  otherPaneThreadKeys,
  onClose,
  onFocus,
  focusIntentRef,
}: {
  pane: ResolvedChatPane;
  /** False for the one pane outside a split, which behaves like a plain thread view. */
  inSplit: boolean;
  /** The only pane rendered, outside a split or because the window cannot fit it. */
  alone: boolean;
  /** Touches the window's left edge. */
  first: boolean;
  /** Touches the window's right edge. */
  last: boolean;
  background: boolean;
  threadKey: string | null;
  hostsHiddenTerminals: boolean;
  /** Newline-joined, so an unchanged set keeps the context value and spares ChatView a render. */
  otherPaneThreadKeys: string;
  onClose: () => void;
  onFocus: () => void;
  focusIntentRef: RefObject<string | null>;
}) {
  const composerHandle = useComposerHandleContext();
  const close = useStableCallback(onClose);
  // Code can focus a pane after it lost focus (an async editor focus, a dialog restoring focus);
  // that is not the user switching panes, so the focused pane's composer takes it instead.
  const onFocusIn = (event: FocusEvent<HTMLDivElement>) => {
    const intent = focusIntentRef.current;
    if (intent === KEYBOARD_FOCUS || intent === pane.id) {
      onFocus();
      return;
    }
    if (event.target instanceof HTMLElement) event.target.blur();
    composerHandle?.current?.focusAtEnd();
  };
  const passive = !pane.active;
  const [narrow, setNarrow] = useState(false);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const observePane = (node: HTMLDivElement) => {
    setElement(node);
    const measure = () => setNarrow(node.clientWidth < CHAT_PANE_INLINE_RIGHT_PANEL_MIN_WIDTH);
    measure();
    return observeResize(node, measure);
  };
  const chatPaneValue: ChatPaneContextValue = {
    element: alone ? null : element,
    narrow: !alone && narrow,
    hostsHiddenTerminals,
    otherPaneThreadKeys: new Set(otherPaneThreadKeys === "" ? [] : otherPaneThreadKeys.split("\n")),
    close,
  };
  return (
    <div
      ref={observePane}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col",
        // Layout containment anchors the header's fixed title bar controls to this pane.
        !alone && "min-w-90 [contain:layout]",
        !alone &&
          !passive &&
          "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-30 before:h-0.5 before:bg-primary/60",
        !alone && passive && "[&_[data-chat-header]]:opacity-60",
      )}
      style={windowEdgeStyle(first, last)}
      data-chat-pane={pane.id}
      data-chat-pane-narrow={(!alone && narrow) || undefined}
      data-chat-pane-thread={threadKey ?? undefined}
      data-background-thread-view={passive || undefined}
      onPointerDownCapture={passive ? onFocus : undefined}
      onFocusCapture={passive ? onFocusIn : undefined}
    >
      {/* The app-wide composer handle belongs to the focused pane's composer. */}
      <ComposerHandleContext value={passive ? null : composerHandle}>
        <ChatPaneContext value={inSplit ? chatPaneValue : null}>
          <ThreadRouteContent
            target={pane.target}
            background={background}
            passive={passive}
            unavailable={inSplit ? <UnavailablePane onClose={close} /> : null}
            onMissing={inSplit ? close : undefined}
          />
        </ChatPaneContext>
      </ComposerHandleContext>
    </div>
  );
}

function UnavailablePane({ onClose }: { onClose: () => void }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>Thread unavailable</EmptyTitle>
        <EmptyDescription>It was deleted, archived, or is hidden by a filter.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close pane
        </Button>
      </EmptyContent>
    </Empty>
  );
}
