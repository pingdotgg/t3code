import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";

import { chooseRoot, filesViewAtom, openFile } from "../state/filesView";
import { EmptyFiles } from "./EmptyFiles";
import { FileTree } from "./FileTree";
import type { FilesBoard } from "./target";

/** One board's explorer: the picker of its roots over the chosen root's tree. A file picked opens in the main view. */
export function RootFiles({ board }: { board: FilesBoard }) {
  const registry = useContext(RegistryContext);
  const chosen = useAtomValue(filesViewAtom).root;
  const root = board.roots.find((entry) => entry.cwd === chosen) ?? board.roots[0];
  if (root === undefined) return <EmptyFiles>This project has no files to show.</EmptyFiles>;
  return (
    <div data-testid="explorer" className="flex min-h-0 flex-1 flex-col">
      <FileTree
        key={root.cwd}
        environmentId={board.environmentId}
        cwd={root.cwd}
        title={
          <select
            aria-label="Root"
            value={root.cwd}
            onChange={(event) => chooseRoot(registry, event.target.value)}
            className="w-full min-w-0 cursor-pointer truncate bg-transparent text-[12px] font-semibold text-fg"
          >
            {board.roots.map((entry) => (
              <option key={entry.cwd} value={entry.cwd} className="bg-panel">
                {entry.label}
              </option>
            ))}
          </select>
        }
        onOpenFile={(path) => openFile(registry, { cwd: root.cwd, path })}
      />
    </div>
  );
}
