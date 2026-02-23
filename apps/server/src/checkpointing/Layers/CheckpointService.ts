/**
 * CheckpointServiceLive - Checkpoint workflow orchestration layer.
 *
 * Coordinates provider thread snapshots, filesystem checkpoint refs
 * (`CheckpointStore`), and checkpoint metadata persistence
 * (`CheckpointRepository`) for initialize/capture/list/diff/revert workflows.
 *
 * This layer owns checkpoint workflow rules and invariants. It does not execute
 * provider protocol details directly (adapter concern), and it does not perform
 * raw SQL or Git operations directly (catalog/store concerns).
 *
 * @module CheckpointServiceLive
 */
import type {
  ProviderCheckpoint,
  ProviderGetCheckpointDiffInput,
  ProviderListCheckpointsInput,
  ProviderRevertToCheckpointInput,
} from "@t3tools/contracts";
import {
  providerGetCheckpointDiffInputSchema,
  providerListCheckpointsInputSchema,
  providerRevertToCheckpointInputSchema,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Semaphore } from "effect";

import {
  CheckpointInvariantError,
  CheckpointRepositoryError,
  CheckpointServiceValidationError,
  CheckpointSessionNotFoundError,
  CheckpointUnavailableError,
  type CheckpointServiceError,
} from "../Errors.ts";
import {
  CheckpointService,
  type CaptureCurrentTurnInput,
  type CheckpointServiceShape,
  type InitializeCheckpointSessionInput,
} from "../Services/CheckpointService.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { CheckpointRepository } from "../../persistence/Services/Checkpoints.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../../provider/Errors.ts";

interface CheckpointCwdResolution {
  readonly candidateCwd: string;
  readonly checkpointCwd: Option.Option<string>;
}

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

