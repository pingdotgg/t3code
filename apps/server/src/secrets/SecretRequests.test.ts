import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";
import {
  OrchestratorMcpRequestSecretInput,
  ProjectId,
  type OrchestrationV2ServerCommand,
  SecretProviderId,
  SecretProviderKind,
  SecretRef,
  ThreadId,
  TurnItemId,
  type VaultServiceRead,
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
import * as Redacted from "effect/Redacted";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";
import { GmailApiError, listRecentGmail } from "./GmailApi.ts";
import { setVaultPin } from "./VaultAccess.ts";
const PIN = "8472951";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");
const decodeSecretInput = Schema.decodeUnknownEffect(OrchestratorMcpRequestSecretInput);
const decodeSecretInputExit = Schema.decodeUnknownExit(OrchestratorMcpRequestSecretInput);

vi.mock(import("./GmailApi.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  // No transport or real account is used, even if a denial unexpectedly reaches the reader.
  listRecentGmail: vi.fn(() => Effect.succeed([])),
}));
const mailOp = { folder: "spam", limit: 3 } as const;
const fixtureGrant = {
  account: "work@example.invalid",
  clientId: "12345-work.apps.googleusercontent.com",
  refreshToken: "dummy-refresh-grant",
};
const fixtureClient = {
  clientId: fixtureGrant.clientId,
  clientSecret: "fixture-entry-secret",
  revision: "fixture-work-revision",
  redirectUri: "https://vault.example.test/oauth/gmail/callback",
};
const mailRecord = {
  version: 1,
  kind: "gmail",
  title: "Work mail",
  gmailClient: fixtureClient,
  gmailGrant: fixtureGrant,
  gmailGrantRevision: fixtureClient.revision,
};
const privateAnswer = () =>
  ({
    type: "vault_gmail_display",
    name: "work",
    account: fixtureGrant.account,
    pin: Redacted.make(PIN),
  }) as const;
const mailAnswer = { type: "vault", name: "work", fields: {} } as const;

const serviceOp = { service: "github", limit: 2 } as const;
const connection = {
  service: "github",
  account: "synthetic-owner",
  token: "fixture-only-token",
  revision: "a".repeat(32),
} as const;
const serviceRecord = {
  version: 1,
  kind: "service",
  title: "Engineering team",
  serviceConnection: connection,
};
const serviceAnswer = () =>
  ({
    type: "vault_service_display",
    name: "team",
    account: connection.account,
    pin: Redacted.make(PIN),
  }) as const;

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
    readonly delivery?: "file";
    readonly fields?: ReadonlyArray<{ readonly name: string; readonly label: string }>;
    readonly directory?: string;
    readonly runStatus?: string;
    readonly rootNodeId?: string;
    readonly nodeStatus?: string;
    readonly gmail?: boolean;
    readonly serviceRead?: VaultServiceRead;
    readonly legacyServiceCard?: boolean;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
    readonly resolver?: Layer.Layer<SecretResolver.SecretResolver>;
    readonly afterCreate?: Effect.Effect<void>;
    readonly afterRecord?: Effect.Effect<void>;
    readonly encryptedVault?: boolean;
    readonly tagged?: boolean;
    readonly vaultOperation?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
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
          ...(options.encryptedVault ? { storageMode: "linux-keyring-aes256gcm" as const } : {}),
          get: (name) =>
            Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)?.slice()))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value.slice())),
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
              : Effect.sync(() => void stored.set(name, value.slice())).pipe(
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
              thread: { id: requestThreadId, projectId },
              runs: [
                {
                  id: "run-1",
                  rootNodeId: options.rootNodeId ?? "node-root",
                  status: options.runStatus ?? "running",
                },
              ],
              nodes: [
                {
                  id: "node-root",
                  threadId: requestThreadId,
                  runId: "run-1",
                  status: options.nodeStatus ?? "running",
                },
              ],
              turnItems: [
                {
                  id: options.vaultOperation
                    ? TurnItemId.make("turn-item:vault-access:retired")
                    : turnItemId,
                  threadId: requestThreadId,
                  runId: "run-1",
                  nodeId: "node-root",
                  type: "secret_request",
                  label: options.gmail
                    ? mailRecord.title
                    : options.serviceRead
                      ? serviceRecord.title
                      : "GitHub token",
                  ...(options.gmail ? { taggedVault: { name: "work", gmail: mailOp } } : {}),
                  ...(options.serviceRead
                    ? {
                        taggedVault: {
                          name: "team",
                          serviceRead: options.serviceRead,
                          ...(options.legacyServiceCard ? {} : { revision: connection.revision }),
                        },
                      }
                    : {}),
                  ...(options.tagged ? { taggedVault: { name: "github", field: "token" } } : {}),
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
          }).pipe(Effect.tap(() => options.afterRecord ?? Effect.void));
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      if (options.encryptedVault)
        yield* setVaultPin(
          yield* ServerSecretStore.ServerSecretStore,
          Redacted.make(PIN),
          undefined,
          true,
        );
      if (options.gmail)
        stored.set("vault-entry-work", new TextEncoder().encode(JSON.stringify(mailRecord)));
      if (options.serviceRead)
        stored.set(
          "vault-entry-team",
          new TextEncoder().encode(
            JSON.stringify({
              ...serviceRecord,
              serviceConnection: { ...connection, service: options.serviceRead.service },
            }),
          ),
        );
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provideMerge(layerDependencies))));
  });

