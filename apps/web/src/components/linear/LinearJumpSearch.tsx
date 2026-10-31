import { SearchIcon } from "lucide-react";
import { useRef, useState, type Ref } from "react";

import { formatShortcutLabel } from "~/keybindings";
import { cn } from "~/lib/utils";

import { Spinner } from "../ui/spinner";
import { Kbd } from "../ui/kbd";
import { LinearGlyph } from "./linearIcons";
import type { LinearJumpTarget } from "./linearJump";

const JUMP_SHORTCUT_LABEL = formatShortcutLabel({
  key: "k",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
});

const KIND_LABEL: Record<LinearJumpTarget["kind"], string> = {
  team: "Team",
  project: "Project",
  milestone: "Milestone",
  issue: "Issue",
};

/** "Jump to issue, project, milestone…": ⌘K on the Linear page, results from loaded data + search. */
export function LinearJumpSearch({
  inputRef,
  targets,
  busy,
  onTermChange,
  onJump,
}: {
  inputRef: Ref<HTMLInputElement>;
  targets: ReadonlyArray<LinearJumpTarget>;
  busy: boolean;
  onTermChange: (term: string) => void;
  onJump: (target: LinearJumpTarget) => void;
}) {
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const showResults = open && term.trim() !== "";
  const activeIndex = Math.min(active, Math.max(targets.length - 1, 0));
  const reset = () => {
    setTerm("");
    onTermChange("");
    setOpen(false);
    setActive(0);
  };
  const jump = (target: LinearJumpTarget) => {
    onJump(target);
    reset();
  };
  return (
    <div
      ref={containerRef}
      className="relative w-40 shrink-0 sm:w-64"
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label className="flex h-8 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/40 dark:bg-input/32">
        {busy ? (
          <Spinner aria-hidden className="size-3.5" />
        ) : (
          <SearchIcon aria-hidden className="size-3.5" />
        )}
        <input
          ref={inputRef}
          value={term}
          role="combobox"
          aria-expanded={showResults}
          aria-controls="linear-jump-results"
          aria-label="Jump to issue, project, milestone"
          placeholder="Jump to issue, project, milestone…"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setTerm(event.currentTarget.value);
            onTermChange(event.currentTarget.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (term === "") event.currentTarget.blur();
              else reset();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive(Math.min(activeIndex + 1, targets.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(Math.max(activeIndex - 1, 0));
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              const target = targets[activeIndex];
              if (target) jump(target);
            }
          }}
        />
        {term === "" ? <Kbd>{JUMP_SHORTCUT_LABEL}</Kbd> : null}
      </label>
      {showResults ? (
        <ul
          id="linear-jump-results"
          role="listbox"
          className="absolute top-full right-0 z-30 mt-1 max-h-80 w-96 max-w-[90vw] list-none overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {targets.length === 0 ? (
            <li className="px-2.5 py-2 text-xs text-muted-foreground">
              {busy ? "Searching…" : "No matches"}
            </li>
          ) : (
            targets.map((target, index) => (
              <li
                key={`${target.kind}:${target.id}`}
                role="option"
                aria-selected={index === activeIndex}
              >
                <button
                  type="button"
                  // Keep focus in the input so the list does not close before the click lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => jump(target)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    index === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <LinearGlyph className="size-3 text-muted-foreground" />
                  <span className="w-[4.5rem] shrink-0 text-2xs text-muted-foreground">
                    {target.kind === "issue" ? target.identifier : KIND_LABEL[target.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{target.label}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
