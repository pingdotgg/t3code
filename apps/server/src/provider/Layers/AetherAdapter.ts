/**
 * AetherAdapter — session core for the Aether cloud-task driver.
 *
 * T2+T3 slice: real startSession/listSessions/hasSession/readThread/
 * stopSession/stopAll over the REST client, with the turn surface
 * (sendTurn/interruptTurn/respondToUserInput/rollbackThread) still failing
 * loudly until the streaming slices (build items 5–7, 9, 10) land.
 *
 * Design invariants (docs/aether-driver-plumbing-spec.md §2.3):
 *   - startSession NEVER creates a task — the task is created on the first
 *     sendTurn. It preflights the local checkout (clean tree on a pushed,
 *     in-sync branch), resolves the cwd's origin remote to exactly one
 *     linked Aether project, and validates a resume cursor's task still
 *     exists remotely.
 *   - stopSession / stopAll are PURE DISCONNECTS: the cloud task keeps
 *     running and the VM idles itself out. `/stop` is never called here.
 *   - resumeCursor = `{schemaVersion: 1, taskId, latestSequence, turnLedger?}`;
 *     t3 persists it at startSession/sendTurn returns, so a fresh session
 *     (no task yet) carries none.
 *
 * @module provider/Layers/AetherAdapter
 */
import {
  EventId,
  ProviderDriverKind,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { GitCommandError } from "@t3tools/contracts";
import type { GitStatusDetails } from "../../vcs/GitVcsDriver.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { AETHER_API_KEY_ENV_VAR } from "./AetherProvider.ts";
import type { AetherRestClient } from "./aether/restClient.ts";
import type { AetherProject, AetherTimelineMessage } from "./aether/restSchemas.ts";
import { toolLifecycleItemTypeFromAether } from "./aether/vendored/canonicalItemType.ts";
import { parseFileChanges } from "./aether/vendored/toolDisplay.ts";

const PROVIDER = ProviderDriverKind.make("aether");

const NOT_IMPLEMENTED_DETAIL =
  "Aether driver: not implemented until the turn-lifecycle slices (build items 5-10)";

const notImplemented = (method: string): Effect.Effect<never, ProviderAdapterError> =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: NOT_IMPLEMENTED_DETAIL,
    }),
  );

/**
 * Version tag stamped into the Aether resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors OPENCODE_RESUME_VERSION).
 */
const AETHER_RESUME_VERSION = 1 as const;

export interface AetherResumeCursor {
  readonly schemaVersion: typeof AETHER_RESUME_VERSION;
  readonly taskId: string;
  readonly latestSequence: number;
  /**
   * Turn → messageId ledger, carried opaquely until the revert slice (build
   * item 10) builds and consumes it. Preserved through parse so a newer
   * build's ledger survives a round-trip through this one.
   */
  readonly turnLedger?: unknown;
}

/**
 * Decode a persisted resume cursor. Anything that isn't a current-version
 * cursor with a non-empty taskId and a finite latestSequence means "no
 * resume" rather than an error (t3 then starts a fresh session — the same
 * contract every other adapter's cursor parser follows).
 */
export function parseAetherResume(raw: unknown): AetherResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== AETHER_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0) {
    return undefined;
  }
  if (typeof record.latestSequence !== "number" || !Number.isFinite(record.latestSequence)) {
    return undefined;
  }
  return {
    schemaVersion: AETHER_RESUME_VERSION,
    taskId: record.taskId.trim(),
    latestSequence: record.latestSequence,
    ...(record.turnLedger !== undefined ? { turnLedger: record.turnLedger } : {}),
  };
}

/**
 * The two git reads the session preflight needs, structurally satisfied by
 * `GitVcsDriver`. Narrowed so unit tests can fake it without the full
 * driver surface.
 */
export interface AetherSessionGit {
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
}

export interface AetherAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** Fallback session cwd when the start input carries none (ServerConfig.cwd). */
  readonly defaultCwd: string;
  readonly git: AetherSessionGit;
  /**
   * Undefined when the instance has no `AETHER_API_KEY` — startSession then
   * fails loudly with the remediation instead of the driver failing create().
   */
  readonly restClient: AetherRestClient | undefined;
}