it.effect("a retired vault operation card cannot be answered with credentials", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const before = new Map(stored);
        for (const answer of [
          { type: "save", secret: "dummy-secret" },
          { type: "reference", reference: { provider: vault, reference: "fake://github/token" } },
          { type: "vault", name: "github", fields: { value: "token" } },
        ] as const) {
          const error = yield* service
            .answer({
              threadId,
              turnItemId: TurnItemId.make("turn-item:vault-access:retired"),
              answer,
            })
            .pipe(Effect.flip);
          assert.equal(error.reason, "operation_request");
        }
        assert.deepStrictEqual(stored, before);
        assert.lengthOf(dispatched, 0);
      }),
    { vaultOperation: true },
  ),
);

it.effect("a tagged title resolves to one saved entry, never the first of two matches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* withService(
      ({ stored, service }) =>
        Effect.gen(function* () {
          const bytes = new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              kind: "note",
              title: "Signing key",
              note: "private-fixture",
            }),
          );
          for (const name of ["work", "personal"]) {
            stored.set(`vault-entry-${name}`, bytes);
            yield* fs.writeFile(`${directory}/vault-entry-${name}.bin`, new Uint8Array());
            if (name === "work") {
              assert.deepEqual(yield* service.resolveTaggedEntry("Signing key"), {
                name: "work",
                field: "note",
              });
            }
          }
          assert.equal(
            (yield* service.resolveTaggedEntry("Signing key").pipe(Effect.flip)).reason,
            "vault_tag_unavailable",
          );
        }),
      { directory, encryptedVault: true },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a tagged request rejects alternate answers and delivers only the PIN-approved reference",
  () =>
    withService(
      ({ service, stored }) =>
        Effect.gen(function* () {
          stored.set(
            "vault-entry-github",
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                kind: "token",
                title: "GitHub token",
                token: "private-fixture",
              }),
            ),
          );
          for (const answer of [
            { type: "save", secret: "unrelated" },
            { type: "reference", reference: { provider: vault, reference: "fake://github/token" } },
            { type: "vault", name: "other", fields: { value: "token" } },
            { type: "vault", name: "github", fields: { value: "note" } },
          ] as const) {
            assert.equal(
              (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
              "vault_access_denied",
            );
          }
          const answer = { type: "vault", name: "github", fields: { value: "token" } } as const;
          assert.equal(
            (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
            "vault_pin_required",
          );
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { ...answer, pin: Redacted.make(PIN) },
          });
          assert.equal(
            (yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip)).reason,
            "not_a_file_request",
          );
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consume({ projectId, ref }), "private-fixture");
        }),
      { encryptedVault: true, tagged: true },
    ),
);

