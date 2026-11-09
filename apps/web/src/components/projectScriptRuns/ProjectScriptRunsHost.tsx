import { useProjectScriptRunActions } from "../../hooks/useProjectScriptRuns";
import { ProjectScriptRunDetail } from "./ProjectScriptRunDetail";

export function ProjectScriptRunsHost() {
  const {
    runsList,
    selectedRun,
    canOperate,
    projectForRun,
    stopRun,
    dismissRun,
    openRunInTerminal,
    selectRun,
  } = useProjectScriptRunActions();

  if (selectedRun === null) return null;

  const recentRuns = runsList
    .filter(
      (run) =>
        run.environmentId === selectedRun.environmentId &&
        run.projectId === selectedRun.projectId &&
        run.scriptId === selectedRun.scriptId,
    )
    .sort((left, right) => right.startedAt - left.startedAt);

  return (
    <ProjectScriptRunDetail
      run={selectedRun}
      project={projectForRun(selectedRun)}
      recentRuns={recentRuns}
      canOperate={canOperate(selectedRun.environmentId)}
      onClose={() => selectRun(null)}
      onSelectRun={selectRun}
      onStop={(run) => void stopRun(run)}
      onDismiss={dismissRun}
      onOpenInTerminal={openRunInTerminal}
    />
  );
}
