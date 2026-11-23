import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  OrchestratorMcpRequestSecretInput,
  ProjectId,
  type OrchestrationV2ServerCommand,
  SecretProviderId,
  SecretProviderKind,
  SecretRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";
import * as SecretPipe from "./secretPipe.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");
const decodeSecretInput = Schema.decodeUnknownEffect(OrchestratorMcpRequestSecretInput);
const decodeSecretInputExit = Schema.decodeUnknownExit(OrchestratorMcpRequestSecretInput);

const FAKE_KIND = SecretProviderKind.make("fake");
const vault = SecretProviderId.make("vault");
/** Reads `fake://` references from `values` while unlocked, as a password manager would. */
const fakeVault = () => {
  const state = { unlocked: true, values: new Map([["fake://github/token", "ghp_from_vault"]]) };
  const driver = defineSecretProviderDriver({
    kind: FAKE_KIND,
    definition: defineSecretProvider({
      kind: FAKE_KIND,
      label: "Fake",
      configSchema: Schema.Struct({}),
      isReference: (reference) => reference.startsWith("fake://"),
      referencePlaceholder: "fake://item",
      invalidReferenceMessage: "Use fake://item.",
    }),
    read: (_config, references) =>
      Effect.sync(() =>
        references.map((reference) => (state.unlocked ? state.values.get(reference) : undefined)),
      ),
  });
  return {
    state,
    layer: SecretResolver.layer({
      drivers: [driver],
      secretProviders: Effect.succeed({ [vault]: { kind: FAKE_KIND, label: "Vault", config: {} } }),
    }).pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  };
};

const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly delivery?: "file" | "browser";
    readonly fields?: ReadonlyArray<{ readonly name: string; readonly label: string }>;
    readonly directory?: string;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
    readonly resolver?: Layer.Layer<SecretResolver.SecretResolver>;
    readonly afterCreate?: Effect.Effect<void>;
    /** Store entries that exist before the service starts. */
    readonly preStored?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>(
      Object.entries(options.preStored ?? {}).map(([name, value]) => [
        name,
        new TextEncoder().encode(value),
      ]),
    );
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      options.resolver ?? fakeVault().layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)).pipe(
                  Effect.andThen(options.afterCreate ?? Effect.void),
                ),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        // Reads yield like a real store, so two answers can both see a pending card.
        getThreadRecords: () =>
          Effect.yieldNow.pipe(
            Effect.as({
              thread: { projectId },
              runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
              turnItems: [
                {
                  id: turnItemId,
                  threadId: requestThreadId,
                  runId: "run-1",
                  nodeId: "node-root",
                  type: "secret_request",
                  label: "GitHub token",
                  reason: "Used as GH_TOKEN.",
                  url: "https://github.com/settings/tokens",
                  ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                  ...(options.fields === undefined ? {} : { fields: options.fields }),
                  secretStatus,
                },
              ],
            } as never),
          ),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

const singleFile = (saved: { readonly file: string } | { readonly files: unknown }) =>
  "file" in saved ? saved.file : assert.fail("expected a single file");

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
        url: "https://github.com/settings/tokens",
      });
      assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("a browser answer stays in memory, never in the store, and can be taken once", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "hunter2-password" },
        });
        assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "browser" });
        assert.notInclude(JSON.stringify(dispatched), "hunter2-password");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("hunter2-password")));
        assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));

        const taken = yield* service.takeBrowserValue({ threadId, turnItemId });
        assert.equal(Redacted.value(Option.getOrThrow(taken)), "hunter2-password");
        assert.notInclude(String(Option.getOrThrow(taken)), "hunter2-password");
        assert.isTrue(Option.isNone(yield* service.takeBrowserValue({ threadId, turnItemId })));
      }),
    { delivery: "browser" },
  ),
);

it.effect("a browser value no fill took within a minute is gone", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "hunter2-password" },
        });
        yield* TestClock.adjust(SecretRequests.BROWSER_VALUE_TTL_MS + 1);
        assert.isTrue(Option.isNone(yield* service.takeBrowserValue({ threadId, turnItemId })));
      }),
    { delivery: "browser" },
  ),
);

it.effect("a browser answer to a card that closed first is dropped", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "hunter2-password" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isTrue(Option.isNone(yield* service.takeBrowserValue({ threadId, turnItemId })));
      }),
    { delivery: "browser", closedFirst: true },
  ),
);

it.effect("a secret provider reference is read once and saved like a typed value", () =>
  withService(({ service, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: {
          type: "reference",
          reference: { provider: vault, reference: "fake://github/token" },
        },
      });
      assert.include(dispatched[0] as object, { secretStatus: "saved" });
      assert.notInclude(JSON.stringify(dispatched), "fake://");
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_from_vault");
    }),
  ),
);

it.effect(
  "an unreadable reference leaves the request pending, and a retry after unlocking works",
  () => {
    const { state, layer } = fakeVault();
    state.unlocked = false;
    return withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const reference = { provider: vault, reference: "fake://github/token" };
          const locked = yield* service
            .answer({ threadId, turnItemId, answer: { type: "reference", reference } })
            .pipe(Effect.flip);
          assert.equal(locked.reason, "reference_unreadable");
          assert.include(locked.message, '"Vault"');
          assert.deepEqual(dispatched, []);
          assert.deepEqual(valuesOf(stored), []);

          state.unlocked = true;
          yield* service.answer({ threadId, turnItemId, answer: { type: "reference", reference } });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consume({ ref, projectId }), "ghp_from_vault");
        }),
      { resolver: layer },
    );
  },
);