it.effect(
  "only an unambiguous configured tag can open a Gmail card, including first-use connection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* withService(
        ({ service, stored, dispatched }) =>
          Effect.gen(function* () {
            yield* fs.writeFile(`${directory}/vault-entry-work.bin`, new Uint8Array());
            assert.lengthOf(dispatched, 0);
            assert.deepEqual(yield* service.resolveGmailEntry("Work mail", mailOp), {
              name: "work",
              gmail: mailOp,
            });
            assert.equal(
              (yield* service.resolveTaggedEntry("Work mail").pipe(Effect.flip)).reason,
              "vault_tag_unavailable",
            );
            for (const limit of [0, 1.5, 21]) {
              assert.equal(
                (yield* service
                  .resolveGmailEntry("Work mail", { ...mailOp, limit })
                  .pipe(Effect.flip)).reason,
                "vault_tag_unavailable",
              );
            }
            stored.set(
              "vault-entry-other",
              new TextEncoder().encode(
                JSON.stringify({
                  version: 1,
                  kind: "token",
                  title: "Not linked",
                  token: "test-only",
                }),
              ),
            );
            yield* fs.writeFile(`${directory}/vault-entry-other.bin`, new Uint8Array());
            assert.deepEqual(yield* service.resolveGmailEntry("Not linked", mailOp), {
              name: "other",
              gmail: mailOp,
              needsGmailConnection: true,
            });
            // Previously saved global-client grants cannot open a PIN card for a connected mailbox.
            stored.set(
              "vault-entry-other",
              new TextEncoder().encode(
                JSON.stringify({
                  version: 1,
                  kind: "gmail",
                  title: "Legacy",
                  gmailGrant: fixtureGrant,
                }),
              ),
            );
            assert.deepEqual(yield* service.resolveGmailEntry("Legacy", mailOp), {
              name: "other",
              gmail: mailOp,
              needsGmailConnection: true,
            });
            stored.set("vault-entry-other", stored.get("vault-entry-work")!);
            assert.equal(
              (yield* service.resolveGmailEntry("Work mail", mailOp).pipe(Effect.flip)).reason,
              "vault_tag_unavailable",
            );
          }),
        { directory, gmail: true, encryptedVault: true },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "only an exact, one-use service approval reaches the stub transport; only its approving RPC sees items",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFile(`${directory}/vault-entry-team.bin`, new Uint8Array());
      const recorded = yield* Deferred.make<void>();
      const label = "synthetic-owner/private-project";
      let requests = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests++;
        if (
          request.url !== "https://api.github.com/user/repos?per_page=2" ||
          request.method !== "GET" ||
          request.headers.get("authorization") !== `Bearer ${connection.token}`
        )
          throw new Error("Unexpected synthetic request");
        return Response.json([{ full_name: label }]);
      };
      yield* withService(
        ({ service, stored, dispatched }) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* service.resolveServiceEntry("Engineering", serviceOp).pipe(Effect.flip))
                .reason,
              "vault_tag_unavailable",
            );
            assert.deepEqual(yield* service.resolveServiceEntry(serviceRecord.title, serviceOp), {
              name: "team",
              serviceRead: serviceOp,
              revision: connection.revision,
            });
            assert.equal(
              (yield* service.resolveTaggedEntry(serviceRecord.title).pipe(Effect.flip)).reason,
              "vault_tag_unavailable",
            );
            assert.equal(
              (yield* service.resolveGmailEntry(serviceRecord.title, mailOp).pipe(Effect.flip))
                .reason,
              "vault_tag_unavailable",
            );
            assert.equal(
              (yield* service
                .resolveServiceEntry(serviceRecord.title, { ...serviceOp, service: "slack" })
                .pipe(Effect.flip)).reason,
              "vault_service_not_connected",
            );
            for (const limit of [0, 1.5, 21])
              assert.equal(
                (yield* service
                  .resolveServiceEntry(serviceRecord.title, { ...serviceOp, limit })
                  .pipe(Effect.flip)).reason,
                "vault_tag_unavailable",
              );
            const answering = yield* service
              .answer({ threadId, turnItemId, answer: serviceAnswer() })
              .pipe(Effect.forkChild);
            yield* Deferred.await(recorded);
            const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
            assert.isTrue(Exit.isFailure(yield* Effect.exit(service.consume({ ref, projectId }))));
            assert.isTrue(
              Exit.isFailure(yield* Effect.exit(service.saveToFile({ threadId, turnItemId }))),
            );
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(
                  service.consumeGmail({ ref, threadId, operation: mailOp }, Effect.succeed(true)),
                ),
              ),
            );
            for (const input of [
              { ref, threadId: ThreadId.make("wrong-thread"), operation: serviceOp },
              { ref, threadId, operation: { ...serviceOp, service: "gitlab" } },
              { ref, threadId, operation: { ...serviceOp, service: "netlify" } },
              { ref, threadId, operation: { ...serviceOp, limit: 1 } },
            ] as const)
              assert.isTrue(
                Exit.isFailure(
                  yield* Effect.exit(service.consumeService(input, Effect.succeed(true))),
                ),
              );
            assert.equal(requests, 0);
            const spend = service.consumeService(
              { ref, threadId, operation: serviceOp },
              Effect.succeed(true),
            );
            const receipt = yield* spend;
            assert.deepEqual(receipt, { status: "displayed", count: 1 });
            assert.deepEqual(yield* Fiber.join(answering), { items: [{ label }] });
            assert.isTrue(Exit.isFailure(yield* Effect.exit(spend)));
            assert.equal(requests, 1);
            assert.isFalse(stored.has(`secret-request-${ref.slice("secret-ref:".length)}`));
            for (const sensitive of [PIN, ref, label, connection.account, connection.token]) {
              assert.notInclude(JSON.stringify(dispatched), sensitive);
              assert.notInclude(JSON.stringify(receipt), sensitive);
            }
          }),
        {
          encryptedVault: true,
          directory,
          serviceRead: serviceOp,
          afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "service cards refuse alternate answers, wrong accounts and wrong PINs; declining spends nothing",
  () =>
    withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          for (const answer of [
            { type: "save", secret: "fixture" },
            { type: "reference", reference: { provider: vault, reference: "fake://github/token" } },
            {
              type: "vault",
              name: "team",
              fields: { value: "token" },
              pin: Redacted.make(PIN),
              discloseToCommands: true,
            },
            { ...serviceAnswer(), type: "vault_gmail_display" },
            { ...serviceAnswer(), name: "other" },
          ] as const)
            assert.equal(
              (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
              "vault_access_denied",
            );
          assert.equal(
            (yield* service
              .answer({ threadId, turnItemId, answer: { ...serviceAnswer(), account: "other" } })
              .pipe(Effect.flip)).reason,
            "vault_service_approval",
          );
          assert.equal(
            (yield* service
              .answer({
                threadId,
                turnItemId,
                answer: { ...serviceAnswer(), pin: Redacted.make("0000000") },
              })
              .pipe(Effect.flip)).reason,
            "vault_pin_invalid",
          );
          assert.lengthOf(dispatched, 0);
          yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
          assert.equal(
            (yield* service
              .answer({ threadId, turnItemId, answer: serviceAnswer() })
              .pipe(Effect.flip)).reason,
            "already_answered",
          );
        }),
      { encryptedVault: true, serviceRead: { service: "linear", limit: 2 } },
    ),
);

it.effect.each(["rotated", "legacy"] as const)(
  "refuses a correct PIN for a %s service card before issuing an approval",
  (scenario) =>
    withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          if (scenario === "rotated") {
            stored.set(
              "vault-entry-team",
              new TextEncoder().encode(
                JSON.stringify({
                  ...serviceRecord,
                  serviceConnection: {
                    ...connection,
                    revision: "b".repeat(32),
                    token: "replacement-token",
                  },
                }),
              ),
            );
          }
          const error = yield* service
            .answer({ threadId, turnItemId, answer: serviceAnswer() })
            .pipe(Effect.flip);
          assert.equal(error.reason, "vault_service_approval");
          assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
          assert.lengthOf(dispatched, 0);
        }),
      {
        encryptedVault: true,
        serviceRead: serviceOp,
        legacyServiceCard: scenario === "legacy",
        afterRecord: Effect.die(new Error("A stale service card must not be approved")),
      },
    ),
);

