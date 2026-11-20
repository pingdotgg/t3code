import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { BrowserSurface } from "../browser/BrowserSurface";
import { browserAtom } from "../browser/browserTabs";
import { DiffView } from "../changes/DiffView";
import { filesViewAtom, sameFile } from "../state/filesView";
import { FilesView } from "./FilesView";
import { MainTabStrip } from "./MainTabStrip";
import type { FilesBoard } from "./target";

/**
 * The main view's tabs the way Orca's are: once a file or a browser tab is open, a strip of the board
 * and those tabs sits over the canvas, and the active tab covers the canvas. The canvas stays
 * mounted and sized, so it keeps its pan and zoom while another tab shows. A board's files are
 * read through its roots, and with no board open there are none.
 */
export function MainTabs({ files, children }: { files: FilesBoard | null; children: ReactNode }) {
  const { tabs: opened, active, surface } = useAtomValue(filesViewAtom);
  const { tabs: pages, agents } = useAtomValue(browserAtom);
  // A tab opened under another board's roots has nothing to read here.
  const tabs = opened.filter((tab) => files?.roots.some((root) => root.cwd === tab.cwd));
  const shown = active !== null && tabs.some((tab) => sameFile(tab, active)) ? active : null;
  const covered = shown !== null || surface !== null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {(tabs.length > 0 || pages.tabs.length > 0 || agents) && <MainTabStrip files={tabs} />}
      <div className="relative min-h-0 flex-1">
        {/* Invisible, not removed from the layout, so the canvas keeps its size and with it its pan and zoom. */}
        <div inert={covered} className={`absolute inset-0 ${covered ? "invisible" : ""}`}>
          {children}
        </div>
        {shown !== null && (
          <div className="absolute inset-0 flex">
            {shown.diff === undefined ? (
              <FilesView file={shown} />
            ) : (
              <DiffView file={shown} diff={shown.diff} />
            )}
          </div>
        )}
        {surface !== null && (
          <div className="absolute inset-0 flex">
            <BrowserSurface surface={surface} />
          </div>
        )}
      </div>
    </div>
  );
}
