import * as Schema from "effect/Schema";
import {
  ArrowLeftRightIcon,
  Columns2Icon,
  GripHorizontalIcon,
  KeyboardIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isMacPlatform } from "../lib/utils";
import { LayoutTourDiagram, LayoutTourKeys, type LayoutTourLesson } from "./LayoutTourDiagram";
import { useLayoutStore } from "./layoutStore";
import { useLayoutOverlayStore } from "./layoutOverlayStore";

const TOUR_KEY = "t3code:layout-tour:v1";
const LEARNED_KEY = "t3code:layout-learned:v1";
const learnedSchema = Schema.Array(Schema.String);

function useLayoutLessons() {
  const [learned, setLearned] = useLocalStorage(LEARNED_KEY, [], learnedSchema);
  const layout = useLayoutStore((state) => state.layout);
  const overview = useLayoutStore((state) => state.overviewOpen);
  const overlay = useLayoutOverlayStore((state) => state.mode);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists lessons only after the real layout or shortcut overlay demonstrates each action
  useEffect(() => {
    const next = new Set(learned);
    const workspaces = layout.workspaces;
    if (
      workspaces.some((workspace) =>
        workspace.columns.some((column) => column.panes.some((pane) => pane.tabs.length > 1)),
      )
    )
      next.add("tabs");
    if (
      workspaces.some(
        (workspace) =>
          workspace.columns.length > 1 ||
          workspace.columns.some((column) => column.panes.length > 1),
      )
    )
      next.add("split");
    if (overview) next.add("overview");
    if (overlay === "hold") next.add("keys");
    if (next.size !== learned.length) setLearned([...next]);
  }, [layout, overview, overlay, learned, setLearned]);
  return learned;
}

/** First-use tips disappear as the user exercises the corresponding layout actions. */
export function LayoutLearningTips() {
  const learned = useLayoutLessons();
  const keys = isMacPlatform(navigator.platform) ? "⌥⌘" : "Ctrl+Alt";
  const tips = [
    { key: "split", Icon: GripHorizontalIcon, text: "Drag a tab to the right edge" },
    { key: "keys", Icon: KeyboardIcon, text: `Hold ${keys} to see the layout keys` },
  ].filter((tip) => !learned.includes(tip.key));
  if (tips.length === 0) return null;
  return (
    <div
      className="mt-5 flex flex-col gap-2 border-t border-border pt-4 text-muted-foreground"
      aria-label="Try the layout"
    >
      <span className="text-meta">Try the layout</span>
      {tips.map(({ key, Icon, text }) => (
        <div key={key} className="flex items-center gap-2 text-body">
          <Icon className="size-3.5 shrink-0" />
          {text}
        </div>
      ))}
    </div>
  );
}