it.effect("cancelling or replacing a connection after approval never opens its transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const operation = { service: "asana", limit: 3 } as const;
    for (const change of [
      "account",
      "service",
      "revision",
      "cancel",
      "session",
      "timeout",
    ] as const) {
      const recorded = yield* Deferred.make<void>();
      yield* withService(
        ({ service, stored }) =>
          Effect.gen(function* () {
            const answering = yield* service
              .answer({ threadId, turnItemId, answer: serviceAnswer() })
              .pipe(Effect.forkChild);
            yield* Deferred.await(recorded);
            const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
            if (change === "cancel") yield* service.cancelPrivateDisplay(threadId, turnItemId);
            else if (change === "timeout") yield* TestClock.adjust("1 minute");
            else if (change !== "session")
              stored.set(
                "vault-entry-team",
                new TextEncoder().encode(
                  JSON.stringify({
                    ...serviceRecord,
                    serviceConnection: {
                      ...connection,
                      service: operation.service,
                      [change]:
                        change === "service"
                          ? "gitlab"
                          : change === "revision"
                            ? "b".repeat(32)
                            : "replacement",
                    },
                  }),
                ),
              );
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(
                  service.consumeService(
                    { ref, threadId, operation },
                    Effect.succeed(change !== "session"),
                  ),
                ),
              ),
            );
            assert.isTrue(Exit.isFailure(yield* Fiber.await(answering)));
            assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
          }),
        {
          encryptedVault: true,
          serviceRead: operation,
          afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
        },
      ).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async () => {
          requests++;
          throw new Error("Denied read attempted");
        }),
      );
    }
    assert.equal(requests, 0);
  }),
);

it.effect("a Gmail card accepts only its named account, an empty field map, and a fresh PIN", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const reader = vi.mocked(listRecentGmail).mockClear();
        for (const answer of [
          { type: "save", secret: "unrelated" },
          { type: "reference", reference: { provider: vault, reference: "fake://github/token" } },
          { ...mailAnswer, name: "another" },
          {
            type: "vault_gmail_display",
            name: "another",
            account: fixtureGrant.account,
            pin: Redacted.make(PIN),
          },
          { ...mailAnswer, fields: { value: "password" } },
          { ...mailAnswer, pin: Redacted.make(PIN) },
          { ...mailAnswer, discloseToCommands: true },
        ] as const) {
          assert.equal(
            (yield* service.answer({ threadId, turnItemId, answer }).pipe(Effect.flip)).reason,
            "vault_access_denied",
          );
        }
        assert.equal(
          (yield* service.answer({ threadId, turnItemId, answer: mailAnswer }).pipe(Effect.flip))
            .reason,
          "vault_access_denied",
        );
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "vault_gmail_display",
                name: "work",
                account: fixtureGrant.account,
                pin: Redacted.make("1111111"),
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_pin_invalid",
        );
        assert.lengthOf(dispatched, 0);
        yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
        assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "vault_gmail_display",
                name: "work",
                account: fixtureGrant.account,
                pin: Redacted.make(PIN),
              },
            })
            .pipe(Effect.flip)).reason,
          "already_answered",
        );
        assert.lengthOf(reader.mock.calls, 0);
      }),
    { gmail: true, encryptedVault: true },
  ),
);

it.effect("a Gmail approval is not a credential and only its exact operation spends it once", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<void>();
    yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const reader = vi.mocked(listRecentGmail).mockClear();
          const answering = yield* service
            .answer({
              threadId,
              turnItemId,
              answer: privateAnswer(),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(recorded);
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const persisted = Array.from(stored, ([name, bytes]) =>
            name.startsWith("secret-request-") ? new TextDecoder().decode(bytes) : "",
          ).join("");
          assert.notInclude(persisted, fixtureGrant.refreshToken);
          assert.notInclude(persisted, fixtureClient.clientSecret);
          for (const sensitive of [
            PIN,
            fixtureGrant.refreshToken,
            fixtureClient.clientSecret,
            ref,
          ]) {
            assert.notInclude(JSON.stringify(dispatched), sensitive);
          }
          assert.equal(
            (yield* service.consume({ ref, projectId }).pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
          assert.equal(
            (yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip)).reason,
            "not_a_file_request",
          );
          for (const input of [
            { threadId: ThreadId.make("other-thread"), operation: mailOp },
            { threadId, operation: { ...mailOp, folder: "inbox" } },
            { threadId, operation: { ...mailOp, limit: 4 } },
          ] as const) {
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(service.consumeGmail({ ref, ...input }, Effect.succeed(true))),
              ),
            );
          }
          assert.lengthOf(reader.mock.calls, 0);
          const use = service.consumeGmail(
            { threadId, ref, operation: mailOp },
            Effect.succeed(true),
          );
          const outcomes = yield* Effect.all([Effect.exit(use), Effect.exit(use)], {
            concurrency: 2,
          });
          assert.lengthOf(outcomes.filter(Exit.isSuccess), 1);
          assert.deepEqual(reader.mock.calls, [[fixtureGrant, mailOp, fixtureClient]]);
          assert.deepEqual(yield* Fiber.join(answering), { messages: [] });
        }),
      {
        gmail: true,
        encryptedVault: true,
        afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
      },
    );
  }),
);