interface AetherSessionContext {
  session: ProviderSession;
  readonly cwd: string;
  readonly projectId: string;
  /** Undefined until the first sendTurn creates the cloud task (item 7). */
  taskId: string | undefined;
  latestSequence: number;
  /** Opaque turn ledger carried from the resume cursor (see AetherResumeCursor). */
  turnLedger: unknown;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function buildAetherResumeCursor(context: AetherSessionContext): AetherResumeCursor | undefined {
  return context.taskId === undefined
    ? undefined
    : {
        schemaVersion: AETHER_RESUME_VERSION,
        taskId: context.taskId,
        latestSequence: context.latestSequence,
        ...(context.turnLedger !== undefined ? { turnLedger: context.turnLedger } : {}),
      };
}

/**
 * Verify the local checkout is a safe mirror base for a cloud thread: a git
 * repo, on a branch, with a clean tree, pushed, and in sync with its origin
 * counterpart (spec §2.2 — thread start REQUIRES a clean tree on a pushed
 * branch). Every failure names its exact remediation.
 */
function preflightIssue(status: GitStatusDetails, cwd: string): string | undefined {
  if (!status.isRepo) {
    return `'${cwd}' is not a git repository. Aether cloud tasks need a git checkout of the linked repository.`;
  }
  if (status.branch === null) {
    return "The working tree is on a detached HEAD. Check out a branch and push it before starting an Aether cloud task.";
  }
  if (status.hasWorkingTreeChanges) {
    return `The working tree has uncommitted changes. Commit or stash them, then push '${status.branch}', before starting an Aether cloud task — the local checkout becomes a one-way mirror of the cloud workspace.`;
  }
  if (!status.hasUpstream) {
    return `Branch '${status.branch}' has no upstream. Push it first (git push -u origin ${status.branch}) so the cloud task starts from the same base.`;
  }
  if (status.aheadCount > 0) {
    return `Branch '${status.branch}' is ahead of its upstream by ${status.aheadCount} commit(s). Push it before starting an Aether cloud task.`;
  }
  if (status.behindCount > 0) {
    return `Branch '${status.branch}' is behind its upstream by ${status.behindCount} commit(s). Sync it (git pull --ff-only) before starting an Aether cloud task.`;
  }
  return undefined;
}

/** Snapshot item for a timeline row — minimal, per t3's opaque snapshot type. */
function snapshotItemFromMessage(row: AetherTimelineMessage): unknown {
  if (row.role === "user") {
    return { type: "user_message", id: row.id, content: row.content };
  }
  switch (row.variant) {
    case "text":
      return { type: "assistant_message", id: row.id, content: row.content };
    case "thinking":
      return { type: "reasoning", id: row.id, content: row.content };
    case "seam":
      return { type: "seam", id: row.id, reason: row.seam.reason };
    case "tool": {
      const itemType = toolLifecycleItemTypeFromAether(row.tool.itemType ?? "unknown");
      const files =
        itemType === "file_change"
          ? parseFileChanges(row.tool.input, row.tool.result)
              .map((change) => change.path)
              .filter((path): path is string => path !== null)
          : [];
      return {
        type: "tool",
        id: row.tool.id,
        itemType,
        name: row.tool.name,
        status: row.tool.status,
        label: row.tool.display.label,
        ...(files.length > 0 ? { files } : {}),
      };
    }
  }
}

/**
 * Group timeline rows into turn snapshots: each user row opens a turn (its
 * durable row id keys the TurnId, so snapshots are stable across reads);
 * rows arriving before any user row open a synthetic leading turn.
 */
export function snapshotTurnsFromMessages(
  messages: ReadonlyArray<AetherTimelineMessage>,
): ReadonlyArray<ProviderThreadTurnSnapshot> {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  for (const row of messages) {
    if (row.role === "user" || turns.length === 0) {
      turns.push({ id: TurnId.make(`aether-turn-${row.id}`), items: [] });
    }
    turns[turns.length - 1]?.items.push(snapshotItemFromMessage(row));
  }
  return turns;
}

export const makeAetherAdapter = Effect.fn("makeAetherAdapter")(function* (
  options: AetherAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  Crypto.Crypto | Scope.Scope
> {
  const crypto = yield* Crypto.Crypto;
  // Scope-owned so registry teardown shuts the stream down with the instance.
  const runtimeEvents = yield* Effect.acquireRelease(
    Queue.unbounded<ProviderRuntimeEvent>(),
    Queue.shutdown,
  );
  const sessions = new Map<ThreadId, AetherSessionContext>();

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const randomEventId = crypto.randomUUIDv4.pipe(
    Effect.map(EventId.make),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Aether runtime identifier.",
          cause,
        }),
    ),
  );

