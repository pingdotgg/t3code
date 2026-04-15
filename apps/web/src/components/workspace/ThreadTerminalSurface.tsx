import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { createProjectSelectorByRef, createThreadSelectorByRef } from "../../storeSelectors";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { useWorkspaceStore } from "../../workspace/store";

export function ThreadTerminalSurface(props: {
  surfaceId: string;
  terminalId: string;
  threadRef: ScopedThreadRef;
  activationFocusRequestId?: number;
}) {
  const { activationFocusRequestId, surfaceId, terminalId, threadRef } = props;
  const thread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const projectRef = thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const closeTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const terminalLaunchContext = useTerminalStateStore(
    (state) => state.terminalLaunchContextByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const [containerHeight, setContainerHeight] = useState(320);
  const [focusRequestId, setFocusRequestId] = useState(1);
  const closeSurface = useWorkspaceStore((state) => state.closeSurface);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worktreePath = terminalLaunchContext?.worktreePath ?? thread?.worktreePath ?? null;
  const cwd = useMemo(
    () =>
      terminalLaunchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath,
          })
        : null),
    [project, terminalLaunchContext?.cwd, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(180, Math.floor(entries[0]?.contentRect.height ?? 0));
      setContainerHeight((current) => (current === nextHeight ? current : nextHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (activationFocusRequestId === undefined) {
      return;
    }
    setFocusRequestId((current) => current + 1);
  }, [activationFocusRequestId]);

  if (!thread || !project || !cwd) {
    return <div ref={containerRef} className="min-h-0 flex-1 bg-background" />;
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-background">
      <TerminalViewport
        threadRef={threadRef}
        threadId={thread.id}
        terminalId={terminalId}
        terminalLabel={thread.title}
        cwd={cwd}
        worktreePath={worktreePath}
        runtimeEnv={runtimeEnv}
        focusRequestId={focusRequestId}
        autoFocus
        resizeEpoch={0}
        drawerHeight={containerHeight}
        onAddTerminalContext={() => undefined}
        onSessionExited={() => {
          closeTerminal(threadRef, terminalId);
          closeSurface(surfaceId);
        }}
      />
    </div>
  );
}
