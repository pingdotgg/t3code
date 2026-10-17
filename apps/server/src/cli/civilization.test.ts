// @effect-diagnostics nodeBuiltinImport:off - CLI integration binds a synthetic local HTTP endpoint.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStandardClientScopes,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  CivilizationConfigConflictError,
  CivilizationDefaultConfig,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cli } from "../binCli.ts";
import { civilizationCliErrorMessage } from "./civilization.ts";
import * as ServerConfig from "../config.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("renders only safe Civilization CLI error metadata", () => {
  assert.equal(
    civilizationCliErrorMessage(
      new CivilizationConfigConflictError({
        code: "civilization_conflict",
        scope: "project",
        expectedRevision: 3,
        currentRevision: 4,
      }),
    ),
    "Civilization project configuration revision conflict: expected 3, current 4.",
  );
  assert.equal(
    civilizationCliErrorMessage(new Error("authorization=Bearer super-secret-token")),
    "Civilization request failed.",
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    use,
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const withFakeCivilizationServer = <A, E, R>(
  use: (input: {
    readonly origin: string;
    readonly authorizations: ReadonlyArray<string | undefined>;
    readonly requests: ReadonlyArray<{
      readonly method: string | undefined;
      readonly url: string;
      readonly body?: unknown;
    }>;
    readonly nextPausedRequest: () => Promise<{
      readonly authorization: string | undefined;
      readonly release: () => void;
    }>;
  }) => Effect.Effect<A, E, R>,
  options?: { readonly pauseRequests?: boolean },
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly server: NodeHttp.Server;
          readonly origin: string;
          readonly authorizations: Array<string | undefined>;
          readonly requests: Array<{
            readonly method: string | undefined;
            readonly url: string;
            body?: unknown;
          }>;
          readonly nextPausedRequest: () => Promise<{
            readonly authorization: string | undefined;
            readonly release: () => void;
          }>;
        }>((resolve, reject) => {
          const authorizations: Array<string | undefined> = [];
          const requests: Array<{
            readonly method: string | undefined;
            readonly url: string;
            body?: unknown;
          }> = [];
          const paused: Array<{
            readonly authorization: string | undefined;
            readonly release: () => void;
          }> = [];
          const waiters: Array<
            (request: {
              readonly authorization: string | undefined;
              readonly release: () => void;
            }) => void
          > = [];
          const nextPausedRequest = () =>
            paused.length > 0
              ? Promise.resolve(paused.shift()!)
              : new Promise<{
                  readonly authorization: string | undefined;
                  readonly release: () => void;
                }>((resolvePaused) => waiters.push(resolvePaused));
          const server = NodeHttp.createServer(async (request, response) => {
            authorizations.push(request.headers.authorization);
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const observedRequest: {
              readonly method: string | undefined;
              readonly url: string;
              body?: unknown;
            } = { method: request.method, url: `${url.pathname}${url.search}` };
            requests.push(observedRequest);
            if (options?.pauseRequests === true) {
              await new Promise<void>((resume) => {
                const observation = {
                  authorization: request.headers.authorization,
                  release: resume,
                };
                const waiter = waiters.shift();
                if (waiter === undefined) paused.push(observation);
                else waiter(observation);
              });
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/status") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  status: "disabled",
                  environmentRevision: 0,
                  projectRevision: 0,
                  citizenCount: 0,
                  openCitizenCount: 0,
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/capabilities") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  providers: [
                    {
                      providerInstanceId: "codex",
                      support: "full",
                      contextInjection: true,
                      keyedContextReplacement: true,
                      actionablePromptRefresh: true,
                      providerContinuationRefresh: true,
                      messaging: false,
                    },
                  ],
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/census") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  revision: 7,
                  citizens: [],
                  nextCursor: null,
                  partial: false,
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/notes") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  revision: 9,
                  notes: [],
                  nextCursor: null,
                  partial: false,
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/api/civilization/notes/")) {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  noteId: decodeURIComponent(url.pathname.slice("/api/civilization/notes/".length)),
                  projectId: url.searchParams.get("projectId"),
                  category: "fact",
                  bodyBytes: 5,
                  authorThreadId: "thread:test",
                  authorEpoch: 1,
                  acceptedRuntimeMode: "approval-required",
                  acceptedInteractionMode: "default",
                  revision: 1,
                  createdAt: "2026-10-16T09:00:00.000Z",
                  updatedAt: "2026-10-16T09:00:00.000Z",
                  resolvedAt: null,
                  body: "hello",
                  sourceReferences: [],
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/inbox") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  revision: 11,
                  messages: [],
                  nextCursor: null,
                  partial: false,
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/api/civilization/inbox/")) {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  messageId: decodeURIComponent(
                    url.pathname.slice("/api/civilization/inbox/".length),
                  ),
                  senderThreadId: "thread:sender",
                  senderNameAtSend: "Ada",
                  senderCitizenEpoch: 2,
                  senderRunId: "run:sender",
                  recipientThreadId: "thread:recipient",
                  recipientDeliveryEpoch: 4,
                  replyToMessageId: null,
                  bodyBytes: 5,
                  acceptedRuntimeMode: "approval-required",
                  acceptedInteractionMode: "default",
                  acceptedEnvironmentRevision: 3,
                  acceptedProjectRevision: 5,
                  acceptedAt: "2026-10-16T10:00:00.000Z",
                  expiresAt: "2026-11-15T10:00:00.000Z",
                  terminalRetentionDays: 30,
                  firstOfferedAt: null,
                  lastOfferedAt: null,
                  offerCount: 0,
                  acknowledgedAt: null,
                  terminalAt: "2026-10-16T10:02:00.000Z",
                  terminalReason: "recipient_archived",
                  body: "hello",
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/export") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  schemaVersion: 1,
                  projectId: url.searchParams.get("projectId"),
                  exportedAt: "2026-10-16T10:00:00.000Z",
                  environmentRevision: 0,
                  projectRevision: 0,
                  effectiveConfig: CivilizationDefaultConfig,
                  limitations: {
                    mode: "inspection_backup_only",
                    inspectionBackupOnly: true,
                    restorable: false,
                    excluded: [
                      "provider-native content",
                      "host transcripts",
                      "user copies",
                      "database backups",
                    ],
                  },
                  citizens: [],
                  notes: [],
                  mail: [],
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/purge/preview") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  previewToken: "sha256:preview",
                  environmentRevision: 0,
                  projectRevision: 0,
                  censusRevision: 0,
                  notesRevision: 0,
                  mailRevision: 0,
                  counts: {
                    citizens: 0,
                    notes: 0,
                    noteBodyBytes: 0,
                    messages: 0,
                    messageBodyBytes: 0,
                    contextReferences: 0,
                    contextInspections: 0,
                    receipts: 0,
                    quotaWindows: 0,
                    projectConfigRows: 0,
                    projectStateRows: 0,
                  },
                  limitations: {
                    mode: "inspection_backup_only",
                    inspectionBackupOnly: true,
                    restorable: false,
                    excluded: [],
                  },
                  warnings: [],
                }),
              );
              return;
            }
            if (request.method === "POST" && url.pathname === "/api/civilization/purge/apply") {
              const body = await new Promise<string>((resolveBody) => {
                let text = "";
                request.setEncoding("utf8");
                request.on("data", (chunk) => {
                  text += chunk;
                });
                request.on("end", () => resolveBody(text));
              });
              observedRequest.body = JSON.parse(body) as unknown;
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: "project:test",
                  complete: true,
                  deletedThisBatch: 0,
                  remaining: 0,
                  progressState: "complete",
                  purgeStartedAt: "2026-10-16T10:00:00.000Z",
                  purgeCompletedAt: "2026-10-16T10:00:00.000Z",
                }),
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/api/civilization/retention") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  noteRetentionDays: 30,
                  diagnosticRetentionDays: 7,
                  tombstoneRetentionDays: 30,
                }),
              );
              return;
            }
            if (
              request.method === "GET" &&
              url.pathname === "/api/civilization/retention/preview"
            ) {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: url.searchParams.get("projectId"),
                  previewToken: "sha256:retention-preview",
                  environmentRevision: 0,
                  projectRevision: 0,
                  current: {
                    noteRetentionDays: 30,
                    diagnosticRetentionDays: 7,
                    tombstoneRetentionDays: 30,
                  },
                  configured: {
                    noteRetentionDays: 14,
                    diagnosticRetentionDays: 3,
                    tombstoneRetentionDays: 15,
                  },
                  proposed: {
                    noteRetentionDays: 14,
                    diagnosticRetentionDays: 3,
                    tombstoneRetentionDays: 15,
                  },
                  newlyEligible: {
                    resolvedNotes: 2,
                    resolvedNoteBodyBytes: 99,
                    diagnosticReferences: 4,
                    diagnosticInspections: 2,
                    tombstones: 1,
                  },
                  samples: {
                    noteIds: ["note:one"],
                    contextReferenceIds: ["context:one"],
                    contextInspectionIds: ["inspection:one"],
                    tombstoneThreadIds: ["thread:one"],
                    partial: true,
                  },
                  warnings: ["warning"],
                }),
              );
              return;
            }
            if (request.method === "POST" && url.pathname === "/api/civilization/retention/apply") {
              const body = await new Promise<string>((resolveBody) => {
                let text = "";
                request.setEncoding("utf8");
                request.on("data", (chunk) => {
                  text += chunk;
                });
                request.on("end", () => resolveBody(text));
              });
              observedRequest.body = JSON.parse(body) as unknown;
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(
                encodeJson({
                  projectId: "project:test",
                  applied: {
                    noteRetentionDays: 14,
                    diagnosticRetentionDays: 3,
                    tombstoneRetentionDays: 15,
                  },
                  newlyEligible: {
                    resolvedNotes: 2,
                    resolvedNoteBodyBytes: 99,
                    diagnosticReferences: 4,
                    diagnosticInspections: 2,
                    tombstones: 1,
                  },
                }),
              );
              return;
            }
            response.statusCode = 404;
            response.setHeader("content-type", "application/json");
            response.end(encodeJson({ code: "not_found" }));
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Expected TCP address for fake Civilization server."));
              return;
            }
            resolve({
              server,
              origin: `http://127.0.0.1:${address.port}`,
              authorizations,
              requests,
              nextPausedRequest,
            });
          });
        }),
    ),
    ({ origin, authorizations, requests, nextPausedRequest }) =>
      use({ origin, authorizations, requests, nextPausedRequest }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

it.effect(
  "fails explicitly when no running server owns the environment and does not create a database fallback",
  () =>
    withTempDirectory("t3-civilization-cli-missing-", (baseDir) =>
      Effect.gen(function* () {
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });
        const error = yield* runCli(["civilization", "status", "--base-dir", baseDir]).pipe(
          Effect.flip,
        );
        assert.match(String(error), /No running T3 Code server owns this environment/);
        assert.isFalse(NodeFS.existsSync(paths.dbPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "calls the live authenticated Civilization API and revokes its ephemeral read session",
  () =>
    withTempDirectory("t3-civilization-cli-live-", (baseDir) =>
      withFakeCivilizationServer(({ origin, authorizations }) =>
        Effect.gen(function* () {
          const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
            baseDirIsExplicit: true,
          });
          yield* ServerConfig.ensureServerDirectories(paths);
          yield* persistServerRuntimeState({
            path: paths.serverRuntimeStatePath,
            state: {
              version: 1,
              pid: process.pid,
              host: "127.0.0.1",
              port: Number(new URL(origin).port),
              origin,
              startedAt: "2026-10-16T08:00:00.000Z",
            },
          });

          yield* runCli(["civilization", "status", "--base-dir", baseDir]);
          assert.equal(authorizations.length, 1);
          assert.match(authorizations[0] ?? "", /^Bearer .+/);

          const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
            Layer.provide(NodeServices.layer),
          );
          const environmentAuthLayer = EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(configLayer),
            Layer.provide(NodeServices.layer),
          );
          const sessions = yield* EnvironmentAuth.EnvironmentAuth.pipe(
            Effect.flatMap((auth) => auth.listSessions()),
            Effect.provide(environmentAuthLayer),
          );
          assert.deepEqual(sessions, []);
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "issues least-privilege ephemeral scopes for Civilization reads and administrative operations",
  () =>
    withTempDirectory("t3-civilization-cli-scopes-", (baseDir) =>
      withFakeCivilizationServer(
        ({ origin, nextPausedRequest }) =>
          Effect.gen(function* () {
            const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
              baseDirIsExplicit: true,
            });
            yield* ServerConfig.ensureServerDirectories(paths);
            yield* persistServerRuntimeState({
              path: paths.serverRuntimeStatePath,
              state: {
                version: 1,
                pid: process.pid,
                host: "127.0.0.1",
                port: Number(new URL(origin).port),
                origin,
                startedAt: "2026-10-16T09:30:00.000Z",
              },
            });

            const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
              Layer.provide(NodeServices.layer),
            );
            const environmentAuthLayer = EnvironmentAuth.layerRuntime.pipe(
              Layer.provide(configLayer),
              Layer.provide(NodeServices.layer),
            );
            const authenticateInFlight = (args: ReadonlyArray<string>) =>
              Effect.acquireUseRelease(
                Effect.gen(function* () {
                  const fiber = yield* Effect.forkChild(runCli([...args, "--base-dir", baseDir]));
                  const request = yield* Effect.promise(nextPausedRequest);
                  return { fiber, request } as const;
                }),
                ({ request }) => {
                  assert.match(request.authorization ?? "", /^Bearer .+/);
                  return EnvironmentAuth.EnvironmentAuth.pipe(
                    Effect.flatMap((auth) =>
                      auth.authenticateHttpRequest({
                        cookies: {},
                        headers: { authorization: request.authorization },
                      } as never),
                    ),
                    Effect.provide(environmentAuthLayer),
                    Effect.map((session) => session.scopes),
                  );
                },
                ({ fiber, request }) =>
                  Effect.sync(request.release).pipe(
                    Effect.andThen(Fiber.await(fiber)),
                    Effect.asVoid,
                  ),
              );

            const readCommands = [
              ["civilization", "status"],
              ["civilization", "capabilities"],
              ["civilization", "census", "--project", "project:test"],
              ["civilization", "note", "list", "--project", "project:test"],
            ] as const;
            for (const args of readCommands) {
              assert.deepEqual(yield* authenticateInFlight(args), [AuthOrchestrationReadScope]);
            }

            const noteReadScopes = yield* authenticateInFlight([
              "civilization",
              "note",
              "read",
              "--project",
              "project:test",
              "--note",
              "note:test",
            ]);
            assert.deepEqual(noteReadScopes, AuthStandardClientScopes);
            assert.include(noteReadScopes, AuthSettingsWriteScope);

            for (const args of [
              ["civilization", "inbox", "list", "--project", "project:test"],
              [
                "civilization",
                "inbox",
                "read",
                "--project",
                "project:test",
                "--message",
                "mail:test",
              ],
            ] as const) {
              const inboxScopes = yield* authenticateInFlight(args);
              assert.deepEqual(inboxScopes, AuthStandardClientScopes);
              assert.include(inboxScopes, AuthSettingsWriteScope);
            }

            for (const args of [
              ["civilization", "config", "reset", "--expected-revision", "0"],
              ["civilization", "export", "--project", "project:test"],
              ["civilization", "purge", "preview", "--project", "project:test"],
              ["civilization", "retention", "get", "--project", "project:test"],
              ["civilization", "retention", "preview", "--project", "project:test"],
              [
                "civilization",
                "retention",
                "apply",
                "--project",
                "project:test",
                "--preview-token",
                "sha256:retention-preview",
              ],
              [
                "civilization",
                "purge",
                "apply",
                "--project",
                "project:test",
                "--preview-token",
                "sha256:preview",
              ],
              [
                "civilization",
                "citizen",
                "title",
                "restore",
                "--project",
                "project:test",
                "--thread",
                "thread:test",
                "--expected-citizen-revision",
                "1",
              ],
            ] as const) {
              const scopes = yield* authenticateInFlight(args);
              assert.deepEqual(scopes, AuthStandardClientScopes);
              assert.include(scopes, AuthSettingsWriteScope);
            }

            const remainingSessions = yield* EnvironmentAuth.EnvironmentAuth.pipe(
              Effect.flatMap((auth) => auth.listSessions()),
              Effect.provide(environmentAuthLayer),
            );
            assert.deepEqual(remainingSessions, []);
          }),
        { pauseRequests: true },
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "routes census and note inspection through the running authenticated Environment HTTP API",
  () =>
    withTempDirectory("t3-civilization-cli-reads-", (baseDir) =>
      withFakeCivilizationServer(({ origin, authorizations, requests }) =>
        Effect.gen(function* () {
          const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
            baseDirIsExplicit: true,
          });
          yield* ServerConfig.ensureServerDirectories(paths);
          yield* persistServerRuntimeState({
            path: paths.serverRuntimeStatePath,
            state: {
              version: 1,
              pid: process.pid,
              host: "127.0.0.1",
              port: Number(new URL(origin).port),
              origin,
              startedAt: "2026-10-16T09:00:00.000Z",
            },
          });

          yield* runCli(["civilization", "capabilities", "--base-dir", baseDir]);
          yield* runCli([
            "civilization",
            "census",
            "--project",
            "project:test",
            "--limit",
            "2",
            "--cursor",
            "census-cursor",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "note",
            "list",
            "--project",
            "project:test",
            "--cursor",
            "notes-cursor",
            "--include-resolved",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "note",
            "read",
            "--project",
            "project:test",
            "--note",
            "note:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "inbox",
            "list",
            "--project",
            "project:test",
            "--cursor",
            "mail-cursor",
            "--limit",
            "3",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "inbox",
            "read",
            "--project",
            "project:test",
            "--message",
            "mail:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "export",
            "--project",
            "project:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "purge",
            "preview",
            "--project",
            "project:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "purge",
            "apply",
            "--project",
            "project:test",
            "--preview-token",
            "sha256:preview",
            "--batch-size",
            "25",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "retention",
            "get",
            "--project",
            "project:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "retention",
            "preview",
            "--project",
            "project:test",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "civilization",
            "retention",
            "apply",
            "--project",
            "project:test",
            "--preview-token",
            "sha256:retention-preview",
            "--base-dir",
            baseDir,
          ]);

          assert.equal(authorizations.length, 12);
          assert.isTrue(authorizations.every((value) => /^Bearer .+/.test(value ?? "")));

          const seen = requests.map(({ method, url, body }) => ({
            method,
            url: new URL(url, origin),
            body,
          }));
          const capabilities = seen.find(
            ({ url }) => url.pathname === "/api/civilization/capabilities",
          );
          assert.equal(capabilities?.method, "GET");
          const census = seen.find(({ url }) => url.pathname === "/api/civilization/census");
          assert.equal(census?.method, "GET");
          assert.equal(census?.url.searchParams.get("projectId"), "project:test");
          assert.equal(census?.url.searchParams.get("limit"), "2");
          assert.equal(census?.url.searchParams.get("cursor"), "census-cursor");

          const noteList = seen.find(({ url }) => url.pathname === "/api/civilization/notes");
          assert.equal(noteList?.method, "GET");
          assert.equal(noteList?.url.searchParams.get("projectId"), "project:test");
          assert.equal(noteList?.url.searchParams.get("includeResolved"), "true");
          assert.equal(noteList?.url.searchParams.get("cursor"), "notes-cursor");

          const noteRead = seen.find(
            ({ url }) => url.pathname === "/api/civilization/notes/note%3Atest",
          );
          assert.equal(noteRead?.method, "GET");
          assert.equal(noteRead?.url.searchParams.get("projectId"), "project:test");

          const inboxList = seen.find(({ url }) => url.pathname === "/api/civilization/inbox");
          assert.equal(inboxList?.method, "GET");
          assert.equal(inboxList?.url.searchParams.get("projectId"), "project:test");
          assert.equal(inboxList?.url.searchParams.get("cursor"), "mail-cursor");
          assert.equal(inboxList?.url.searchParams.get("limit"), "3");

          const inboxRead = seen.find(
            ({ url }) => url.pathname === "/api/civilization/inbox/mail%3Atest",
          );
          assert.equal(inboxRead?.method, "GET");
          assert.equal(inboxRead?.url.searchParams.get("projectId"), "project:test");

          const dataExport = seen.find(({ url }) => url.pathname === "/api/civilization/export");
          assert.equal(dataExport?.method, "GET");
          assert.equal(dataExport?.url.searchParams.get("projectId"), "project:test");
          const purgePreview = seen.find(
            ({ url }) => url.pathname === "/api/civilization/purge/preview",
          );
          assert.equal(purgePreview?.method, "GET");
          assert.equal(purgePreview?.url.searchParams.get("projectId"), "project:test");
          const purgeApply = seen.find(
            ({ url }) => url.pathname === "/api/civilization/purge/apply",
          );
          assert.equal(purgeApply?.method, "POST");
          assert.deepEqual(purgeApply?.body, {
            projectId: "project:test",
            expectedPreviewToken: "sha256:preview",
            batchSize: 25,
          });

          const retentionGet = seen.find(
            ({ url }) => url.pathname === "/api/civilization/retention",
          );
          assert.equal(retentionGet?.method, "GET");
          assert.equal(retentionGet?.url.searchParams.get("projectId"), "project:test");
          const retentionPreview = seen.find(
            ({ url }) => url.pathname === "/api/civilization/retention/preview",
          );
          assert.equal(retentionPreview?.method, "GET");
          assert.equal(retentionPreview?.url.searchParams.get("projectId"), "project:test");
          const retentionApply = seen.find(
            ({ url }) => url.pathname === "/api/civilization/retention/apply",
          );
          assert.equal(retentionApply?.method, "POST");
          assert.deepEqual(retentionApply?.body, {
            projectId: "project:test",
            expectedPreviewToken: "sha256:retention-preview",
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);
