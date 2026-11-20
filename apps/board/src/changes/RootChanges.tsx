import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState } from "react";

import { EmptyFiles } from "../files/EmptyFiles";
import type { FilesBoard } from "../files/target";
import { chooseRoot, filesViewAtom } from "../state/filesView";
import { vcsEnvironment } from "../state/vcs";
import { ChangeSection } from "./ChangeSection";
import { ChangesHeader } from "./ChangesHeader";
import { CommitBox } from "./CommitBox";
import { CommitList } from "./CommitList";

export function RootChanges({
  board,
  orchestratorThreadId,
}: {
  board: FilesBoard;
  orchestratorThreadId: string | null;
}) {
  const registry = useContext(RegistryContext);
  const chosen = useAtomValue(filesViewAtom).root;
  const index = Math.max(
    0,
    board.roots.findIndex((entry) => entry.cwd === chosen),
  );
  const root = board.roots[index];
  const { environmentId } = board;
  const status = AsyncResult.getOrElse(
    useAtomValue(vcsEnvironment.status({ environmentId, input: { cwd: root?.cwd ?? "" } })),
    () => null,
  );
  const [filter, setFilter] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  if (root === undefined) return <EmptyFiles>This project has no folders to review.</EmptyFiles>;
  if (status !== null && !status.isRepo)
    return <EmptyFiles>This folder is not a git repository.</EmptyFiles>;

  // Edits made outside the app reach the lists through the status stream, so its totals read them again.
  const revision = JSON.stringify([
    status?.refName,
    status?.workingTree.files.length,
    status?.workingTree.insertions,
    status?.workingTree.deletions,
    status?.branchChanges?.insertions,
    status?.branchChanges?.deletions,
    status?.aheadCount,
    refreshes,
  ]);
  const base = root.base ?? status?.branchChanges?.baseRef ?? null;
  return (
    <div data-testid="changes-panel" className="flex min-h-0 flex-1 flex-col">
      <ChangesHeader
        roots={board.roots}
        root={root}
        base={base}
        status={status}
        filter={filter}
        onFilter={setFilter}
        onRoot={(cwd) => chooseRoot(registry, cwd)}
        onRefresh={() => setRefreshes(refreshes + 1)}
      />
      <CommitBox
        key={root.cwd}
        environmentId={environmentId}
        cwd={root.cwd}
        status={status}
        tell={index === 0 ? null : { orchestratorThreadId, worktree: root.label }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChangeSection
          environmentId={environmentId}
          cwd={root.cwd}
          title="Changes"
          source={{ kind: "working-tree" }}
          revision={revision}
          filter={filter ?? ""}
        />
        {(status?.isDefaultRef !== true || root.base !== null) && (
          <ChangeSection
            environmentId={environmentId}
            cwd={root.cwd}
            title={base === null ? "Branch changes" : `Branch vs ${base}`}
            source={{ kind: "branch-range", baseRef: root.base }}
            revision={revision}
            filter={filter ?? ""}
          />
        )}
      </div>
      <CommitList
        environmentId={environmentId}
        cwd={root.cwd}
        baseRef={root.base}
        revision={revision}
      />
    </div>
  );
}