function checkpointRefThreadSegment(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

function checkpointRefForThreadTurn(threadId: string, turnCount: number): string {
  return `${CHECKPOINT_REFS_PREFIX}/${checkpointRefThreadSegment(threadId)}/turn/${turnCount}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimToPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function summarizeUserMessageContent(content: unknown[]): string | undefined {
  const segments: string[] = [];

  for (const part of content) {
    const record = asObject(part);
    const type = asString(record?.type);
    if (!type) {
      continue;
    }

    if (type === "text") {
      const text = asString(record?.text);
      if (text && text.trim().length > 0) {
        segments.push(text.trim());
      }
      continue;
    }

    if (type === "image") {
      segments.push("[Image attachment]");
      continue;
    }

    if (type === "localImage") {
      segments.push("[Local image attachment]");
    }
  }

  if (segments.length === 0) {
    return undefined;
  }
  return trimToPreview(segments.join(" "));
}

function summarizeTurn(turn: ProviderThreadTurnSnapshot): {
  readonly messageCountDelta: number;
  readonly preview?: string;
} {
  let messageCountDelta = 0;
  let preview: string | undefined;

  for (const item of turn.items) {
    const record = asObject(item);
    const type = asString(record?.type);
    if (!type) {
      continue;
    }

    if (type === "userMessage") {
      messageCountDelta += 1;
      if (!preview) {
        const content = asArray(record?.content);
        preview = summarizeUserMessageContent(content);
      }
      continue;
    }

    if (type === "agentMessage") {
      messageCountDelta += 1;
      if (!preview) {
        const text = asString(record?.text);
        if (text && text.trim().length > 0) {
          preview = trimToPreview(text);
        }
      }
    }
  }

  return {
    messageCountDelta,
    ...(preview ? { preview } : {}),
  };
}

function buildCheckpoints(turns: ReadonlyArray<ProviderThreadTurnSnapshot>): ProviderCheckpoint[] {
  const checkpoints: ProviderCheckpoint[] = [];
  let messageCount = 0;
  const isEmpty = turns.length === 0;

  checkpoints.push({
    id: "root",
    turnCount: 0,
    messageCount: 0,
    label: "Start of conversation",
    isCurrent: isEmpty,
  });

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }

    const turnSummary = summarizeTurn(turn);
    messageCount += turnSummary.messageCountDelta;
    checkpoints.push({
      id: turn.id,
      turnCount: index + 1,
      messageCount,
      label: `Turn ${index + 1}`,
      ...(turnSummary.preview ? { preview: turnSummary.preview } : {}),
      isCurrent: index === turns.length - 1,
    });
  }

  return checkpoints;
}

function rootCheckpoint(): ProviderCheckpoint {
  return {
    id: "root",
    turnCount: 0,
    messageCount: 0,
    label: "Start of conversation",
    isCurrent: true,
  };
}

function validationError(
  operation: string,
  issue: string,
  cause?: unknown,
): CheckpointServiceValidationError {
  return new CheckpointServiceValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function invariantError(
  operation: string,
  detail: string,
  cause?: unknown,
): CheckpointInvariantError {
  return new CheckpointInvariantError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function normalizeNonEmpty(
  value: string,
  operation: string,
  field: string,
): Effect.Effect<string, CheckpointServiceValidationError> {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return Effect.fail(validationError(operation, `${field} must be a non-empty string.`));
  }
  return Effect.succeed(normalized);
}

function decodeInitializeInput(
  input: InitializeCheckpointSessionInput,
): Effect.Effect<InitializeCheckpointSessionInput, CheckpointServiceValidationError> {
  return Effect.gen(function* () {
    const operation = "CheckpointService.initializeForSession";
    const providerSessionId = yield* normalizeNonEmpty(
      input.providerSessionId,
      operation,
      "providerSessionId",
    );
    const cwd = yield* normalizeNonEmpty(input.cwd, operation, "cwd");
    return {
      providerSessionId,
      cwd,
    } satisfies InitializeCheckpointSessionInput;
  });
}

function decodeCaptureInput(
  input: CaptureCurrentTurnInput,
): Effect.Effect<CaptureCurrentTurnInput, CheckpointServiceValidationError> {
  return Effect.gen(function* () {
    const operation = "CheckpointService.captureCurrentTurn";
    const providerSessionId = yield* normalizeNonEmpty(
      input.providerSessionId,
      operation,
      "providerSessionId",
    );
    const turnId = input.turnId?.trim();
    const status = input.status?.trim();

    return {
      providerSessionId,
      ...(turnId ? { turnId } : {}),
      ...(status ? { status } : {}),
    } satisfies CaptureCurrentTurnInput;
  });
}

function decodeListInput(
  input: ProviderListCheckpointsInput,
): Effect.Effect<ProviderListCheckpointsInput, CheckpointServiceValidationError> {
  const parsed = providerListCheckpointsInputSchema.safeParse(input);
  if (!parsed.success) {
    return Effect.fail(
      validationError(
        "CheckpointService.listCheckpoints",
        parsed.error.message,
        parsed.error.cause,
      ),
    );
  }
  return Effect.succeed(parsed.data);
}

function decodeDiffInput(
  input: ProviderGetCheckpointDiffInput,
): Effect.Effect<ProviderGetCheckpointDiffInput, CheckpointServiceValidationError> {
  const parsed = providerGetCheckpointDiffInputSchema.safeParse(input);
  if (!parsed.success) {
    return Effect.fail(
      validationError(
        "CheckpointService.getCheckpointDiff",
        parsed.error.message,
        parsed.error.cause,
      ),
    );
  }
  return Effect.succeed(parsed.data);
}

function decodeRevertInput(
  input: ProviderRevertToCheckpointInput,
): Effect.Effect<ProviderRevertToCheckpointInput, CheckpointServiceValidationError> {
  const parsed = providerRevertToCheckpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return Effect.fail(
      validationError(
        "CheckpointService.revertToCheckpoint",
        parsed.error.message,
        parsed.error.cause,
      ),
    );
  }
  return Effect.succeed(parsed.data);
}

const makeCheckpointService = Effect.gen(function* () {
  const store = yield* CheckpointStore;
  const checkpointRepository = yield* CheckpointRepository;
  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;

  const sessionCheckpointCwdsRef = yield* Ref.make<Map<string, string>>(new Map<string, string>());
  const sessionSemaphoresRef = yield* Ref.make<Map<string, Semaphore.Semaphore>>(
    new Map<string, Semaphore.Semaphore>(),
  );

  const getSessionSemaphore = (sessionId: string) =>
    Ref.modify(sessionSemaphoresRef, (current) => {
      const existing = current.get(sessionId);
      if (existing) {
        return [existing, current] as const;
      }

      const next = new Map(current);
      const semaphore = Semaphore.makeUnsafe(1);
      next.set(sessionId, semaphore);
      return [semaphore, next] as const;
    });

  const withSessionLock = <A>(
    sessionId: string,
    effect: Effect.Effect<A, CheckpointServiceError>,
  ) =>
    getSessionSemaphore(sessionId).pipe(
      Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)),
    );

  const setTrackedCheckpointCwd = (sessionId: string, cwd: string) =>
    Ref.update(sessionCheckpointCwdsRef, (current) => {
      const next = new Map(current);
      next.set(sessionId, cwd);
      return next;
    });

  const clearTrackedCheckpointCwd = (sessionId: string) =>
    Ref.update(sessionCheckpointCwdsRef, (current) => {
      if (!current.has(sessionId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });

  const clearSessionSemaphore = (sessionId: string) =>
    Ref.update(sessionSemaphoresRef, (current) => {
      if (!current.has(sessionId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });

  const getTrackedCheckpointCwd = (sessionId: string) =>
    Ref.get(sessionCheckpointCwdsRef).pipe(
      Effect.map((current) => Option.fromNullishOr(current.get(sessionId))),
    );

  const mapDirectoryLookupError = (
    sessionId: string,
    operation: string,
    cause: unknown,
  ): CheckpointSessionNotFoundError | CheckpointInvariantError => {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      (cause as { _tag?: string })._tag === "ProviderSessionNotFoundError"
    ) {
      return new CheckpointSessionNotFoundError({
        sessionId,
        cause,
      });
    }

    return invariantError(
      operation,
      `Failed to resolve provider session metadata for session ${sessionId}.`,
      cause,
    );
  };

  const resolveAdapterForSession = (
    sessionId: string,
  ): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, CheckpointServiceError> =>
    directory.getProvider(sessionId).pipe(
      Effect.mapError((cause) =>
        mapDirectoryLookupError(
          sessionId,
          "CheckpointService.resolveAdapterForSession:getProvider",
          cause,
        ),
      ),
      Effect.flatMap((provider) =>
        registry
          .getByProvider(provider)
          .pipe(
            Effect.mapError((cause) =>
              invariantError(
                "CheckpointService.resolveAdapterForSession",
                `Provider '${provider}' is not registered for session ${sessionId}.`,
                cause,
              ),
            ),
          ),
      ),
    );

  const ensureSessionIsActive = (
    sessionId: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): Effect.Effect<void, CheckpointSessionNotFoundError> =>
    adapter.hasSession(sessionId).pipe(
      Effect.flatMap((hasSession) =>
        hasSession
          ? Effect.void
          : Effect.fail(
              new CheckpointSessionNotFoundError({
                sessionId,
              }),
            ),
      ),
    );

  const readThreadSnapshot = (
    sessionId: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    operation: string,
  ): Effect.Effect<ProviderThreadSnapshot, CheckpointInvariantError> =>
    adapter
      .readThread(sessionId)
      .pipe(
        Effect.mapError((cause) =>
          invariantError(
            operation,
            `Failed to read thread snapshot for session ${sessionId}.`,
            cause,
          ),
        ),
      );

  const resolveThreadIdForSession = (
    sessionId: string,
    operation: string,
  ): Effect.Effect<string, CheckpointServiceError> =>
    directory.getThreadId(sessionId).pipe(
      Effect.mapError((cause) =>
        mapDirectoryLookupError(sessionId, `${operation}:getThreadId`, cause),
      ),
      Effect.flatMap((threadId) =>
        Option.match(threadId, {
          onSome: (value) => {
            const normalizedThreadId = value.trim();
            if (normalizedThreadId.length > 0) {
              return Effect.succeed(normalizedThreadId);
            }
            return Effect.fail(
              invariantError(operation, `Resolved empty thread id for session ${sessionId}.`),
            );
          },
          onNone: () =>
            Effect.fail(
              invariantError(
                operation,
                `Missing thread id in session directory for session ${sessionId}.`,
              ),
            ),
        }),
      ),
    );

  const ensureThreadMatchesSnapshot = (
    resolvedThreadId: string,
    snapshot: ProviderThreadSnapshot,
    operation: string,
  ): Effect.Effect<void, CheckpointInvariantError> => {
    const snapshotThreadId = snapshot.threadId.trim();
    if (snapshotThreadId.length === 0) {
      return Effect.fail(
        invariantError(operation, "Provider thread snapshot is missing threadId."),
      );
    }

    if (snapshotThreadId !== resolvedThreadId) {
      return Effect.fail(
        invariantError(
          operation,
          `Resolved thread ${resolvedThreadId} does not match provider snapshot thread ${snapshotThreadId}.`,
        ),
      );
    }

    return Effect.void;
  };

  const rollbackThreadSnapshot = (
    sessionId: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    numTurns: number,
    operation: string,
  ): Effect.Effect<ProviderThreadSnapshot, CheckpointInvariantError> =>
    adapter
      .rollbackThread(sessionId, numTurns)
      .pipe(
        Effect.mapError((cause) =>
          invariantError(operation, `Failed to rollback thread for session ${sessionId}.`, cause),
        ),
      );

  const persistCheckpointMetadata = (input: {
    readonly providerSessionId: string;
    readonly threadId: string;
    readonly checkpoint: ProviderCheckpoint;
  }): Effect.Effect<void, CheckpointServiceError> =>
    checkpointRepository.upsertCheckpoint({
      providerSessionId: input.providerSessionId,
      threadId: input.threadId,
      checkpointId: input.checkpoint.id,
      checkpointRef: checkpointRefForThreadTurn(input.threadId, input.checkpoint.turnCount),
      turnCount: input.checkpoint.turnCount,
      messageCount: input.checkpoint.messageCount,
      label: input.checkpoint.label,
      ...(input.checkpoint.preview !== undefined ? { preview: input.checkpoint.preview } : {}),
      createdAt: new Date().toISOString(),
    });

  const captureAndPersistCheckpoint = (input: {
    readonly providerSessionId: string;
    readonly cwd: string;
    readonly threadId: string;
    readonly checkpoint: ProviderCheckpoint;
  }): Effect.Effect<void, CheckpointServiceError> => {
    const checkpointRef = checkpointRefForThreadTurn(input.threadId, input.checkpoint.turnCount);
    return Effect.gen(function* () {
      yield* store.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef,
      });

      yield* persistCheckpointMetadata({
        providerSessionId: input.providerSessionId,
        threadId: input.threadId,
        checkpoint: input.checkpoint,
      }).pipe(
        Effect.catch((error) =>
          store
            .deleteCheckpointRefs({
              cwd: input.cwd,
              checkpointRefs: [checkpointRef],
            })
            .pipe(
              Effect.catch(() => Effect.void),
              Effect.flatMap(() => Effect.fail(error)),
            ),
        ),
      );
    });
  };

  const latestCheckpointFromSnapshot = (
    snapshot: ProviderThreadSnapshot,
    operation: string,
  ): Effect.Effect<ProviderCheckpoint, CheckpointInvariantError> => {
    if (snapshot.turns.length === 0) {
      return Effect.fail(
        invariantError(operation, "Cannot derive latest checkpoint from an empty thread snapshot."),
      );
    }

    const checkpoints = buildCheckpoints(snapshot.turns);
    const latest = checkpoints[checkpoints.length - 1];
    if (!latest || latest.turnCount !== snapshot.turns.length) {
      return Effect.fail(
        invariantError(
          operation,
          `Unable to derive checkpoint metadata for turn ${snapshot.turns.length}.`,
        ),
      );
    }

    return Effect.succeed(latest);
  };

  const ensureRootCheckpointMetadata = (
    threadId: string,
    operation: string,
  ): Effect.Effect<void, CheckpointServiceError> =>
    checkpointRepository
      .getCheckpoint({ threadId, turnCount: 0 })
      .pipe(
        Effect.flatMap((rootEntry) =>
          Option.isSome(rootEntry)
            ? Effect.void
            : Effect.fail(
                invariantError(
                  operation,
                  `Missing root checkpoint metadata for thread ${threadId}.`,
                ),
              ),
        ),
      );

  const getCheckpointRefOrFail = (
    threadId: string,
    turnCount: number,
    operation: string,
  ): Effect.Effect<string, CheckpointServiceError> =>
    checkpointRepository.getCheckpoint({ threadId, turnCount }).pipe(
      Effect.mapError((error): CheckpointServiceError => error),
      Effect.flatMap((checkpoint): Effect.Effect<string, CheckpointServiceError> => {
        if (Option.isNone(checkpoint)) {
          return Effect.fail(
            new CheckpointUnavailableError({
              threadId,
              turnCount,
              detail: `Filesystem checkpoint is unavailable for turn ${turnCount} in thread ${threadId}.`,
            }),
          );
        }

        const checkpointRef = checkpoint.value.checkpointRef.trim();
        if (checkpointRef.length === 0) {
          return Effect.fail(
            invariantError(
              operation,
              `Checkpoint metadata for turn ${turnCount} is missing checkpointRef.`,
            ),
          );
        }

        return Effect.succeed(checkpointRef);
      }),
    );

  const resolveCandidateCwd = (
    sessionId: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): Effect.Effect<string> =>
    adapter.listSessions().pipe(
      Effect.map((sessions) => sessions.find((session) => session.sessionId === sessionId)?.cwd),
      Effect.map((cwd) => {
        const candidate = cwd?.trim() || process.cwd();
        if (candidate.length > 0) {
          return candidate;
        }
        return process.cwd();
      }),
    );

  const resolveCheckpointCwd = (
    sessionId: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): Effect.Effect<CheckpointCwdResolution, CheckpointServiceError> =>
    Effect.gen(function* () {
      const tracked = yield* getTrackedCheckpointCwd(sessionId);
      if (Option.isSome(tracked)) {
        return {
          candidateCwd: tracked.value,
          checkpointCwd: tracked,
        } satisfies CheckpointCwdResolution;
      }

      const candidateCwd = yield* resolveCandidateCwd(sessionId, adapter);
      const supportsGit = yield* store.isGitRepository(candidateCwd);
      if (!supportsGit) {
        yield* clearTrackedCheckpointCwd(sessionId);
        return {
          candidateCwd,
          checkpointCwd: Option.none(),
        } satisfies CheckpointCwdResolution;
      }

      yield* setTrackedCheckpointCwd(sessionId, candidateCwd);

      return {
        candidateCwd,
        checkpointCwd: Option.some(candidateCwd),
      } satisfies CheckpointCwdResolution;
    });

  const initializeForSession: CheckpointServiceShape["initializeForSession"] = (rawInput) =>
    decodeInitializeInput(rawInput).pipe(
      Effect.flatMap((input) =>
        withSessionLock(
          input.providerSessionId,
          Effect.gen(function* () {
            const adapter = yield* resolveAdapterForSession(input.providerSessionId);
            yield* ensureSessionIsActive(input.providerSessionId, adapter);
            const threadId = yield* resolveThreadIdForSession(
              input.providerSessionId,
              "CheckpointService.initializeForSession",
            );

            const supportsGit = yield* store.isGitRepository(input.cwd);
            if (!supportsGit) {
              yield* clearTrackedCheckpointCwd(input.providerSessionId);
              return;
            }

            const existingRoot = yield* checkpointRepository.getCheckpoint({
              threadId,
              turnCount: 0,
            });
            if (Option.isSome(existingRoot)) {
              const existingRef = existingRoot.value.checkpointRef.trim();
              if (existingRef.length === 0) {
                return yield* invariantError(
                  "CheckpointService.initializeForSession",
                  "Existing root checkpoint metadata is missing checkpointRef.",
                );
              }
              const exists = yield* store.hasCheckpointRef({
                cwd: input.cwd,
                checkpointRef: existingRef,
              });
              if (!exists) {
                return yield* invariantError(
                  "CheckpointService.initializeForSession",
                  "Root checkpoint metadata exists but filesystem ref is missing.",
                );
              }
              yield* setTrackedCheckpointCwd(input.providerSessionId, input.cwd);
              return;
            }

            yield* captureAndPersistCheckpoint({
              providerSessionId: input.providerSessionId,
              cwd: input.cwd,
              threadId,
              checkpoint: rootCheckpoint(),
            });
            yield* setTrackedCheckpointCwd(input.providerSessionId, input.cwd);
          }),
        ),
      ),
    );

  const captureCurrentTurn: CheckpointServiceShape["captureCurrentTurn"] = (rawInput) =>
    decodeCaptureInput(rawInput).pipe(
      Effect.flatMap((input) =>
        withSessionLock(
          input.providerSessionId,
          Effect.gen(function* () {
            const adapter = yield* resolveAdapterForSession(input.providerSessionId);
            yield* ensureSessionIsActive(input.providerSessionId, adapter);
            const snapshot = yield* readThreadSnapshot(
              input.providerSessionId,
              adapter,
              "CheckpointService.captureCurrentTurn:readThread",
            );
            const threadId = yield* resolveThreadIdForSession(
              input.providerSessionId,
              "CheckpointService.captureCurrentTurn",
            );
            yield* ensureThreadMatchesSnapshot(
              threadId,
              snapshot,
              "CheckpointService.captureCurrentTurn",
            );
            if (snapshot.turns.length === 0) {
              return;
            }

            const resolution = yield* resolveCheckpointCwd(input.providerSessionId, adapter);
            if (Option.isNone(resolution.checkpointCwd)) {
              return;
            }

            const checkpoint = yield* latestCheckpointFromSnapshot(
              snapshot,
              "CheckpointService.captureCurrentTurn",
            );

            yield* ensureRootCheckpointMetadata(threadId, "CheckpointService.captureCurrentTurn");

            const existing = yield* checkpointRepository.getCheckpoint({
              threadId,
              turnCount: checkpoint.turnCount,
            });
            if (Option.isSome(existing)) {
              const checkpointRef = existing.value.checkpointRef.trim();
              if (checkpointRef.length === 0) {
                return yield* invariantError(
                  "CheckpointService.captureCurrentTurn",
                  `Checkpoint metadata for turn ${checkpoint.turnCount} is missing checkpointRef.`,
                );
              }
              const exists = yield* store.hasCheckpointRef({
                cwd: resolution.checkpointCwd.value,
                checkpointRef,
              });
              if (!exists) {
                return yield* invariantError(
                  "CheckpointService.captureCurrentTurn",
                  `Checkpoint metadata exists for turn ${checkpoint.turnCount} but filesystem ref is missing.`,
                );
              }
              return;
            }

            yield* captureAndPersistCheckpoint({
              providerSessionId: input.providerSessionId,
              cwd: resolution.checkpointCwd.value,
              threadId,
              checkpoint,
            });
          }),
        ),
      ),
    );

  const listCheckpoints: CheckpointServiceShape["listCheckpoints"] = (rawInput) =>
    decodeListInput(rawInput).pipe(
      Effect.flatMap((input) =>
        withSessionLock(
          input.sessionId,
          Effect.gen(function* () {
            const adapter = yield* resolveAdapterForSession(input.sessionId);
            yield* ensureSessionIsActive(input.sessionId, adapter);
            const snapshot = yield* readThreadSnapshot(
              input.sessionId,
              adapter,
              "CheckpointService.listCheckpoints:readThread",
            );
            const threadId = yield* resolveThreadIdForSession(
              input.sessionId,
              "CheckpointService.listCheckpoints",
            );
            yield* ensureThreadMatchesSnapshot(
              threadId,
              snapshot,
              "CheckpointService.listCheckpoints",
            );

            const resolution = yield* resolveCheckpointCwd(input.sessionId, adapter);
            if (Option.isNone(resolution.checkpointCwd)) {
              return yield* new CheckpointRepositoryError({
                cwd: resolution.candidateCwd,
                detail: "Filesystem checkpoints are unavailable for this session.",
              });
            }

            const checkpoints = yield* checkpointRepository.listCheckpoints({
              threadId,
            });
            if (checkpoints.length === 0) {
              return yield* invariantError(
                "CheckpointService.listCheckpoints",
                `Missing checkpoint metadata for active session ${input.sessionId}.`,
              );
            }

            return {
              threadId,
              checkpoints: Array.from(checkpoints),
            };
          }),
        ),
      ),
    );

  const getCheckpointDiff: CheckpointServiceShape["getCheckpointDiff"] = (rawInput) =>
    decodeDiffInput(rawInput).pipe(
      Effect.flatMap((input) =>
        withSessionLock(
          input.sessionId,
          Effect.gen(function* () {
            const adapter = yield* resolveAdapterForSession(input.sessionId);
            yield* ensureSessionIsActive(input.sessionId, adapter);
            const snapshot = yield* readThreadSnapshot(
              input.sessionId,
              adapter,
              "CheckpointService.getCheckpointDiff:readThread",
            );
            const threadId = yield* resolveThreadIdForSession(
              input.sessionId,
              "CheckpointService.getCheckpointDiff",
            );
            yield* ensureThreadMatchesSnapshot(
              threadId,
              snapshot,
              "CheckpointService.getCheckpointDiff",
            );

            if (input.toTurnCount > snapshot.turns.length) {
              return yield* validationError(
                "CheckpointService.getCheckpointDiff",
                `Checkpoint turn count ${input.toTurnCount} exceeds current turn count ${snapshot.turns.length}.`,
              );
            }

            const resolution = yield* resolveCheckpointCwd(input.sessionId, adapter);
            if (Option.isNone(resolution.checkpointCwd)) {
              return yield* new CheckpointRepositoryError({
                cwd: resolution.candidateCwd,
                detail: "Filesystem checkpoints are unavailable for this session.",
              });
            }

            const fromCheckpointRef = yield* getCheckpointRefOrFail(
              threadId,
              input.fromTurnCount,
              "CheckpointService.getCheckpointDiff:fromCheckpoint",
            );
            const toCheckpointRef = yield* getCheckpointRefOrFail(
              threadId,
              input.toTurnCount,
              "CheckpointService.getCheckpointDiff:toCheckpoint",
            );

            const diff = yield* store.diffCheckpoints({
              cwd: resolution.checkpointCwd.value,
              fromCheckpointRef,
              toCheckpointRef,
              fallbackFromToHead: input.fromTurnCount === 0,
            });

            return {
              threadId,
              fromTurnCount: input.fromTurnCount,
              toTurnCount: input.toTurnCount,
              diff,
            };
          }),
        ),
      ),
    );

  const revertToCheckpoint: CheckpointServiceShape["revertToCheckpoint"] = (rawInput) =>
    decodeRevertInput(rawInput).pipe(
      Effect.flatMap((input) =>
        withSessionLock(
          input.sessionId,
          Effect.gen(function* () {
            const adapter = yield* resolveAdapterForSession(input.sessionId);
            yield* ensureSessionIsActive(input.sessionId, adapter);
            const beforeSnapshot = yield* readThreadSnapshot(
              input.sessionId,
              adapter,
              "CheckpointService.revertToCheckpoint:readThread",
            );
            const threadId = yield* resolveThreadIdForSession(
              input.sessionId,
              "CheckpointService.revertToCheckpoint",
            );
            yield* ensureThreadMatchesSnapshot(
              threadId,
              beforeSnapshot,
              "CheckpointService.revertToCheckpoint",
            );
            const currentTurnCount = beforeSnapshot.turns.length;

            if (input.turnCount > currentTurnCount) {
              return yield* validationError(
                "CheckpointService.revertToCheckpoint",
                `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
              );
            }

            const resolution = yield* resolveCheckpointCwd(input.sessionId, adapter);
            if (Option.isNone(resolution.checkpointCwd)) {
              return yield* new CheckpointRepositoryError({
                cwd: resolution.candidateCwd,
                detail: "Filesystem checkpoints are unavailable for this session.",
              });
            }

            const checkpointCwd = resolution.checkpointCwd.value;
            const checkpointRef = yield* getCheckpointRefOrFail(
              threadId,
              input.turnCount,
              "CheckpointService.revertToCheckpoint:checkpointLookup",
            );

            const restored = yield* store.restoreCheckpoint({
              cwd: checkpointCwd,
              checkpointRef,
              fallbackToHead: input.turnCount === 0,
            });
            if (!restored) {
              return yield* new CheckpointUnavailableError({
                threadId,
                turnCount: input.turnCount,
                detail: `Filesystem checkpoint is unavailable for turn ${input.turnCount} in thread ${threadId}.`,
              });
            }

            const requestedRollbackTurns = currentTurnCount - input.turnCount;
            const afterSnapshot =
              requestedRollbackTurns > 0
                ? yield* rollbackThreadSnapshot(
                    input.sessionId,
                    adapter,
                    requestedRollbackTurns,
                    "CheckpointService.revertToCheckpoint:rollbackThread",
                  )
                : beforeSnapshot;

            const staleTurnCounts: number[] = [];
            for (let turn = input.turnCount + 1; turn <= currentTurnCount; turn += 1) {
              staleTurnCounts.push(turn);
            }

            const staleCheckpointRefs = yield* Effect.forEach(
              staleTurnCounts,
              (turnCount) =>
                checkpointRepository.getCheckpoint({
                  threadId,
                  turnCount,
                }),
              { discard: false },
            ).pipe(
              Effect.map((entries) =>
                entries
                  .flatMap((entry) =>
                    Option.isSome(entry) ? [entry.value.checkpointRef.trim()] : [],
                  )
                  .filter((ref) => ref.length > 0),
              ),
            );

            yield* store.deleteCheckpointRefs({
              cwd: checkpointCwd,
              checkpointRefs: staleCheckpointRefs,
            });
            yield* checkpointRepository.deleteAfterTurn({
              threadId,
              maxTurnCount: input.turnCount,
            });
            const checkpoints = yield* checkpointRepository.listCheckpoints({
              threadId,
            });
            const currentCheckpoint =
              checkpoints.find((checkpoint) => checkpoint.isCurrent) ??
              checkpoints[checkpoints.length - 1] ??
              checkpoints[0];
            const rolledBackTurns = Math.max(0, currentTurnCount - afterSnapshot.turns.length);

            return {
              threadId,
              turnCount: currentCheckpoint?.turnCount ?? 0,
              messageCount: currentCheckpoint?.messageCount ?? 0,
              rolledBackTurns,
              checkpoints: Array.from(checkpoints),
            };
          }),
        ),
      ),
    );

  const releaseSession: CheckpointServiceShape["releaseSession"] = (input) =>
    Effect.gen(function* () {
      const providerSessionId = yield* normalizeNonEmpty(
        input.providerSessionId,
        "CheckpointService.releaseSession",
        "providerSessionId",
      );
      yield* clearTrackedCheckpointCwd(providerSessionId);
      yield* clearSessionSemaphore(providerSessionId);
    });

  return {
    initializeForSession,
    captureCurrentTurn,
    listCheckpoints,
    getCheckpointDiff,
    revertToCheckpoint,
    releaseSession,
  } satisfies CheckpointServiceShape;
});

export const CheckpointServiceLive = Layer.effect(CheckpointService, makeCheckpointService);
