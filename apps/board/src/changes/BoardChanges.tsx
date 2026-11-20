import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import type { FilesBoard } from "../files/target";
import { useFilesBoard } from "../files/useFilesBoard";
import type { ValidBoard } from "../store/boardFiles";
import { RootChanges } from "./RootChanges";

export function BoardChanges({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const board: FilesBoard = useFilesBoard(project, listed);
  return <RootChanges board={board} orchestratorThreadId={listed.board.orchestratorThreadId} />;
}