it.effect("a reference to a secret provider that is not configured fails", () =>
  withService(({ service, dispatched }) =>
    Effect.gen(function* () {
      const error = yield* service
        .answer({
          threadId,
          turnItemId,
          answer: {
            type: "reference",
            reference: {
              // Also an Object.prototype key, which must not pass for a configured provider.
              provider: SecretProviderId.make("constructor"),
              reference: "fake://github/token",
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "reference_unreadable");
      assert.include(error.message, '"constructor"');
      assert.deepEqual(dispatched, []);
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.forEach(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })],
        Effect.result,
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("nothing a user types is ever written to the secret store", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.deepEqual(valuesOf(stored), []);
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("a ref left unused for a day is gone", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      yield* TestClock.adjust(24 * 60 * 60 * 1000 + 1);
      const expired = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(["ref_expired", "ref_unavailable"], expired.reason);
    }),
  ),
);

it.effect("a file request streams its value once through an owner-only pipe", () =>
  Effect.gen(function* () {
    if (!SecretPipe.pipesSupportedOn(yield* HostProcess.Platform)) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          const file = singleFile(yield* service.saveToFile({ threadId, turnItemId }));
          const stat = yield* fs.stat(file);
          assert.equal(stat.type, "FIFO");
          assert.equal(stat.mode & 0o777, 0o600);
          assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          // A retried request_secret gets the same pipe while it still waits.
          assert.equal(yield* service.saveToFile({ threadId, turnItemId }), file);
          assert.equal(yield* fs.readFileString(file), "cf_token'$(id)");
          // The pipe is removed before the read completes.
          assert.isFalse(yield* fs.exists(file));
          assert.deepEqual(valuesOf(stored), []);
          // Read once: neither the pipe nor a ref hands it out again.
          const again = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(again.reason, "ref_unavailable");
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never served to a command", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(Option.isSome(yield* service.savedRef({ threadId, turnItemId })));
    }),
  ),
);

it.effect("a pasted secret streams once through a pipe, with no card", () =>
  Effect.gen(function* () {
    if (!SecretPipe.pipesSupportedOn(yield* HostProcess.Platform)) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const pasted = "  4829'$(id) 16\t";
    yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const paste = (requestNamespace: string, requestKey: string, value: string) =>
            service.savePasted({ threadId, requestNamespace, requestKey, value });
          const file = yield* paste("session-a", "key-1", pasted);
          assert.equal(path.dirname(file), path.join(directory, "files"));
          assert.match(path.basename(file), /^[0-9a-f]{32}$/);
          assert.equal((yield* fs.stat(file)).type, "FIFO");
          // A retry with the same key gets the same pipe, still serving the first value.
          assert.equal(yield* paste("session-a", "key-1", "other"), file);
          // Another key, or the same key from another provider session, gets its own pipe.
          const other = yield* paste("session-a", "key-2", "x");
          const otherSession = yield* paste("session-b", "key-1", "y");
          assert.notEqual(other, file);
          assert.notEqual(otherSession, file);
          assert.equal(yield* fs.readFileString(file), pasted);
          assert.equal(yield* fs.readFileString(other), "x");
          assert.equal(yield* fs.readFileString(otherSession), "y");
          assert.isFalse(yield* fs.exists(file));
          // No card and nothing stored: the thread never hears of it.
          assert.deepEqual(dispatched, []);
          assert.deepEqual(valuesOf(stored), []);
        }).pipe(Effect.withTracer(tracer)),
      { directory },
    );
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.savePasted");
    assert.isFalse(recorded.some((value) => value.includes("4829")));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pasted secret keeps its exact bytes in the tool input", () =>
  Effect.gen(function* () {
    const pasted = "  pa ss\tword\t ";
    const input = yield* decodeSecretInput({
      label: "Staging password",
      reason: "Signs in the QA account.",
      value: pasted,
    });
    assert.equal(input.value, pasted);
    const empty = decodeSecretInputExit({
      label: "Staging password",
      reason: "Signs in the QA account.",
      value: "",
    });
    assert.isTrue(Exit.isFailure(empty));
    for (const url of ["https://?state=x", "javascript:alert(1)"]) {
      assert.isTrue(
        Exit.isFailure(decodeSecretInputExit({ label: "Code", reason: "Sign in.", url })),
        url,
      );
    }
  }),
);

it.effect("a pasted secret is refused without a secrets directory", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failed = yield* service
        .savePasted({ threadId, requestNamespace: "session-a", requestKey: "key-1", value: "4829" })
        .pipe(Effect.flip);
      const supported = SecretPipe.pipesSupportedOn(yield* HostProcess.Platform);
      assert.equal(failed.reason, supported ? "store_failed" : "file_unsupported");
    }),
  ),
);

it.effect("plaintext values older versions left on disk are removed at startup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const legacy = `secret-request-${"a".repeat(32)}`;
    yield* fs.writeFileString(path.join(directory, `${legacy}.bin`), "{}");
    yield* fs.makeDirectory(path.join(directory, "files"));
    yield* fs.writeFileString(path.join(directory, "files", "b".repeat(32)), "old_token");
    yield* withService(
      ({ stored }) =>
        Effect.sync(() => {
          assert.isFalse(stored.has(legacy));
          assert.isTrue(stored.has("secret-request-salt"));
        }),
      { directory, preStored: { [legacy]: '{"value":"old_token"}' } },
    );
    assert.deepEqual(yield* fs.readDirectory(path.join(directory, "files")), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
