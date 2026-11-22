import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react";
import {
  ArrowLeftRightIcon,
  Columns2Icon,
  GripHorizontalIcon,
  KeyboardIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useScrollingWorkspacesEnabled } from "../hooks/useSettings";
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
  const gt = useGT();
  const learned = useLayoutLessons();
  const scrollingWorkspaces = useScrollingWorkspacesEnabled();
  const keys = isMacPlatform(navigator.platform) ? "⌥⌘" : "Ctrl+Alt";
  const tips = [
    { key: "split", Icon: GripHorizontalIcon, text: gt("Drag a tab to the right edge") },
    { key: "keys", Icon: KeyboardIcon, text: gt("Hold {keys} to see the layout keys", { keys }) },
  ].filter((tip) => !learned.includes(tip.key));
  if (!scrollingWorkspaces || tips.length === 0) return null;
  return (
    <div
      className="mt-5 flex flex-col gap-2 border-t border-border pt-4 text-muted-foreground"
      aria-label={gt("Try the layout")}
    >
      <span className="text-meta">
        <T>Try the layout</T>
      </span>
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
  const gt = useGT();
  const [completed, setCompleted] = useLocalStorage(TOUR_KEY, false, Schema.Boolean);
  const [step, setStep] = useState<number | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [learnedBeforeTour, setLearnedBeforeTour] = useState<ReadonlyArray<string>>([]);
  const keys = isMacPlatform(navigator.platform) ? "⌥⌘" : "Ctrl+Alt";
  const steps = [
    {
      title: gt("New tab"),
      text: gt("Opens a new chat, terminal, browser or files in this pane."),
      selector: '[data-layout-pane-focused="true"] [data-layout-new-tab]',
      Icon: PlusIcon,
    },
    {
      title: gt("Drag a tab to make a pane"),
      text: gt(
        "Drop a tab at an edge to put it beside another pane. Drop it on a tab bar to group them again.",
      ),
      selector: '[data-layout-pane-focused="true"] [data-layout-pane-tab]',
      Icon: GripHorizontalIcon,
    },
    {
      title: gt("More panes live off to the side"),
      text: gt(
        "Swipe sideways with two fingers on a tab bar, or hold {keys} and scroll anywhere. Click a peeking pane to bring it in.",
        { keys },
      ),
      selector: '[data-layout-pane-focused="true"] [data-layout-tab-strip]',
      Icon: ArrowLeftRightIcon,
    },
    {
      title: gt("See the whole workspace"),
      text: gt(
        "Pinch to zoom out, or move to the bottom-left corner. Pick a pane to return to it.",
      ),
      selector: "[data-layout-hot-corner]",
      Icon: Columns2Icon,
    },
    {
      title: gt("Layout keys"),
      text: gt(
        "Hold {keys} to see every layout shortcut. Release the keys to return to your work.",
        { keys },
      ),
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
                <T>Tabs, side by side</T>
              </DialogTitle>
              <DialogDescription>
                <T>
                  Chats, terminals, diffs and the browser are all tabs now. Put them side by side,
                  scroll to the rest, and zoom out to see it all.
                </T>
              </DialogDescription>
            </div>
            <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 md:grid-cols-4">
              {(
                [
                  ["tabs", gt("Everything is a tab"), gt("Chat, terminal, diff, browser.")],
                  ["split", gt("Drag to split"), gt("Drop a tab on an edge to put it beside.")],
                  [
                    "overview",
                    gt("Scroll and zoom out"),
                    gt("Swipe sideways for more panes. Pinch to see everything."),
                  ],
                  [
                    "keys",
                    gt("Same keys as before"),
                    isMacPlatform(navigator.platform)
                      ? gt("{terminalKey} for a terminal, {diffKey} for the diff.", {
                          terminalKey: "⌘J",
                          diffKey: "⌘D",
                        })
                      : gt("{terminalKey} for a terminal, {diffKey} for the diff.", {
                          terminalKey: "Ctrl+J",
                          diffKey: "Ctrl+D",
                        }),
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
              <Button
                size="standard"
                onClick={() => {
                  setLearnedBeforeTour(learned);
                  setStep(0);
                }}
              >
                <T>Show me</T>
              </Button>
              <Button size="standard" variant="secondary" onClick={finish}>
                <T>Got it</T>
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  if (!current) return null;
  const anchor =
    document.querySelector(current.selector) ?? document.querySelector("[data-layout-strip]");
  const lesson = (["tabs", "split", null, "overview", "keys"] as const)[step];
  const tried =
    lesson != null && (lesson === "overview" ? learnedBeforeTour : learned).includes(lesson);
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
        side={step === 3 ? "top" : "bottom"}
        align="start"
        sideOffset={12}
        collisionAvoidance={{ side: "shift", align: "shift" }}
        initialFocus={nextRef}
      >
        <div className="flex flex-col gap-2" role="region" aria-label={gt("Layout tour")}>
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
            <span className="mr-auto flex items-center gap-2 text-meta text-dim-foreground">
              <span>
                <T>
                  <Var>{step + 1}</Var> of <Var>{steps.length}</Var>
                </T>
              </span>
              {tried ? (
                <Badge variant="success">
                  <T>Tried</T>
                </Badge>
              ) : null}
            </span>
            <Button size="standard" variant="ghost-muted" onClick={finish}>
              <T>Skip</T>
            </Button>
            <Button
              ref={nextRef}
              size="standard"
              onClick={() => {
                if (step === 4) finish();
                else setStep(step + 1);
              }}
            >
              {step === 4 ? <T>Got it</T> : <T>Next</T>}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