it.effect(
  "Gmail spending checks the live card, current root, current grant, epoch and deadline",
  () =>
    Effect.gen(function* () {
      const reader = vi.mocked(listRecentGmail).mockClear();
      for (const change of [
        "run",
        "root",
        "node",
        "account",
        "registration",
        "disconnect",
        "epoch",
        "time",
        "session",
      ] as const) {
        const recorded = yield* Deferred.make<void>();
        const options = {
          gmail: true,
          encryptedVault: true,
          runStatus: "running",
          rootNodeId: "node-root",
          nodeStatus: "running",
          afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
        };
        yield* withService(
          ({ service, stored }) =>
            Effect.gen(function* () {
              const answering = yield* service
                .answer({
                  threadId,
                  turnItemId,
                  answer: privateAnswer(),
                })
                .pipe(Effect.forkChild);
              yield* Deferred.await(recorded);
              const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
              if (change === "run") options.runStatus = "completed";
              if (change === "root") options.rootNodeId = "steered-root";
              if (change === "node") options.nodeStatus = "interrupted";
              if (change === "disconnect") stored.delete("vault-entry-work");
              if (change === "account") {
                stored.set(
                  "vault-entry-work",
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...mailRecord,
                      gmailGrant: { ...fixtureGrant, account: "another@example.invalid" },
                    }),
                  ),
                );
              }
              if (change === "registration")
                stored.set(
                  "vault-entry-work",
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...mailRecord,
                      gmailClient: { ...fixtureClient, revision: "rotated" },
                      gmailGrantRevision: "rotated",
                    }),
                  ),
                );
              if (change === "epoch") {
                const key = "vault-access-policy-v1";
                const policy = JSON.parse(new TextDecoder().decode(stored.get(key)!));
                stored.set(
                  key,
                  new TextEncoder().encode(JSON.stringify({ ...policy, epoch: "revoked" })),
                );
              }
              if (change === "time") yield* TestClock.adjust("1 minute");
              assert.isTrue(
                Exit.isFailure(
                  yield* Effect.exit(
                    service.consumeGmail(
                      {
                        threadId,
                        ref,
                        operation: mailOp,
                      },
                      Effect.succeed(change !== "session"),
                    ),
                  ),
                ),
              );
              assert.isTrue(Exit.isFailure(yield* Fiber.await(answering)));
            }),
          options,
        );
      }
      assert.lengthOf(reader.mock.calls, 0);
    }),
);

it.effect(
  "losing the private reply, changing its grant, or a failed network read cannot report displayed",
  () =>
    Effect.gen(function* () {
      const reader = vi.mocked(listRecentGmail);
      for (const change of ["cancel", "account", "network", "session"] as const) {
        reader.mockClear();
        const recorded = yield* Deferred.make<void>();
        yield* withService(
          ({ service, stored }) =>
            Effect.gen(function* () {
              const request = {
                threadId,
                turnItemId,
                answer: {
                  type: "vault_gmail_display",
                  name: "work",
                  account: fixtureGrant.account,
                  pin: Redacted.make(PIN),
                },
              } as const;
              const answering = yield* service.answer(request).pipe(Effect.forkChild);
              yield* Deferred.await(recorded);
              const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
              if (change === "cancel") yield* Fiber.interrupt(answering);
              if (change === "account")
                stored.set(
                  "vault-entry-work",
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...mailRecord,
                      gmailGrant: { ...fixtureGrant, account: "different@example.test" },
                    }),
                  ),
                );
              if (change === "network")
                reader.mockReturnValueOnce(Effect.fail(new GmailApiError({ code: "unavailable" })));
              const use = service.consumeGmail(
                { threadId, ref, operation: mailOp },
                Effect.succeed(change !== "session"),
              );
              assert.isTrue(Exit.isFailure(yield* Effect.exit(use)));
              if (change !== "cancel") assert.isTrue(Exit.isFailure(yield* Fiber.await(answering)));
              assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
              assert.lengthOf(reader.mock.calls, change === "network" ? 1 : 0);
            }),
          {
            gmail: true,
            encryptedVault: true,
            afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
          },
        );
      }
    }),
);

it.effect("abandoning an in-flight private read interrupts the only reader without a receipt", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const reader = vi.mocked(listRecentGmail).mockClear();
    reader.mockReturnValueOnce(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    );
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const answering = yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "vault_gmail_display",
                name: "work",
                account: fixtureGrant.account,
                pin: Redacted.make(PIN),
              },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(recorded);
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const spend = service.consumeGmail(
            { threadId, ref, operation: mailOp },
            Effect.succeed(true),
          );
          const consuming = yield* spend.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(spend)));
          yield* Fiber.interrupt(answering);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(consuming)));
          assert.isTrue(yield* Deferred.isDone(stopped));
          assert.lengthOf(reader.mock.calls, 1);
        }),
      {
        gmail: true,
        encryptedVault: true,
        afterRecord: Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
      },
    );
  }),
);

it.effect("a generic saved answer cannot authorize a Gmail read", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const reader = vi.mocked(listRecentGmail).mockClear();
      yield* service.answer({ threadId, turnItemId, answer: { type: "save", secret: "dummy" } });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            service.consumeGmail(
              {
                threadId,
                ref,
                operation: mailOp,
              },
              Effect.succeed(true),
            ),
          ),
        ),
      );
      assert.lengthOf(reader.mock.calls, 0);
      assert.equal(yield* service.consume({ projectId, ref }), "dummy");
    }),
  ),
);

