import { cn } from "../lib/utils";
import { CYCLE_SWITCHER_MODE, type CycleSwitcherMode } from "./CycleSwitcher.logic";
import { useCycleSwitcherController, useCycleSwitcherSession } from "./useCycleSwitcher";
import { useCycleSwitcherEntries } from "./useCycleSwitcherEntries";

/**
 * Hold-to-cycle switcher for the OS-style overlay. `Option+Tab` cycles whole
 * projects and `Ctrl+Tab` cycles threads within the current project; each
 * further Tab steps, Shift+Tab reverses, and releasing the modifier opens the
 * highlighted item. Both lists are ordered like the sidebar with the current
 * item first.
 */
export function CycleSwitcher() {
  const controller = useCycleSwitcherController();

  if (controller.mode === null) return null;

  return (
    <OpenCycleSwitcher
      closeSwitcher={controller.closeSwitcher}
      commitModifiersReleased={controller.commitModifiersReleased}
      key={controller.mode}
      mode={controller.mode}
      initialDirection={controller.initialDirection}
      selectIndex={controller.selectIndex}
      stepOffset={controller.stepOffset}
    />
  );
}

interface OpenCycleSwitcherProps {
  readonly mode: CycleSwitcherMode;
  readonly initialDirection: 1 | -1;
  readonly stepOffset: number;
  readonly selectIndex: (index: number) => void;
  readonly closeSwitcher: () => void;
  readonly commitModifiersReleased: (event: KeyboardEvent) => boolean;
}

/** Mounted only while visible so a closed switcher owns no entity subscriptions. */
function OpenCycleSwitcher({
  mode,
  initialDirection,
  stepOffset,
  selectIndex,
  closeSwitcher,
  commitModifiersReleased,
}: OpenCycleSwitcherProps) {
  const liveEntries = useCycleSwitcherEntries(mode);
  const { entries, activeIndex } = useCycleSwitcherSession({
    liveEntries,
    stepOffset,
    initialDirection,
    closeSwitcher,
    commitModifiersReleased,
  });

  const isThreadMode = mode === CYCLE_SWITCHER_MODE.thread;
  const activeEntry = entries[activeIndex];

  return (
    <div
      aria-label={isThreadMode ? "Switch thread" : "Switch project"}
      className="fixed inset-0 z-100 flex flex-col items-center justify-center gap-3 p-6"
      data-cycle-switcher={mode}
      onMouseDown={(event) => {
        // A click on the backdrop (not the panel) cancels, like releasing away
        // from the switcher.
        if (event.target === event.currentTarget) closeSwitcher();
      }}
      role="dialog"
    >
      <div className="max-w-[92vw] truncate rounded-full bg-popover/95 px-3.5 py-1 text-xs font-medium text-popover-foreground shadow-lg backdrop-blur-md">
        {activeEntry ? activeEntry.label : "Nothing to switch to"}
        {activeEntry?.isCurrent ? " · Current" : ""}
      </div>
      <div
        className={cn(
          "flex rounded-2xl border border-border/70 bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-md",
          isThreadMode
            ? "max-h-[70vh] w-[min(92vw,28rem)] flex-col gap-1 overflow-y-auto p-1.5"
            : "max-w-[92vw] items-stretch gap-2 overflow-x-auto p-2.5",
        )}
        aria-activedescendant={
          entries.length > 0 ? `cycle-switcher-option-${mode}-${activeIndex}` : undefined
        }
        role="listbox"
      >
        {entries.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">
            {isThreadMode ? "No active threads in this project." : "No projects yet."}
          </p>
        ) : (
          entries.map((entry, index) => {
            const isActive = index === activeIndex;
            return (
              <div
                aria-selected={isActive}
                className={cn(
                  "pointer-events-auto shrink-0 cursor-pointer",
                  isThreadMode
                    ? "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
                    : "flex w-28 flex-col items-center gap-2 rounded-xl px-2.5 py-3 text-center",
                  isActive ? "bg-accent text-accent-foreground" : "text-popover-foreground",
                )}
                id={`cycle-switcher-option-${mode}-${index}`}
                key={entry.key}
                onClick={() => {
                  closeSwitcher();
                  entry.commit();
                }}
                onMouseEnter={() => selectIndex(index)}
                ref={isActive ? scrollSwitcherOptionIntoView : undefined}
                role="option"
              >
                {entry.icon}
                {isThreadMode ? (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{entry.label}</span>
                      {entry.sublabel ? (
                        <span className="text-2xs block truncate font-mono text-muted-foreground">
                          {entry.sublabel}
                        </span>
                      ) : null}
                    </span>
                    {entry.isCurrent ? (
                      <span className="text-3xs shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 font-medium uppercase tracking-wide">
                        Current
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="w-full truncate text-xs font-medium">{entry.label}</span>
                    {entry.sublabel ? (
                      <span className="text-3xs w-full truncate text-muted-foreground">
                        {entry.sublabel}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="text-2xs text-muted-foreground">Release to switch · Esc to cancel</div>
    </div>
  );
}

function scrollSwitcherOptionIntoView(option: HTMLDivElement | null) {
  option?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
