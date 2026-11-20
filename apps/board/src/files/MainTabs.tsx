import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { useArtifacts } from "../artifacts/ArtifactsContext";
import { filesViewAtom, sameFile } from "../state/filesView";
import { FileTabStrip } from "./FileTabStrip";
import { FilesView } from "./FilesView";

/**
 * The main view's tabs the way Orca's are: once a file is open, a strip of the board and its files
 * sits over the canvas, and the active file covers the canvas. The canvas stays mounted and sized, so
 * it keeps its pan and zoom while a file shows.
 */
export function MainTabs({ children }: { children: ReactNode }) {
  const { files } = useArtifacts();
  const { tabs: opened, active } = useAtomValue(filesViewAtom);
  // A tab opened under another board's roots has nothing to read here.
  const tabs = opened.filter((tab) => files.roots.some((root) => root.cwd === tab.cwd));
  const shown = active !== null && tabs.some((tab) => sameFile(tab, active)) ? active : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tabs.length > 0 && <FileTabStrip tabs={tabs} active={shown} />}
      <div className="relative min-h-0 flex-1">
        {/* Invisible, not removed from the layout, so the canvas keeps its size and with it its pan and zoom. */}
        <div
          inert={shown !== null}
          className={`absolute inset-0 ${shown === null ? "" : "invisible"}`}
        >
          {children}
        </div>
        {shown !== null && (
          <div className="absolute inset-0 flex">
            <FilesView file={shown} />
          </div>
        )}
      </div>
    </div>
  );
}
