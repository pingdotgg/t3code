import { RegistryContext } from "@effect/atom-react";
import { FileText, LayoutDashboard, X } from "lucide-react";
import { useContext } from "react";

import { closeFile, type FileRef, sameFile, showBoard, showFile } from "../state/filesView";
import { nameOf } from "./target";

const TAB =
  "relative flex h-9 items-center gap-1.5 border-r border-line px-3 text-[12px] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5";

/**
 * The tabs of the main view, the way Orca's draw them: the board first, then each open file with
 * a close button. The active tab is lit and underlined.
 */
export function FileTabStrip({
  tabs,
  active,
}: {
  tabs: ReadonlyArray<FileRef>;
  active: FileRef | null;
}) {
  const registry = useContext(RegistryContext);
  const lit = "bg-bg text-fg after:bg-fg";
  const dim = "text-muted hover:text-fg";
  return (
    <div
      role="tablist"
      aria-label="Main view tabs"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-line bg-sidebar"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        onClick={() => showBoard(registry)}
        className={`${TAB} ${active === null ? lit : dim}`}
      >
        <LayoutDashboard className="size-3.5 shrink-0" aria-hidden />
        Board
      </button>
      {tabs.map((tab) => {
        const shown = active !== null && sameFile(active, tab);
        return (
          <div key={`${tab.cwd}/${tab.path}`} className={`${TAB} ${shown ? lit : dim}`}>
            <button
              type="button"
              role="tab"
              aria-selected={shown}
              onClick={() => showFile(registry, tab)}
              className="flex items-center gap-1.5"
            >
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="max-w-40 truncate">{nameOf(tab.path)}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${nameOf(tab.path)}`}
              onClick={() => closeFile(registry, tab)}
              className="grid size-4 place-items-center rounded-sm hover:bg-hover"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
