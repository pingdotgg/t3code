import { useEffect, useRef } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isRpcClientError } from "@t3tools/client-runtime/rpc";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { agentSessionImport } from "../state/agentSessions";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";

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

const EXPECTED_FAILURE_TAGS = new Set([
  "AgentSessionImportProjectNotFoundError",
  "AgentSessionImportProjectChangedError",
  "AgentSessionScanError",
  "EnvironmentRpcUnavailableError",
  "EnvironmentAuthorizationError",
]);

/**
 * Classify a failed import result so the hook can log the right diagnostic.
 *
 * - `"unsupported-server"` — the RPC method does not exist on this server
 *   (pre-#5362 build, e.g. t3@0.0.38). No retry will help; warn once.
 * - `"interrupted"` — the effect was cancelled (unmount / environment switch).
 * - `"expected"` — a typed domain error (project not found, workspace mismatch,
 *   scan error). Normal on misconfigured or empty agent homes.
 * - `"unexpected"` — an unrecognised defect. Worth logging for debugging.
 */
export function classifyImportFailure(
  result: AtomCommandResult<unknown, unknown>,
): "unsupported-server" | "interrupted" | "expected" | "unexpected" {
  if (result._tag === "Success") return "expected";
  if (isAtomCommandInterrupted(result)) return "interrupted";

  const squashed = squashAtomCommandFailure(result);

  if (isRpcClientError(squashed)) return "unsupported-server";

  if (
    squashed != null &&
    typeof squashed === "object" &&
    "_tag" in squashed &&
    typeof squashed._tag === "string" &&
    EXPECTED_FAILURE_TAGS.has(squashed._tag)
  ) {
    return "expected";
  }

  return "unexpected";
}

/**
 * Automatically imports external agent sessions (Claude Code, Codex) for every
 * known project once the environment shells are bootstrapped. Runs once per
 * project per mount cycle.
 *
 * Reuses the existing `agentSessions.import` RPC, which is idempotent: threads
 * whose `import:` id already exists are skipped by the server, and the
 * per-source file-identity watermark prevents re-reading unchanged transcripts.
 *
 * Requires a server build that includes #5362 (agentSessions.scan /
 * agentSessions.import RPCs). Older servers (e.g. t3@0.0.38) do not expose
 * these methods; the hook detects this and logs a one-time warning.
 */
export function useAgentSessionAutoReconcile(): void {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const reconciledRef = useRef(new Set<string>());
  const unsupportedServersRef = useRef(new Set<string>());

  useEffect(() => {
    if (!bootstrapped) return;

    const pending = selectUnreconciledProjects(projects, reconciledRef.current);
    if (pending.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const project of pending) {
        if (cancelled) return;

        if (unsupportedServersRef.current.has(project.environmentId)) continue;

        const result = await importSessions({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            expectedWorkspaceRoot: project.workspaceRoot,
          },
        });

        if (cancelled) return;

        if (result._tag === "Success") {
          if (result.value.importedCount > 0) {
            console.info(
              `[auto-reconcile] Imported ${result.value.importedCount} agent session(s) for project "${project.title}" (${project.id})`,
            );
          }
          continue;
        }

        const kind = classifyImportFailure(result);

        if (kind === "interrupted") continue;

        if (kind === "unsupported-server") {
          unsupportedServersRef.current.add(project.environmentId);
          console.warn(
            `[auto-reconcile] Server for environment "${project.environmentId}" does not support agentSessions.import. ` +
              `Auto-reconcile of external agent sessions requires a server build that includes PR #5362 ` +
              `(shipped after t3@0.0.38). Upgrade the server to enable automatic session import.`,
          );
          continue;
        }

        const squashed = squashAtomCommandFailure(result);
        const errorMessage =
          squashed instanceof Error ? squashed.message : JSON.stringify(squashed);

        if (kind === "expected") {
          console.warn(
            `[auto-reconcile] Could not import agent sessions for project "${project.title}" ` +
              `(${project.id}, env ${project.environmentId}, root "${project.workspaceRoot}"): ${errorMessage}`,
          );
        } else {
          console.error(
            `[auto-reconcile] Unexpected error importing agent sessions for project "${project.title}" ` +
              `(${project.id}, env ${project.environmentId}, root "${project.workspaceRoot}"): ${errorMessage}`,
          );
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [bootstrapped, importSessions, projects]);
}
