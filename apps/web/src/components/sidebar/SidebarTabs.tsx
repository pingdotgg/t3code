import {
  AlarmClockIcon,
  CheckIcon,
  CircleDashedIcon,
  InboxIcon,
  type LucideIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { Activity, type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  endTabSwipe,
  stepTabSwipe,
  TAB_SWIPE_GAP_MS,
  TAB_SWIPE_IDLE,
  type TabSwipeState,
} from "./sidebarTabSwipe.logic";

export const SidebarTab = Schema.Literals(["active", "working", "snoozed", "settled"]);
export type SidebarTab = typeof SidebarTab.Type;

const SIDEBAR_TABS = [
  { value: "active", label: "Active", icon: InboxIcon },
  { value: "working", label: "Working", icon: CircleDashedIcon },
  { value: "snoozed", label: "Snoozed", icon: AlarmClockIcon },
  { value: "settled", label: "Settled", icon: CheckIcon },
] as const satisfies ReadonlyArray<{ value: SidebarTab; label: string; icon: LucideIcon }>;

function sidebarTabsFor(workingShelfEnabled: boolean) {
  return workingShelfEnabled ? SIDEBAR_TABS : SIDEBAR_TABS.filter((tab) => tab.value !== "working");
}

// Ease-out with a fast start, so the list keeps the finger's speed for the first frames.
const SETTLE_MS = 200;
const SETTLE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export function SidebarTabBar(props: {
  value: SidebarTab;
  onValueChange: (tab: SidebarTab) => void;
  counts: Record<SidebarTab, number>;
  workingShelfEnabled: boolean;
}) {
  return (
    // Wide sidebars label every tab, medium ones only the selected tab, narrow ones show icons.
    <div className="@container/sidebar-tabs mx-0.5 mt-1">
      <ToggleGroup
        aria-label="Sidebar sections"
        variant="segmented"
        className="w-full"
        value={[props.value]}
        onValueChange={(value) => {
          const next = SIDEBAR_TABS.find((tab) => tab.value === value[0]);
          if (next !== undefined) props.onValueChange(next.value);
        }}
      >
        {sidebarTabsFor(props.workingShelfEnabled).map((tab) => {
          const label = `${tab.label} (${props.counts[tab.value]})`;
          return (
            <Tooltip key={tab.value}>
              <TooltipTrigger
                render={
                  <Toggle
                    value={tab.value}
                    aria-label={label}
                    className="flex-auto"
                    data-testid={`sidebar-tab-${tab.value}`}
                  />
                }
              >
                <tab.icon aria-hidden className="size-3.5" />
                <span className="hidden @[17rem]/sidebar-tabs:in-data-pressed:inline @[26rem]/sidebar-tabs:inline">
                  {tab.label}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">{label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

interface SwipeSession {
  state: TabSwipeState;
  // The neighbour currently drawn beside the list: 1 = next, -1 = previous.
  direction: 1 | -1 | null;
  gapTimer: ReturnType<typeof setTimeout> | undefined;
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  landingTab: SidebarTab | null;
  // The tab a pending landing leaves; picking any other tab meanwhile drops the landing.
  landingFrom: SidebarTab | null;
}

// A two-finger horizontal swipe over the list drags it with the fingers and reveals the
// neighbouring tab beside it; crossing half the width switches tabs. Movement is written straight
// to the DOM, so a gesture never re-renders `children`.
export function SidebarSwipeArea(props: {
  value: SidebarTab;
  onValueChange: (tab: SidebarTab) => void;
  workingShelfEnabled: boolean;
  renderPreview: (tab: SidebarTab) => ReactNode;
  children: ReactNode;
}) {
  const { value, onValueChange, renderPreview, children } = props;
  const tabs = sidebarTabsFor(props.workingShelfEnabled);
  const index = tabs.findIndex((tab) => tab.value === value);
  const previous = tabs[index - 1]?.value;
  const next = tabs[index + 1]?.value;
  const [shownDirection, setShownDirection] = useState<1 | -1 | null>(null);
  const sessionRef = useRef<SwipeSession>({
    state: TAB_SWIPE_IDLE,
    direction: null,
    gapTimer: undefined,
    settleTimer: undefined,
    landingTab: null,
    landingFrom: null,
  });

  const attachArea = (area: HTMLElement | null) => {
    if (area === null) return;
    const session = sessionRef.current;
    const panel = area.querySelector<HTMLElement>(":scope > [data-sidebar-swipe-panel]")!;
    const previewOf = (direction: 1 | -1) =>
      area.querySelector<HTMLElement>(`:scope > [data-sidebar-swipe-preview="${direction}"]`);
    const viewport = area.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    // The list can be scrolled; draw the neighbour at the top of what is visible.
    const visibleTop = () =>
      viewport === null
        ? 0
        : Math.max(0, viewport.getBoundingClientRect().top - area.getBoundingClientRect().top);

    const show = (direction: 1 | -1 | null) => {
      if (session.direction === direction) return;
      session.direction = direction;
      const preview = direction === null ? null : previewOf(direction);
      if (preview !== null) {
        preview.style.top = `${visibleTop()}px`;
        preview.style.height = `${viewport?.clientHeight ?? area.clientHeight}px`;
      }
      setShownDirection(direction);
    };

    const place = (offset: number, transition: string) => {
      const width = panel.clientWidth;
      panel.style.transition = transition;
      panel.style.transform = `translateX(${-offset}px)`;
      panel.style.willChange = "transform";
      const preview = session.direction === null ? null : previewOf(session.direction);
      if (preview !== null) {
        preview.style.transition = transition;
        preview.style.transform = `translateX(${session.direction! * width - offset}px)`;
      }
    };

    const finishSettle = (land: boolean) => {
      clearTimeout(session.settleTimer);
      session.settleTimer = undefined;
      const landing = land ? session.landingTab : null;
      session.landingTab = null;
      session.landingFrom = null;
      if (landing !== null && viewport !== null) {
        // The neighbour was drawn at the top of the viewport; keep its rows where they were.
        const listTop =
          viewport.scrollTop +
          area.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        viewport.scrollTop = Math.min(viewport.scrollTop, listTop);
      }
      session.direction = null;
      if (landing === null) {
        setShownDirection(null);
      } else {
        flushSync(() => {
          onValueChange(landing);
          setShownDirection(null);
        });
      }
      panel.style.transition = "";
      panel.style.transform = "";
      panel.style.willChange = "";
      for (const preview of area.querySelectorAll<HTMLElement>(
        ":scope > [data-sidebar-swipe-preview]",
      )) {
        preview.style.transition = "";
        preview.style.transform = restingPreviewTransform(
          Number(preview.dataset.sidebarSwipePreview) as 1 | -1,
        );
      }
    };

    const settle = (direction: 1 | -1 | null) => {
      const transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}`;
      session.landingTab = direction === null ? null : direction === 1 ? next! : previous!;
      session.landingFrom = value;
      place(direction === null ? 0 : direction * panel.clientWidth, transition);
      session.settleTimer = setTimeout(() => finishSettle(true), SETTLE_MS);
    };

    const handleWheel = (event: WheelEvent) => {
      const result = stepTabSwipe(
        session.state,
        { deltaX: event.deltaX, deltaY: event.deltaY },
        {
          width: panel.clientWidth,
          hasPrevious: previous !== undefined,
          hasNext: next !== undefined,
        },
      );
      if (result.output.kind === "pass") return;
      // Also stops the browser's swipe-to-go-back.
      event.preventDefault();
      clearTimeout(session.gapTimer);
      session.gapTimer = setTimeout(() => {
        session.gapTimer = undefined;
        const { cancel } = endTabSwipe(session.state);
        session.state = TAB_SWIPE_IDLE;
        if (cancel) settle(null);
      }, TAB_SWIPE_GAP_MS);
      if (result.output.kind !== "hold" && session.settleTimer !== undefined) {
        // A new swipe began while the last one was landing. The tabs change under this
        // closure, so the swipe picks up from the next event.
        finishSettle(true);
        session.state = TAB_SWIPE_IDLE;
        return;
      }
      session.state = result.state;
      if (result.output.kind === "track") {
        const offset = result.output.offset;
        show(offset > 0 ? 1 : offset < 0 ? -1 : null);
        place(offset, "");
      } else if (result.output.kind === "commit") {
        show(result.output.direction);
        settle(result.output.direction);
      }
    };

    if (session.settleTimer !== undefined && session.landingFrom !== value) finishSettle(false);

    area.addEventListener("wheel", handleWheel, { passive: false });
    // Landing on a tab re-attaches with new neighbours mid-gesture; the session keeps the
    // swipe's state so its remaining momentum is still swallowed.
    return () => area.removeEventListener("wheel", handleWheel);
  };

  return (
    <div ref={attachArea} className="relative flex flex-1 flex-col overflow-x-clip">
      <div data-sidebar-swipe-panel className="flex flex-1 flex-col">
        {children}
      </div>
      {previous !== undefined ? (
        <SwipePreview direction={-1} visible={shownDirection === -1}>
          {renderPreview(previous)}
        </SwipePreview>
      ) : null}
      {next !== undefined ? (
        <SwipePreview direction={1} visible={shownDirection === 1}>
          {renderPreview(next)}
        </SwipePreview>
      ) : null}
    </div>
  );
}

const restingPreviewTransform = (direction: 1 | -1) => `translateX(${direction * 100}%)`;

// A read-only copy of a neighbouring tab's first rows. It stays mounted in a hidden Activity so a
// swipe shows it on the first frame.
function SwipePreview(props: { direction: 1 | -1; visible: boolean; children: ReactNode }) {
  return (
    <Activity mode={props.visible ? "visible" : "hidden"}>
      <div
        data-sidebar-swipe-preview={props.direction}
        aria-hidden
        inert
        className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden bg-sidebar"
        style={{ transform: restingPreviewTransform(props.direction) }}
      >
        <ul role="presentation" className="flex flex-col gap-px">
          {props.children}
        </ul>
      </div>
    </Activity>
  );
}