it.effect(
  "a vault approval supplies a one-use secret without putting its value in the transcript",
  () =>
    withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          stored.set(
            "vault-entry-github",
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                kind: "token",
                title: "Work token",
                token: "dummy-vault-approved-token",
              }),
            ),
          );
          yield* service.answer({
            threadId,
            turnItemId,
            answer: {
              type: "vault",
              name: "github",
              fields: { value: "token" },
              pin: Redacted.make(PIN),
            },
          });
          assert.notInclude(JSON.stringify(dispatched), "dummy-vault-approved-token");
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consume({ ref, projectId }), "dummy-vault-approved-token");
          assert.equal(
            (yield* service.consume({ ref, projectId }).pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
          assert.isTrue(stored.has("vault-entry-github"));
        }),
      { encryptedVault: true },
    ),
);
it.effect("vault login approvals enforce website binding and exact field mapping", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const login = {
          version: 1,
          kind: "login",
          title: "Login",
          origin: "https://evil.test",
          username: "dummy-vault-email",
          password: "dummy-vault-password",
        };
        stored.set("vault-entry-login", new TextEncoder().encode(JSON.stringify(login)));
        const answer = {
          threadId,
          turnItemId,
          answer: {
            type: "vault" as const,
            name: "login",
            fields: { email: "username" as const, password: "password" as const },
          },
        };
        assert.equal(
          (yield* service
            .answer({ ...answer, answer: { ...answer.answer, pin: Redacted.make(PIN) } })
            .pipe(Effect.flip)).reason,
          "vault_origin_mismatch",
        );
        assert.deepStrictEqual(dispatched, []);
        stored.set(
          "vault-entry-login",
          new TextEncoder().encode(JSON.stringify({ ...login, origin: "https://github.com" })),
        );
        assert.equal(
          (yield* service
            .answer({
              ...answer,
              answer: { ...answer.answer, fields: { email: "username" }, pin: Redacted.make(PIN) },
            })
            .pipe(Effect.flip)).reason,
          "fields_mismatch",
        );
        yield* service.answer({ ...answer, answer: { ...answer.answer, pin: Redacted.make(PIN) } });
        assert.notInclude(JSON.stringify(dispatched), "dummy-vault-email");
        assert.notInclude(JSON.stringify(dispatched), "dummy-vault-password");
        assert.lengthOf(
          [...stored.keys()].filter(
            (key) => key.startsWith("secret-request-") && key !== "secret-request-salt",
          ),
          2,
        );
      }),
    {
      encryptedVault: true,
      fields: [
        { name: "email", label: "Email" },
        { name: "password", label: "Password" },
      ],
    },
  ),
);
it.effect("a login ref remains origin-bound when a protected tool consumes it", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        stored.set(
          "vault-entry-login",
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              kind: "login",
              title: "Login",
              origin: "https://github.com",
              username: "dummy-user",
              password: "dummy-login-secret",
            }),
          ),
        );
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "vault",
            name: "login",
            fields: { value: "password" },
            pin: Redacted.make(PIN),
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(
          (yield* service
            .consume({ ref, projectId, targetUrl: "https://evil.test" })
            .pipe(Effect.flip)).reason,
          "vault_origin_mismatch",
        );
        assert.equal(
          (yield* service.consume({ ref, projectId }).pipe(Effect.flip)).reason,
          "vault_origin_mismatch",
        );
        assert.equal(
          yield* service.consume({ ref, projectId, targetUrl: "https://github.com/login" }),
          "dummy-login-secret",
        );
      }),
    { encryptedVault: true },
  ),
);
it.effect("a login approved for command access can be delivered to an owner-only file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* withService(
      ({ service, stored }) =>
        Effect.gen(function* () {
          stored.set(
            "vault-entry-login",
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                kind: "login",
                title: "Login",
                origin: "https://github.com",
                username: "dummy-user",
                password: "dummy-login-secret",
              }),
            ),
          );
          yield* service.answer({
            threadId,
            turnItemId,
            answer: {
              type: "vault",
              name: "login",
              fields: { value: "password" },
              pin: Redacted.make(PIN),
              discloseToCommands: true,
            },
          });
          const delivered = yield* service.saveToFile({ threadId, turnItemId });
          if (!("file" in delivered)) return assert.fail("expected one file");
          assert.equal(yield* fs.readFileString(delivered.file), "dummy-login-secret");
          if ((yield* HostProcess.Platform) !== "win32")
            assert.equal((yield* fs.stat(delivered.file)).mode & 0o777, 0o600);
        }),
      { encryptedVault: true, delivery: "file", directory },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("an invalid credential request clears the submitted PIN handle", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const pin = Redacted.make(PIN);
        yield* service
          .answer({
            threadId,
            turnItemId: TurnItemId.make("missing"),
            answer: { type: "vault", name: "github", fields: { value: "token" }, pin },
          })
          .pipe(Effect.flip);
        assert.throws(() => Redacted.value(pin));
      }),
    { encryptedVault: true },
  ),
);
it.effect("missing PINs and raw references cannot bypass vault approval", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        stored.set("vault-entry-github", new TextEncoder().encode("dummy-token"));
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: { type: "vault", name: "github", fields: { value: "token" } },
            })
            .pipe(Effect.flip)).reason,
          "vault_pin_required",
        );
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "reference",
                reference: {
                  provider: SecretProviderId.make("hyakki-vault"),
                  reference: "hyakki-vault://github/token",
                },
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_use_picker",
        );
        assert.deepStrictEqual(dispatched, []);
      }),
    { encryptedVault: true },
  ),
);
it.effect("command disclosure requires both explicit consent and a fresh PIN", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        stored.set("vault-entry-github", new TextEncoder().encode("dummy-token"));
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "vault",
                name: "github",
                fields: { value: "token" },
                pin: Redacted.make(PIN),
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_disclosure_required",
        );
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "vault",
                name: "github",
                fields: { value: "token" },
                discloseToCommands: true,
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_pin_required",
        );
        assert.deepStrictEqual(dispatched, []);
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "vault",
            name: "github",
            fields: { value: "token" },
            pin: Redacted.make(PIN),
            discloseToCommands: true,
          },
        });
        assert.notInclude(JSON.stringify(dispatched), PIN);
        assert.notInclude(JSON.stringify(dispatched), "dummy-token");
      }),
    { encryptedVault: true, delivery: "file" },
  ),
);
it.effect("a changed vault policy invalidates an outstanding one-use approval", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        stored.set("vault-entry-github", new TextEncoder().encode("dummy-token"));
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "vault",
            name: "github",
            fields: { value: "token" },
            pin: Redacted.make(PIN),
          },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const policy = JSON.parse(new TextDecoder().decode(stored.get("vault-access-policy-v1")!));
        policy.epoch = "0".repeat(32);
        stored.set("vault-access-policy-v1", new TextEncoder().encode(JSON.stringify(policy)));
        assert.equal(
          (yield* service.consume({ ref, projectId }).pipe(Effect.flip)).reason,
          "vault_access_denied",
        );
      }),
    { encryptedVault: true },
  ),
);
it.effect("unencrypted stores cannot supply vault entries", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      stored.set("vault-entry-github", new TextEncoder().encode("dummy-token"));
      assert.equal(
        (yield* service
          .answer({
            threadId,
            turnItemId,
            answer: {
              type: "vault",
              name: "github",
              fields: { value: "token" },
              pin: Redacted.make(PIN),
            },
          })
          .pipe(Effect.flip)).reason,
        "vault_access_denied",
      );
    }),
  ),
);