  const requireRestClient = (method: string) =>
    options.restClient !== undefined
      ? Effect.succeed(options.restClient)
      : Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `No Aether API key configured. Add a sensitive ${AETHER_API_KEY_ENV_VAR} environment variable to this provider instance.`,
          }),
        );

  const toGitRequestError = (method: string) => (cause: GitCommandError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: `Git preflight failed: ${cause.detail}`,
      cause,
    });

  const toRestRequestError = (method: string) => (cause: { readonly message: string }) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });

  const ensureContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context !== undefined
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "startSession",
  )(function* (input) {
    const restClient = yield* requireRestClient("startSession");
    const cwd = input.cwd ?? options.defaultCwd;

    if (
      input.modelSelection !== undefined &&
      input.modelSelection.instanceId !== options.instanceId
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Aether model selection is bound to instance '${input.modelSelection.instanceId}', expected '${options.instanceId}'.`,
      });
    }

    // (1) Mirror preflight: clean tree on a pushed, in-sync branch.
    const status = yield* options.git
      .statusDetails(cwd)
      .pipe(Effect.mapError(toGitRequestError("startSession")));
    const issue = preflightIssue(status, cwd);
    if (issue !== undefined) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue,
      });
    }

    // (2) Repo → project resolution via the canonical owner/repo key.
    const originUrl = yield* options.git
      .readConfigValue(cwd, "remote.origin.url")
      .pipe(Effect.mapError(toGitRequestError("startSession")));
    if (originUrl === null || originUrl.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `'${cwd}' has no 'origin' remote. Aether cloud tasks run against a repository linked in Aether, matched by the origin remote URL.`,
      });
    }
    const repoKey = normalizeGitRemoteUrl(originUrl);
    const projects = yield* restClient
      .listProjects()
      .pipe(Effect.mapError(toRestRequestError("startSession")));
    const matches = projects.filter(
      (project): project is AetherProject & { readonly repo_url: string } =>
        typeof project.repo_url === "string" && normalizeGitRemoteUrl(project.repo_url) === repoKey,
    );
    if (matches.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `No Aether project is linked to '${originUrl.trim()}'. Link or import the repository in Aether first, then retry.`,
      });
    }
    if (matches.length > 1) {
      const candidates = matches.map((project) => `'${project.name}' (${project.id})`).join(", ");
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Multiple Aether projects are linked to '${originUrl.trim()}': ${candidates}. Archive the duplicates in Aether or start the task from Aether directly.`,
      });
    }
    const project = matches[0]!;

    // (3) Resume validation: the cursor's task must still exist remotely AND
    // belong to the project the cwd just resolved to — a persisted cursor is
    // untrusted input, and binding a foreign project's task here would later
    // mirror that repo's diffs onto this checkout.
    const resume = parseAetherResume(input.resumeCursor);
    let taskId: string | undefined;
    let latestSequence = 0;
    let turnLedger: unknown;
    if (resume !== undefined) {
      const task = yield* restClient.getTask(resume.taskId).pipe(
        Effect.mapError((cause) =>
          cause._tag === "AetherApiNotFoundError"
            ? new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
                cause,
              })
            : toRestRequestError("startSession")(cause),
        ),
      );
      if (task.project_id !== project.id) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Resumed Aether task '${resume.taskId}' belongs to project '${task.project_id}', but '${cwd}' resolves to project '${project.name}' (${project.id}). The checkout and the thread's cloud task have diverged — start the thread from the task's repository checkout, or start a fresh thread here.`,
        });
      }
      taskId = resume.taskId;
      // Keep the CURSOR's sequence, not the task row's: it is the safe
      // replay point — fast-forwarding here would skip never-ingested rows.
      latestSequence = resume.latestSequence;
      turnLedger = resume.turnLedger;
    }

    // (4) Session record. Model precedence: explicit selection, else the
    // project's task defaults as the composite `<agent_type>/<model>` slug.
    const model =
      input.modelSelection?.model ??
      `${project.task_defaults.agent_type}/${project.task_defaults.model}`;
    const createdAt = yield* nowIso;
    const context: AetherSessionContext = {
      session: {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model,
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      },
      cwd,
      projectId: project.id,
      taskId,
      latestSequence,
      turnLedger,
    };
    const resumeCursor = buildAetherResumeCursor(context);
    if (resumeCursor !== undefined) {
      context.session = { ...context.session, resumeCursor };
    }
    sessions.set(input.threadId, context);
    return context.session;
  });

  // Shared pure-disconnect teardown: the cloud task keeps running and the VM
  // idles itself out (spec §2.3 reaper-safety) — never POST /tasks/{id}/stop.
  // Ingestion relies on one graceful session.exited per thread to clear
  // active-turn/liveness state, so every disconnect path emits it.
  const disconnectSession = Effect.fn("disconnectSession")(function* (
    threadId: ThreadId,
    context: AetherSessionContext,
  ) {
    sessions.delete(threadId);
    yield* emit({
      eventId: yield* randomEventId,
      provider: PROVIDER,
      threadId,
      createdAt: yield* nowIso,
      type: "session.exited",
      payload: {
        reason:
          context.taskId === undefined
            ? "Disconnected from Aether."
            : "Disconnected from Aether; the cloud task keeps running.",
        recoverable: true,
        exitKind: "graceful",
      },
    });
  });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
    "stopSession",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    yield* disconnectSession(threadId, context);
  });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = Effect.fn(
    "readThread",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    if (context.taskId === undefined) {
      // No task yet — the thread has no remote conversation until the first
      // sendTurn creates one.
      return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
    }
    const restClient = yield* requireRestClient("readThread");
    const taskId = context.taskId;
    let page = yield* restClient
      .getConversationMessages(taskId)
      .pipe(Effect.mapError(toRestRequestError("readThread")));
    const rows: Array<AetherTimelineMessage> = [...page.messages];
    // Walk `hasMoreOlder` back to the first turn: the endpoint serves the
    // NEWEST page first, and a snapshot missing older turns would be silent
    // data loss. The cursor must advance every page — a stuck cursor is a
    // contract break, surfaced loudly instead of looping forever.
    while (page.hasMoreOlder) {
      const beforeSequence = page.oldestSequenceLoaded;
      const beforeSortTimestamp = page.oldestSortTimestampLoaded;
      if (beforeSequence === null || beforeSortTimestamp === null) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readThread",
          detail: `Aether conversation page for task '${taskId}' reports more older rows but carries no older-page cursor.`,
        });
      }
      page = yield* restClient
        .getConversationMessages(taskId, {
          sequence: beforeSequence,
          sortTimestamp: beforeSortTimestamp,
        })
        .pipe(Effect.mapError(toRestRequestError("readThread")));
      if (page.oldestSequenceLoaded !== null && page.oldestSequenceLoaded >= beforeSequence) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readThread",
          detail: `Aether conversation paging for task '${taskId}' did not advance past sequence ${beforeSequence}.`,
        });
      }
      rows.unshift(...page.messages);
    }
    return {
      threadId,
      turns: snapshotTurnsFromMessages(rows),
    } satisfies ProviderThreadSnapshot;
  });

  return {
    provider: PROVIDER,
    capabilities: {
      // Flips to "in-session" with the model-switch slice (build item 11).
      sessionModelSwitch: "unsupported",
    },
    startSession,
    sendTurn: () => notImplemented("sendTurn"),
    interruptTurn: () => notImplemented("interruptTurn"),
    respondToRequest: () => notImplemented("respondToRequest"),
    respondToUserInput: () => notImplemented("respondToUserInput"),
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread: () => notImplemented("rollbackThread"),
    // Pure disconnect for every session; remote tasks are untouched. Each
    // thread gets the same graceful session.exited stopSession emits —
    // ingestion clears per-session turn/liveness state from that event.
    stopAll: () =>
      Effect.gen(function* () {
        for (const [threadId, context] of [...sessions.entries()]) {
          yield* disconnectSession(threadId, context);
        }
      }),
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
