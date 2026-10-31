import {
  ArrowLeftRightIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
  FileDiffIcon,
} from "lucide-react";
import { PaneTabButton } from "../components/PaneNotch";
import { Kbd, KbdGroup } from "../components/ui/kbd";

export type LayoutTourLesson = "tabs" | "split" | "overview" | "keys";

function DiagramPane({ tabs = ["Chat"] }: { tabs?: readonly string[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-control surface-card p-2">
      <div className="flex w-max origin-top-left scale-60">
        {tabs.map((tab) => {
          const Icon =
            tab === "Terminal"
              ? SquareTerminalIcon
              : tab === "Diff"
                ? FileDiffIcon
                : MessageSquareIcon;
          return (
            <PaneTabButton key={tab} tabIndex={-1}>
              <Icon className="size-3.5" />
              {tab}
            </PaneTabButton>
          );
        })}
      </div>
      <div className="h-1 w-2/3 shrink-0 rounded-full bg-foreground/15" />
      <div className="h-1 w-1/2 shrink-0 rounded-full bg-foreground/10" />
    </div>
  );
}

/** CSS layout diagrams use the same tabs, surfaces and keycaps as the workspace. */
export function LayoutTourDiagram({ lesson }: { lesson: LayoutTourLesson }) {
  return (
    <div
      aria-hidden
      inert
      className="relative flex h-32.5 items-stretch gap-1.5 overflow-hidden rounded-control surface-well p-3.5"
    >
      {lesson === "tabs" ? (
        <DiagramPane tabs={["Chat", "Terminal", "Diff"]} />
      ) : lesson === "split" ? (
        <>
          <DiagramPane />
          <DiagramPane tabs={["Diff"]} />
        </>
      ) : lesson === "overview" ? (
        <div className="flex w-full flex-col justify-center gap-1.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-7 gap-1.5">
              {[0, 1, 2].map((column) => (
                <div
                  key={column}
                  className="flex flex-1 items-center rounded-control surface-card px-2"
                >
                  <span className="h-1 w-2/3 rounded-full bg-foreground/15" />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-[1.5] flex-col gap-1.5">
            <DiagramPane />
            <DiagramPane tabs={["Terminal"]} />
          </div>
          <DiagramPane tabs={["Diff"]} />
        </>
      )}
      {lesson === "split" ? (
        <ArrowLeftRightIcon className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
      ) : null}
    </div>
  );
}

export function LayoutTourKeys({ modifiers }: { modifiers: string }) {
  return (
    <div aria-hidden className="flex justify-center py-1">
      <KbdGroup>
        <Kbd>{modifiers}</Kbd>
        <Kbd>O</Kbd>
      </KbdGroup>
    </div>
  );
}
