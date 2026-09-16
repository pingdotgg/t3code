import { useEffect, useRef, useState } from "react";

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

/** Stable key for a project in a specific environment. */
export function projectReconcileKey(project: {
  readonly environmentId: string;
  readonly id: string;
}): string {
  return `${project.environmentId}\0${project.id}`;
}

/**
 * Return the subset of `projects` not yet in `reconciled`.
 * Does **not** mark them reconciled — the caller must do so after a
 * definitive outcome so transient failures allow retry.
 */
export function selectUnreconciledProjects(
  projects: ReadonlyArray<EnvironmentProject>,
  reconciled: ReadonlySet<string>,
): ReadonlyArray<EnvironmentProject> {
  const pending: EnvironmentProject[] = [];
  for (const project of projects) {
    if (reconciled.has(projectReconcileKey(project))) continue;
    pending.push(project);
  }
  return pending;
}

const EXPECTED_FAILURE_TAGS = new Set([
  "AgentSessionImportProjectNotFoundError",
  "AgentSessionImportProjectChangedError",
  "AgentSessionScanError",
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

  // Effect's server emits this exact defect for an unregistered RPC tag.
  // Transport and decoding defects do not imply missing server support.
  const defect = isRpcClientError(squashed)
    ? squashed.reason._tag === "RpcClientDefect"
      ? squashed.reason.cause
      : undefined
    : squashed;
  const message = defect instanceof Error ? defect.message : defect;
  if (message === "Unknown request tag: agentSessions.import") return "unsupported-server";

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
 * Whether the failure kind is definitive enough to mark the project reconciled
 * and not retry. Transient failures (unsupported-server, unexpected, interrupted)
 * leave the project eligible for retry after a server upgrade or remount.
 */
export function isDefinitiveOutcome(kind: ReturnType<typeof classifyImportFailure>): boolean {
  return kind === "expected";
}

const MAX_IMPORT_ATTEMPTS = 3;
const IMPORT_RETRY_DELAY_MS = 5_000;

/**
 * Automatically imports external agent sessions (Claude Code, Codex) for every
 * known project once the environment shells are bootstrapped. Runs once per
 * project per mount cycle for successful imports; allows at most three attempts
 * per project, with five seconds between attempts on transient failures.
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

  const attemptsRef = useRef(new Map<string, { count: number; retryAt: number }>());
  const inFlightRef = useRef(new Set<string>());
  const [retryVersion, retry] = useState(0);

  useEffect(() => {
    if (!bootstrapped) {
      unsupportedServersRef.current.clear();
      return;
    }

    const pending = selectUnreconciledProjects(projects, reconciledRef.current);
    if (pending.length === 0) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let nextRetryAt = Infinity;
    const scheduleRetry = (retryAt: number) => {
      if (retryAt >= nextRetryAt) return;
      nextRetryAt = retryAt;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => retry((version) => version + 1),
        Math.max(0, retryAt - Date.now()),
      );
    };
    const run = async () => {
      for (const project of pending) {
        if (cancelled) return;

        const key = projectReconcileKey(project);

        if (unsupportedServersRef.current.has(project.environmentId)) continue;

        if (inFlightRef.current.has(key)) continue;
        const previous = attemptsRef.current.get(key);
        if (previous && previous.count >= MAX_IMPORT_ATTEMPTS) continue;
        if (previous && previous.retryAt > Date.now()) {
          scheduleRetry(previous.retryAt);
          continue;
        }

        // Reserve the attempt before awaiting so project updates cannot bypass the limit.
        const attempt = { count: (previous?.count ?? 0) + 1, retryAt: Infinity };
        attemptsRef.current.set(key, attempt);
        inFlightRef.current.add(key);
        const result = await importSessions({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            expectedWorkspaceRoot: project.workspaceRoot,
          },
        });

        inFlightRef.current.delete(key);
        attempt.retryAt = Date.now() + IMPORT_RETRY_DELAY_MS;
        if (cancelled) {
          if (result._tag === "Success" || isDefinitiveOutcome(classifyImportFailure(result))) {
            reconciledRef.current.add(key);
          }
          // A replacement effect may have skipped this project's in-flight request.
          retry((version) => version + 1);
          return;
        }

        if (result._tag === "Success") {
          reconciledRef.current.add(key);
          console.info(
            `[auto-reconcile] project "${project.title}" (${project.id}, root "${project.workspaceRoot}"): ` +
              `imported ${result.value.importedCount}, skipped ${result.value.skippedCount}`,
          );
          continue;
        }

        const kind = classifyImportFailure(result);

        if (
          (kind === "unexpected" || kind === "interrupted") &&
          attempt.count < MAX_IMPORT_ATTEMPTS
        ) {
          scheduleRetry(attempt.retryAt);
        }
        if (kind === "interrupted") continue;

        if (kind === "unsupported-server") {
          unsupportedServersRef.current.add(project.environmentId);
          attemptsRef.current.delete(key);
          for (const key of reconciledRef.current) {
            if (key.startsWith(`${project.environmentId}\0`)) {
              reconciledRef.current.delete(key);
            }
          }
          console.warn(
            `[auto-reconcile] Server for environment "${project.environmentId}" does not support agentSessions.import. ` +
              `Auto-reconcile requires a server build that includes PR #5362 (shipped after t3@0.0.38). ` +
              `Upgrade the server to enable automatic session import.`,
          );
          continue;
        }

        if (isDefinitiveOutcome(kind)) {
          reconciledRef.current.add(key);
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
      clearTimeout(retryTimer);
    };
    // The timer increments retryVersion to rerun this effect when a retry becomes due.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [bootstrapped, importSessions, projects, retryVersion]);
}