const singleFile = (saved: { readonly file: string } | { readonly files: unknown }) =>
  "file" in saved ? saved.file : assert.fail("expected a single file");

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt" && name !== "vault-access-policy-v1")
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

it.effect("a secret provider reference is read once and saved like a typed value", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: {
            type: "reference",
            pin: Redacted.make(PIN),
            reference: { provider: vault, reference: "fake://github/token" },
          },
        });
        assert.include(dispatched[0] as object, { secretStatus: "saved" });
        assert.notInclude(JSON.stringify(dispatched), "fake://");
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_from_vault");
      }),
    { encryptedVault: true },
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
            .answer({
              threadId,
              turnItemId,
              answer: { type: "reference", reference, pin: Redacted.make(PIN) },
            })
            .pipe(Effect.flip);
          assert.equal(locked.reason, "reference_unreadable");
          assert.include(locked.message, '"Vault"');
          assert.deepEqual(dispatched, []);
          assert.deepEqual(valuesOf(stored), []);

          state.unlocked = true;
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "reference", reference, pin: Redacted.make(PIN) },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.equal(yield* service.consume({ ref, projectId }), "ghp_from_vault");
        }),
      { resolver: layer, encryptedVault: true },
    );
  },
);

it.effect("a reference to a secret provider that is not configured fails", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: {
              type: "reference",
              pin: Redacted.make(PIN),
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
    { encryptedVault: true },
  ),
);

it.effect("external provider references cannot bypass the PIN with an allow-mode rule", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const policy = JSON.parse(new TextDecoder().decode(stored.get("vault-access-policy-v1")!));
        policy.rules["external-reference"] = "allow";
        stored.set("vault-access-policy-v1", new TextEncoder().encode(JSON.stringify(policy)));
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "reference",
                reference: { provider: vault, reference: "fake://github/token" },
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_pin_required",
        );
        assert.deepStrictEqual(dispatched, []);
      }),
    { encryptedVault: true },
  ),
);
it.effect("external provider disclosure also requires explicit command consent", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* service
            .answer({
              threadId,
              turnItemId,
              answer: {
                type: "reference",
                reference: { provider: vault, reference: "fake://github/token" },
                pin: Redacted.make(PIN),
              },
            })
            .pipe(Effect.flip)).reason,
          "vault_disclosure_required",
        );
        assert.deepStrictEqual(dispatched, []);
      }),
    { encryptedVault: true, delivery: "file" },
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

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

