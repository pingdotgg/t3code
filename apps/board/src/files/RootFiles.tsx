import { useCallback, useRef, useState } from "react";

import { Select } from "../settings/controls/Select";
import { EmptyFiles } from "./EmptyFiles";
import { FileSurface } from "./FileSurface";
import { FileTree } from "./FileTree";
import { fileTarget, type FilesBoard } from "./target";

/** One board's roots: the picker, the chosen root's tree, and the file picked from it. */
export function RootFiles({ board }: { board: FilesBoard }) {
  const [rootCwd, setRootCwd] = useState(board.roots[0]?.cwd ?? "");
  const root = board.roots.find((entry) => entry.cwd === rootCwd) ?? board.roots[0];
  const [path, setPath] = useState<string | null>(null);
  const dirty = useRef(false);
  const setDirty = useCallback((next: boolean) => {
    dirty.current = next;
  }, []);
  // Leaving a file would drop its edits, so a person confirms that first.
  const leave = (go: () => void) => {
    if (!dirty.current || window.confirm("Discard your unsaved edits?")) {
      dirty.current = false;
      go();
    }
  };
  if (root === undefined) return <EmptyFiles>This project has no files to show.</EmptyFiles>;
  return (
    <div data-testid="files-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <Select
          label="Root"
          value={root.cwd}
          options={board.roots.map((entry) => ({ value: entry.cwd, title: entry.label }))}
          onChange={(next) =>
            leave(() => {
              setRootCwd(next);
              setPath(null);
            })
          }
        />
        <p className="mt-1 truncate font-mono text-[11px] text-faint">{root.cwd}</p>
      </div>
      <div
        className={`flex min-h-0 flex-col ${path === null ? "flex-1" : "h-2/5 min-h-36 shrink-0 border-b border-line"}`}
      >
        <FileTree
          key={root.cwd}
          environmentId={board.environmentId}
          cwd={root.cwd}
          onOpenFile={(next) => leave(() => setPath(next))}
        />
      </div>
      {path !== null && (
        <section aria-label="File preview" className="flex min-h-0 flex-1 flex-col">
          <FileSurface
            key={`${root.cwd}/${path}`}
            target={fileTarget(board, root, path)}
            onDirtyChange={setDirty}
          />
        </section>
      )}
    </div>
  );
}
