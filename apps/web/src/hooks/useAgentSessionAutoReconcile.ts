import { useEffect, useRef } from "react";

import { agentSessionImport } from "../state/agentSessions";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

/**
 * Return the subset of `projects` that have not yet been reconciled according
 * to `reconciled`. Each returned project is added to `reconciled` as a side
 * effect so the caller can track which projects still need work.
 */
export function selectUnreconciledProjects(
  projects: ReadonlyArray<EnvironmentProject>,
  reconciled: Set<string>,
): ReadonlyArray<EnvironmentProject> {
  const pending: EnvironmentProject[] = [];
  for (const project of projects) {
    const key = `${project.environmentId}\0${project.id}`;
    if (reconciled.has(key)) continue;
    reconciled.add(key);
    pending.push(project);
  }
  return pending;
}

/**
 * Automatically imports external agent sessions (Claude Code, Codex) for every
 * known project once the environment shells are bootstrapped. Runs once per
 * project per mount cycle and silently skips failures so the UI never blocks on
 * a missing or unreadable agent home directory.
 *
 * Reuses the existing `agentSessions.import` RPC, which is idempotent: threads
 * whose `import:` id already exists are skipped by the server, and the
 * per-source file-identity watermark prevents re-reading unchanged transcripts.
 */
export function useAgentSessionAutoReconcile(): void {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const reconciledRef = useRef(new Set<string>());

  useEffect(() => {
    if (!bootstrapped) return;

    const pending = selectUnreconciledProjects(projects, reconciledRef.current);
    if (pending.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const project of pending) {
        if (cancelled) return;
        await importSessions({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            expectedWorkspaceRoot: project.workspaceRoot,
          },
        }).catch(() => {});
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [bootstrapped, importSessions, projects]);
}