it.effect("a file request moves its value to an owner-only file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          const file = singleFile(yield* service.saveToFile({ threadId, turnItemId }));
          assert.equal(yield* fs.readFileString(file), "cf_token'$(id)");
          assert.deepEqual(valuesOf(stored), []);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // A retried request_secret gets the same file; the value is never a ref again.
          assert.deepEqual(yield* service.saveToFile({ threadId, turnItemId }), { file });
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }),
      { delivery: "file", directory },
    );

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a fields request keeps each value apart and delivers one file per field", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const answer = (values: Record<string, string>) =>
            service.answer({ threadId, turnItemId, answer: { type: "save", values } });
          // An older client answers with one secret; a partial answer is just as wrong.
          for (const wrong of [
            service.answer({ threadId, turnItemId, answer: { type: "save", secret: "pw" } }),
            answer({ email: "qa@acme.dev" }),
            answer({ email: "qa@acme.dev", password: "pw", extra: "x" }),
          ]) {
            assert.equal((yield* wrong.pipe(Effect.flip)).reason, "fields_mismatch");
          }
          assert.deepEqual(valuesOf(stored), []);
          // A failed record removes every field's value, not just the first.
          const failed = yield* answer({ email: "qa@acme.dev", password: "pw" }).pipe(Effect.flip);
          assert.equal(failed.reason, "record_failed");
          assert.deepEqual(valuesOf(stored), []);

          yield* answer({ email: "qa@acme.dev", password: "hunter2" });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          assert.deepEqual((dispatched[0] as { fields?: unknown }).fields, [
            { name: "email", label: "Email" },
            { name: "password", label: "Password" },
          ]);
          assert.notInclude(JSON.stringify(dispatched), "hunter2");
          const saved = yield* service.saveToFile({ threadId, turnItemId });
          assert.isTrue("files" in saved);
          const files = "files" in saved ? saved.files : {};
          assert.deepEqual(Object.keys(files), ["email", "password"]);
          assert.equal(yield* fs.readFileString(files.email ?? ""), "qa@acme.dev");
          assert.equal(yield* fs.readFileString(files.password ?? ""), "hunter2");
          assert.deepEqual(valuesOf(stored), []);
        }),
      {
        delivery: "file",
        directory,
        failedRecords: 1,
        fields: [
          { name: "email", label: "Email" },
          { name: "password", label: "Password" },
        ],
      },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("two racing answers to a fields card never mix their values", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const answer = (who: string) =>
            service.answer({
              threadId,
              turnItemId,
              answer: { type: "save", values: { email: `${who}@acme.dev`, password: `${who}-pw` } },
            });
          const results = yield* Effect.forEach([answer("a"), answer("b")], Effect.result, {
            concurrency: "unbounded",
          });
          assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
          const saved = yield* service.saveToFile({ threadId, turnItemId });
          const files = "files" in saved ? saved.files : {};
          const email = yield* fs.readFileString(files.email ?? "");
          const password = yield* fs.readFileString(files.password ?? "");
          assert.equal(password, `${email.split("@")[0]}-pw`);
        }),
      {
        delivery: "file",
        directory,
        fields: [
          { name: "email", label: "Email" },
          { name: "password", label: "Password" },
        ],
      },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a fields answer interrupted between two values keeps neither", () =>
  Effect.gen(function* () {
    const firstStored = yield* Deferred.make<void>();
    yield* withService(
      ({ service, stored }) =>
        Effect.gen(function* () {
          const fiber = yield* service
            .answer({
              threadId,
              turnItemId,
              answer: { type: "save", values: { email: "a@acme.dev", password: "a-pw" } },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstStored);
          yield* Fiber.interrupt(fiber);
          assert.deepEqual(valuesOf(stored), []);
        }),
      {
        afterCreate: Deferred.succeed(firstStored, undefined).pipe(Effect.andThen(Effect.never)),
        fields: [
          { name: "email", label: "Email" },
          { name: "password", label: "Password" },
        ],
      },
    );
  }),
);

it.effect("a failed file write keeps the value, so the request can retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const name = ref.slice("secret-ref:".length);
          // A non-empty directory where the partial file goes makes the write fail.
          const partial = path.join(directory, "files", `${name}.partial`);
          yield* fs.makeDirectory(path.join(partial, "block"), { recursive: true });
          const failed = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(failed.reason, "store_failed");
          yield* fs.remove(partial, { recursive: true });
          const file = singleFile(yield* service.saveToFile({ threadId, turnItemId }));
          assert.equal(yield* fs.readFileString(file), "cf_token");
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file is not delivered while its stored copy cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const first = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(first.reason, "consume_failed");
          // A retry finds the file but still will not hand it out until the removal works.
          const retried = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(retried.reason, "consume_failed");
        }),
      { delivery: "file", directory, removeFails: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never written to a file", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

it.effect("a pasted secret goes straight to an owner-only file, with no card", () =>
  Effect.gen(function* () {
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
    const pasted = "4829'$(id) 16";
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const file = yield* service.savePasted({
            threadId,
            requestNamespace: "session-a",
            requestKey: "key-1",
            value: pasted,
          });
          assert.equal(path.dirname(file), path.join(directory, "files"));
          assert.match(path.basename(file), /^[0-9a-f]{32}$/);
          assert.equal(yield* fs.readFileString(file), pasted);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // No card and no stored copy: the thread never hears of it.
          assert.deepEqual(dispatched, []);
          assert.deepEqual(valuesOf(stored), []);
          // A retry with the same key gets the same file, unchanged even if the value differs.
          assert.equal(
            yield* service.savePasted({
              threadId,
              requestNamespace: "session-a",
              requestKey: "key-1",
              value: "other",
            }),
            file,
          );
          assert.equal(yield* fs.readFileString(file), pasted);
          // Another key, or the same key from another provider session, gets its own file.
          const other = yield* service.savePasted({
            threadId,
            requestNamespace: "session-a",
            requestKey: "key-2",
            value: "x",
          });
          assert.notEqual(other, file);
          const otherSession = yield* service.savePasted({
            threadId,
            requestNamespace: "session-b",
            requestKey: "key-1",
            value: "y",
          });
          assert.notEqual(otherSession, file);
          assert.equal(yield* fs.readFileString(file), pasted);
          // Its name is not a ref to the value.
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }).pipe(Effect.withTracer(tracer)),
      { directory },
    );
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.savePasted");
    assert.isFalse(recorded.some((value) => value.includes("4829")));

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pasted secret keeps its exact bytes from the tool input to the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
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
    const file = yield* withService(
      ({ service }) =>
        service.savePasted({
          threadId,
          requestNamespace: "session-a",
          requestKey: "key-1",
          value: input.value!,
        }),
      { directory },
    );
    assert.equal(yield* fs.readFileString(file), pasted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pasted secret is refused without a secrets directory", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failed = yield* service
        .savePasted({ threadId, requestNamespace: "session-a", requestKey: "key-1", value: "4829" })
        .pipe(Effect.flip);
      assert.equal(failed.reason, "store_failed");
    }),
  ),
);
