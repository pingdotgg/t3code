import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import type { ValidBoard } from "../store/boardFiles";
import { RootFiles } from "./RootFiles";
import { useFilesBoard } from "./useFilesBoard";

export function BoardFiles({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const board = useFilesBoard(project, listed);
  return <RootFiles key={`${project.id}/${listed.folder}`} board={board} />;
}