/** A dismissible introduction, followed by a five-step tour anchored to the real workspace. */
export function LayoutOnboarding() {
  const [completed, setCompleted] = useLocalStorage(TOUR_KEY, false, Schema.Boolean);
  const [step, setStep] = useState<number | null>(null);
  const keys = isMacPlatform(navigator.platform) ? "⌥⌘" : "Ctrl+Alt";
  const steps = [
    {
      title: "New tab",
      text: "Opens a new chat in this pane. Right-click it for a terminal, browser or files.",
      selector: '[data-layout-pane-focused="true"] [aria-label^="New tab"]',
      Icon: PlusIcon,
    },
    {
      title: "Drag a tab to make a pane",
      text: "Drop a tab at an edge to put it beside another pane. Drop it on a tab bar to group them again.",
      selector: '[data-layout-pane-focused="true"] [data-layout-pane-tab]',
      Icon: GripHorizontalIcon,
    },
    {
      title: "More panes live off to the side",
      text: `Swipe sideways with two fingers on a tab bar, or hold ${keys} and scroll anywhere. Click a peeking pane to bring it in.`,
      selector: '[data-layout-pane-focused="true"] [data-layout-tab-strip]',
      Icon: ArrowLeftRightIcon,
    },
    {
      title: "See the whole workspace",
      text: "Pinch to zoom out, or move to the bottom-left corner. Pick a pane to return to it.",
      selector: "[data-layout-strip]",
      Icon: Columns2Icon,
    },
    {
      title: "Layout keys",
      text: `Hold ${keys} to see every layout shortcut. Release the keys to return to your work.`,
      selector: '[data-layout-pane-focused="true"] [data-layout-tab-strip]',
      Icon: KeyboardIcon,
    },
  ];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the overview lesson opens the real workspace overview and restores the prior state on leaving it.
  useEffect(() => {
    if (step !== 3) return;
    const wasOpen = useLayoutStore.getState().overviewOpen;
    useLayoutStore.getState().setOverviewOpen(true);
    return () => useLayoutStore.getState().setOverviewOpen(wasOpen);
  }, [step]);
  const current = step === null ? null : steps[step];
  const anchor = () =>
    current
      ? (document.querySelector(current.selector) ?? document.querySelector("[data-layout-strip]"))
      : null;
  const finish = () => {
    setCompleted(true);
    setStep(null);
  };
  const learned = useLayoutLessons();
  if (completed && step === null) return null;
  if (step === null)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) finish();
        }}
      >
        <DialogPopup className="max-w-[1000px]" bottomStickOnMobile={false}>
          <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-8">
            <div className="flex flex-col gap-2">
              <DialogTitle render={<h1 />} size="page">
                Tabs, side by side
              </DialogTitle>
              <DialogDescription>
                Chats, terminals, diffs and the browser are all tabs now. Put them side by side,
                scroll to the rest, and zoom out to see it all.
              </DialogDescription>
            </div>
            <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 md:grid-cols-4">
              {(
                [
                  ["tabs", "Everything is a tab", "Chat, terminal, diff, browser, settings."],
                  ["split", "Drag to split", "Drop a tab on an edge to put it beside."],
                  [
                    "overview",
                    "Scroll and zoom out",
                    "Swipe sideways for more panes. Pinch to see everything.",
                  ],
                  [
                    "keys",
                    "Same keys as before",
                    isMacPlatform(navigator.platform)
                      ? "⌘J for a terminal, ⌥⌘B for the diff."
                      : "Ctrl+J for a terminal, Ctrl+Alt+B for the diff.",
                  ],
                ] satisfies ReadonlyArray<readonly [LayoutTourLesson, string, string]>
              ).map(([lesson, title, description]) => (
                <div key={lesson} className="flex min-w-0 flex-col gap-2.5">
                  <LayoutTourDiagram lesson={lesson} />
                  <h2 className="text-label text-strong-foreground">{title}</h2>
                  <p className="text-body text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="standard" onClick={() => setStep(0)}>
                Show me
              </Button>
              <Button size="standard" variant="secondary" onClick={finish}>
                Got it
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  if (!current) return null;
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        className={step === 0 ? "w-75 max-w-full" : "w-82.5 max-w-full"}
        side="bottom"
        align={step === 3 ? "end" : "start"}
        sideOffset={12}
        collisionAvoidance={{ side: "shift", align: "shift" }}
        initialFocus={false}
      >
        <div className="flex flex-col gap-2" role="region" aria-label="Layout tour">
          {step === 0 ? (
            <current.Icon className="size-6 text-muted-foreground" aria-hidden />
          ) : (
            <LayoutTourDiagram
              lesson={step === 1 ? "split" : step === 2 || step === 3 ? "overview" : "keys"}
            />
          )}
          {step === 4 ? <LayoutTourKeys modifiers={keys} /> : null}
          <h2 className="text-label text-strong-foreground">{current.title}</h2>
          <p className="text-body text-muted-foreground">{current.text}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="mr-auto text-meta text-dim-foreground">
              {step + 1} of 5
              {learned.includes(["tabs", "split", "scroll", "overview", "keys"][step]!)
                ? " · Tried"
                : ""}
            </span>
            <Button size="standard" variant="ghost-muted" onClick={finish}>
              Skip
            </Button>
            <Button
              size="standard"
              onClick={() => {
                if (step === 4) finish();
                else setStep(step + 1);
              }}
            >
              {step === 4 ? "Got it" : "Next"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
