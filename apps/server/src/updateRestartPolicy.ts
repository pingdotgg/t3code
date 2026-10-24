import { RunId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "./config.ts";

const Entry = Schema.Struct({
  requestId: Schema.String,
  ownerId: Schema.String,
  pending: Schema.Boolean,
  runIds: Schema.Array(RunId),
});
const State = Schema.Struct({
  entries: Schema.Array(Entry),
  latestRequestId: Schema.NullOr(Schema.String),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(State));
const encode = Schema.encodeEffect(Schema.fromJsonString(State));

export class UpdateRestartPolicyError extends Schema.TaggedError<UpdateRestartPolicyError>()(
  "UpdateRestartPolicyError",
  { cause: Schema.Defect(), filePath: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return this.filePath === undefined
      ? "Update restart policy operation failed."
      : `Could not load update restart policy file '${this.filePath}'. Restore a known valid policy file or repair its permissions before restarting the server.`;
  }
}

export class UpdateRestartPolicy extends Context.Reference<{
  readonly set: (
    requestId: string,
    continueRunningThreads: boolean,
  ) => Effect.Effect<void, UpdateRestartPolicyError>;
  readonly capture: (
    runIds: ReadonlyArray<RunId>,
    trigger: "startup" | "shutdown",
    continuationPending?: (runId: RunId) => Effect.Effect<boolean, UpdateRestartPolicyError>,
  ) => Effect.Effect<void, UpdateRestartPolicyError>;
  readonly isVetoed: (runId: RunId) => Effect.Effect<boolean>;
}>("t3/UpdateRestartPolicy", {
  defaultValue: () => ({
    set: (_requestId, enabled) =>
      enabled
        ? Effect.void
        : Effect.fail(new UpdateRestartPolicyError({ cause: "Update policy is unavailable." })),
    capture: () => Effect.void,
    isVetoed: () => Effect.succeed(false),
  }),
}) {}

export const make = Effect.fn("UpdateRestartPolicy.make")(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const ownerId = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));
    const initial = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(
        (error) => "reason" in error && error.reason._tag === "NotFound",
        () => Effect.succeed({ entries: [], latestRequestId: null } as typeof State.Type),
      ),
    );
    const state = yield* Ref.make({
      saved: initial,
      vetoed: new Set(initial.entries.flatMap((entry) => entry.runIds)),
    });
    const mutex = yield* Semaphore.make(1);
    const change = (
      update: (
        current: typeof State.Type,
      ) => Effect.Effect<typeof State.Type, UpdateRestartPolicyError>,
    ) =>
      mutex
        .withPermits(1)(
          Effect.gen(function* () {
            const previous = (yield* Ref.get(state)).saved;
            const next = yield* update(previous);
            if (next === previous) return;
            const contents = yield* encode(next);
            yield* writeFileStringAtomically({ filePath, contents }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(HostProcess.Platform, platform),
            );
            yield* Ref.set(state, {
              saved: next,
              vetoed: new Set(next.entries.flatMap((entry) => entry.runIds)),
            });
          }),
        )
        .pipe(
          Effect.uninterruptible,
          Effect.mapError((cause) => new UpdateRestartPolicyError({ cause })),
        );

    return UpdateRestartPolicy.of({
      set: Effect.fn("UpdateRestartPolicy.set")(function* (requestId, continueRunningThreads) {
        yield* change((current) =>
          Effect.sync(() => {
            const existing = current.entries.find((entry) => entry.requestId === requestId);
            if (continueRunningThreads) {
              return existing?.pending && existing.ownerId === ownerId
                ? {
                    ...current,
                    entries: current.entries.flatMap((entry) =>
                      entry !== existing
                        ? [entry]
                        : entry.runIds.length === 0
                          ? []
                          : [{ ...entry, pending: false }],
                    ),
                  }
                : current;
            }
            return existing !== undefined || current.latestRequestId === requestId
              ? current
              : {
                  entries: [...current.entries, { requestId, ownerId, pending: true, runIds: [] }],
                  latestRequestId: requestId,
                };
          }),
        );
      }),
      capture: Effect.fn("UpdateRestartPolicy.capture")(
        function* (runIds, trigger, continuationPending) {
          yield* change((current) =>
            Effect.gen(function* () {
              const eligible = new Set(runIds);
              const entries: Array<typeof Entry.Type> = [];
              for (const saved of current.entries) {
                let entry = saved;
                if (
                  entry.pending &&
                  (trigger === "startup" ? entry.ownerId !== ownerId : entry.ownerId === ownerId)
                ) {
                  entry = {
                    ...entry,
                    pending: trigger !== "startup",
                    runIds: [...new Set([...entry.runIds, ...runIds])],
                  };
                }
                if (trigger === "startup" && !entry.pending && continuationPending) {
                  const retained: RunId[] = [];
                  for (const id of entry.runIds) {
                    if (eligible.has(id) || (yield* continuationPending(id))) retained.push(id);
                  }
                  if (retained.length === 0) continue;
                  if (retained.length !== entry.runIds.length)
                    entry = { ...entry, runIds: retained };
                }
                entries.push(entry);
              }
              return entries.length === current.entries.length &&
                entries.every((entry, i) => entry === current.entries[i])
                ? current
                : { ...current, entries };
            }),
          );
        },
      ),
      isVetoed: (runId) => Ref.get(state).pipe(Effect.map((current) => current.vetoed.has(runId))),
    });
  },
  (effect, filePath) =>
    effect.pipe(Effect.mapError((cause) => new UpdateRestartPolicyError({ cause, filePath }))),
);

export const layer = Layer.effect(
  UpdateRestartPolicy,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, "update-restart-policy.json"));
  }),
);
