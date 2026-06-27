import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionRuntimeStatus,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "./Errors.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError =
  | ProviderSessionDirectoryPersistenceError
  | ProviderSessionNotFoundError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  {
    readonly upsert: (
      binding: ProviderRuntimeBinding,
    ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
    readonly getProvider: (
      threadId: ThreadId,
    ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;
    readonly getBinding: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<ProviderRuntimeBinding>,
      ProviderSessionDirectoryPersistenceError
    >;
    readonly listThreadIds: () => Effect.Effect<
      ReadonlyArray<ThreadId>,
      ProviderSessionDirectoryPersistenceError
    >;
    readonly listBindings: () => Effect.Effect<
      ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
      ProviderSessionDirectoryPersistenceError
    >;
  }
>()("t3/provider/ProviderSessionDirectory") {}

const decodeProviderDriverKindValue = Schema.decodeUnknownEffect(ProviderDriverKind);

function decodeProviderDriverKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKindValue(providerName).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSessionDirectoryPersistenceError({
          operation,
          detail: `Unknown persisted provider '${providerName}'.`,
          cause,
        }),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

function toRuntimeBinding(
  runtime: ProviderSessionRuntime.ProviderSessionRuntime,
  operation: string,
): Effect.Effect<ProviderRuntimeBindingWithMetadata, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKind(runtime.providerName, operation).pipe(
    Effect.map(
      (provider) =>
        ({
          threadId: runtime.threadId,
          provider,
          // Migration boundary: rows written before provider instances had a
          // nullable id. Promote them here so runtime routing never has to
          // infer an instance from its driver kind.
          providerInstanceId: runtime.providerInstanceId ?? defaultInstanceIdForDriver(provider),
          adapterKey: runtime.adapterKey,
          runtimeMode: runtime.runtimeMode,
          status: runtime.status,
          resumeCursor: runtime.resumeCursor,
          runtimePayload: runtime.runtimePayload,
          lastSeenAt: runtime.lastSeenAt,
        }) satisfies ProviderRuntimeBindingWithMetadata,
    ),
  );
}

export const make = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const getBinding: ProviderSessionDirectory["Service"]["getBinding"] = (threadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSessionDirectoryPersistenceError({
            operation: "ProviderSessionDirectory.getBinding:getByThreadId",
            detail: "Failed to read the persisted provider session binding.",
            cause,
          }),
      ),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            toRuntimeBinding(value, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectory["Service"]["upsert"] = Effect.fn(
    "ProviderSessionDirectory.upsert",
  )(function* (binding) {
    const existing = yield* repository.getByThreadId({ threadId: binding.threadId }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSessionDirectoryPersistenceError({
            operation: "ProviderSessionDirectory.upsert:getByThreadId",
            detail: "Failed to read the existing provider session binding before upsert.",
            cause,
          }),
      ),
    );

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const providerInstanceId =
      binding.providerInstanceId ?? (!providerChanged ? existingRuntime?.providerInstanceId : null);
    if (providerInstanceId === null || providerInstanceId === undefined) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "providerInstanceId is required for provider session runtime bindings.",
      });
    }
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        providerInstanceId,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          binding.runtimePayload,
        ),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSessionDirectoryPersistenceError({
              operation: "ProviderSessionDirectory.upsert:upsert",
              detail: "Failed to persist the provider session binding.",
              cause,
            }),
        ),
      );
  });

  const getProvider: ProviderSessionDirectory["Service"]["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionNotFoundError({
                threadId,
              }),
            ),
        }),
      ),
    );

  const listThreadIds: ProviderSessionDirectory["Service"]["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSessionDirectoryPersistenceError({
            operation: "ProviderSessionDirectory.listThreadIds:list",
            detail: "Failed to list persisted provider session bindings.",
            cause,
          }),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectory["Service"]["listBindings"] = () =>
    repository.list().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSessionDirectoryPersistenceError({
            operation: "ProviderSessionDirectory.listBindings:list",
            detail: "Failed to list persisted provider session bindings.",
            cause,
          }),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => toRuntimeBinding(row, "ProviderSessionDirectory.listBindings"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  return ProviderSessionDirectory.of({
    upsert,
    getProvider,
    getBinding,
    listThreadIds,
    listBindings,
  });
});

export const layer = Layer.effect(ProviderSessionDirectory, make);
