import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { Archive, ArchiveRestore, LayoutDashboard, Loader, TriangleAlert } from "lucide-react";
import { useContext, useState } from "react";

import {
  lastOpenedBoardAtom,
  openBoard,
  projectBoardsAtom,
  setBoardArchived,
} from "../state/boards";
import type { ValidBoard } from "../store/boardFiles";
import { Tooltip } from "../ui/Tooltip";
import { PillRow } from "./PillRow";
import { SidebarRow } from "./SidebarRow";

// Lines the badge up with the title of a depth-1 row.
const ERROR_INDENT_PX = 8 + 14 + 24;

export function BoardList({ project }: { project: EnvironmentProject }) {
  const registry = useContext(RegistryContext);
  const state = useAtomValue(projectBoardsAtom(project.id));
  const lastOpened = useAtomValue(lastOpenedBoardAtom);
  const [showArchived, setShowArchived] = useState(false);
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (listed: ValidBoard, archived: boolean) => {
    setFailure(null);
    setWorking((current) => new Set(current).add(listed.folder));
    try {
      await setBoardArchived(registry, project, listed, archived);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking((current) => {
        const next = new Set(current);
        next.delete(listed.folder);
        return next;
      });
    }
  };

  if (state.status === "loading") return <p className="px-6 py-1 text-faint">Loading boards</p>;
  if (state.status === "failed") {
    return (
      <p role="alert" className="px-6 py-1 break-words text-red-400">
        {state.message}
      </p>
    );
  }

  const active = state.boards.filter((listed) => !listed.ok || !listed.board.archived);
  const archived = state.boards.filter(
    (listed): listed is ValidBoard => listed.ok && listed.board.archived,
  );
  return (
    <>
      {active.map((listed) => {
        if (!listed.ok) {
          const fields = listed.issue.fields.join(", ");
          return (
            <div key={listed.folder}>
              <SidebarRow
                depth={1}
                icon={<TriangleAlert className="size-3.5 text-red-400" />}
                title={listed.folder}
                label={`${listed.folder} is not a valid board`}
              />
              <div style={{ paddingLeft: ERROR_INDENT_PX }} className="pr-2 pb-1">
                <Tooltip text={listed.issue.message} side="bottom">
                  <span className="rounded-md border border-red-400/40 px-1.5 text-[11px] leading-4 break-all text-red-400">
                    {fields === "" ? "Error" : `Error: ${fields}`}
                  </span>
                </Tooltip>
              </div>
            </div>
          );
        }
        const busy = working.has(listed.folder);
        return (
          <SidebarRow
            key={listed.folder}
            depth={1}
            icon={
              busy ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <LayoutDashboard className="size-3.5" />
              )
            }
            title={listed.board.name}
            label={listed.board.name}
            selected={lastOpened?.projectId === project.id && lastOpened.folder === listed.folder}
            onClick={() =>
              void openBoard(registry, { projectId: project.id, folder: listed.folder })
            }
            trailing={
              <Tooltip text="Archive board" side="bottom" align="end">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Archive ${listed.board.name}`}
                  onClick={() => void change(listed, true)}
                  className="grid size-5 place-items-center rounded-md opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-hover hover:text-fg disabled:opacity-50"
                >
                  <Archive className="size-3.5" />
                </button>
              </Tooltip>
            }
          />
        );
      })}
      {archived.length > 0 && (
        <PillRow
          count={archived.length}
          label={`archived ${archived.length === 1 ? "board" : "boards"}`}
          onClick={() => setShowArchived((value) => !value)}
        />
      )}
      {showArchived &&
        archived.map((listed) => (
          <SidebarRow
            key={listed.folder}
            depth={1}
            icon={
              working.has(listed.folder) ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <ArchiveRestore className="size-3.5" />
              )
            }
            title={listed.board.name}
            label={`Restore ${listed.board.name}`}
            onClick={() => void change(listed, false)}
          />
        ))}
      {state.boards.length === 0 && <p className="px-6 py-1 text-faint">No boards yet</p>}
      {failure !== null && (
        <p role="alert" className="px-6 py-1 break-words text-red-400">
          {failure}
        </p>
      )}
    </>
  );
}
