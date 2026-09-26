import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  FederationError,
  FederationPeer,
  type FederationPeerCodeResult,
  type FederationRemoteRun,
  type FederationRemoteRunsSnapshot,
  type FederationRunEvent,
  type FederationRunStatus,
  type FederationSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsFederationAddPeerRpc,
  WsFederationCreatePeerCodeRpc,
  WsFederationListRemoteProjectsRpc,
  WsFederationRemovePeerRpc,
  WsFederationStartRemoteRunRpc,
  WsFederationSubscribePeersRpc,
  WsFederationSubscribeRemoteRunsRpc,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcGroup } from "effect/unstable/rpc";

import {
  captureJson,
  captureStdout,
  expectShowHelpError,
  flipCli,
  makeTempBaseDir,
  withLiveCliServer,
} from "../testUtils/liveCliServer.ts";
import { runningServerWsUrl } from "./runningServer.ts";

const LOCAL_ID = EnvironmentId.make("env-local");
const PEER_ID = EnvironmentId.make("env-peer-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-remote-1");
const UPDATED_AT = "2026-06-21T08:30:00.000Z";

const peer: FederationPeer = {
  peerId: PEER_ID,
  label: "Build box",
  publicKeyFingerprint: "SHA256:peer-fingerprint",
  grantedScopes: ["environment.read", "projects.read", "runs.read"],
  allowedScopes: ["environment.read", "projects.read", "runs.read", "runs.start"],
  transport: { tailcat: { address: "tcPeerAddressAbCdEfGhIj", port: 3773 } },
  remoteServerVersion: "0.9.0",
  remoteProtocolVersion: 1,
  remoteCapabilities: ["hello", "projects.list", "runs.start"],
  status: "online",
  lastSeenAt: UPDATED_AT,
  lastError: null,
  createdAt: "2026-06-20T00:00:00.000Z",
};

const peersSnapshot: FederationSnapshot = {
  environmentId: LOCAL_ID,
  publicKeyFingerprint: "SHA256:local-fingerprint",
  protocolVersion: 1,
  peers: [peer],
  updatedAt: UPDATED_AT,
};

const peerCode: FederationPeerCodeResult = {
  code: "t3c://peer/test-code",
  payload: {
    v: 1,
    kind: "peer",
    protocolVersion: 1,
    environmentId: LOCAL_ID,
    publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtest\n-----END PUBLIC KEY-----",
    label: "local",
    transport: { tailcat: { address: "tcLocalAddressAbCdEfGhIj", port: 3773 } },
    token: "one-time-token",
    scopes: ["environment.read", "projects.read", "runs.read"],
    expiresAt: "2026-06-21T08:35:00.000Z",
  },
  expiresAt: "2026-06-21T08:35:00.000Z",
};

const runEvent = (sequence: number, type: string, summary: string): FederationRunEvent => ({
  sequence,
  at: UPDATED_AT,
  type,
  summary,
});

const remoteRun = (
  status: FederationRunStatus,
  events: ReadonlyArray<FederationRunEvent>,
  assistantPreview: string | null = null,
): FederationRemoteRun => ({
  peerId: PEER_ID,
  peerLabel: peer.label,
  run: {
    environmentId: PEER_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    turnId: null,
    title: "Fix the flaky test",
    status,
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    requestedAt: UPDATED_AT,
    startedAt: null,
    completedAt: null,
    assistantPreview,
    turnCount: 0,
  },
  events,
  lastSyncedAt: null,
  syncError: null,
});

const remoteRunsSnapshot = (run: FederationRemoteRun): FederationRemoteRunsSnapshot => ({
  runs: [run],
  updatedAt: UPDATED_AT,
});

const turnStarted = runEvent(1, "turn.started", "Turn started");
const assistantMessage = runEvent(2, "assistant.message", "Working on it");
const turnCompleted = runEvent(3, "turn.completed", "Turn completed");

/** Only the federation RPCs the CLI drives; the client is built from the full group and dispatches by tag. */
const PeerCliRpcs = RpcGroup.make(
  WsFederationSubscribePeersRpc,
  WsFederationCreatePeerCodeRpc,
  WsFederationAddPeerRpc,
  WsFederationRemovePeerRpc,
  WsFederationListRemoteProjectsRpc,
  WsFederationStartRemoteRunRpc,
  WsFederationSubscribeRemoteRunsRpc,
);

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

const makeFederationHandlersLayer = (calls: Ref.Ref<ReadonlyArray<RecordedCall>>) => {
  const record = (method: string, input: unknown) =>
    Ref.update(calls, (recorded) => [...recorded, { method, input }]);
  return PeerCliRpcs.toLayer({
    [WS_METHODS.federationSubscribePeers]: () => Stream.make(peersSnapshot),
    [WS_METHODS.federationCreatePeerCode]: (input) =>
      record("createPeerCode", input).pipe(
        Effect.as({ ...peerCode, payload: { ...peerCode.payload, scopes: input.scopes } }),
      ),
    [WS_METHODS.federationAddPeer]: (input) =>
      input.code === peerCode.code
        ? record("addPeer", input).pipe(Effect.as({ ...peer, grantedScopes: input.grantedScopes }))
        : Effect.fail(
            new FederationError({ code: "code-invalid", message: "That peer code is not valid." }),
          ),
    [WS_METHODS.federationRemovePeer]: (input) =>
      input.peerId === PEER_ID
        ? record("removePeer", input)
        : Effect.fail(
            new FederationError({
              code: "peer-unknown",
              message: `No peer ${input.peerId} is paired with this server.`,
            }),
          ),
    [WS_METHODS.federationListRemoteProjects]: () =>
      Effect.succeed({
        environmentId: PEER_ID,
        projects: [
          {
            id: PROJECT_ID,
            title: "t3code",
            workspaceRoot: "/srv/t3code",
            repositoryIdentity: null,
            defaultModelSelection: null,
          },
        ],
      }),
    [WS_METHODS.federationStartRemoteRun]: (input) =>
      record("startRemoteRun", input).pipe(Effect.as(remoteRun("queued", []))),
    [WS_METHODS.federationSubscribeRemoteRuns]: () =>
      Stream.make(
        remoteRunsSnapshot(remoteRun("running", [turnStarted])),
        remoteRunsSnapshot(remoteRun("running", [turnStarted, assistantMessage])),
        remoteRunsSnapshot(
          remoteRun("completed", [turnStarted, assistantMessage, turnCompleted], "Done."),
        ),
      ),
  });
};

const withLiveFederationServer = <A, E, R>(
  baseDir: string,
  run: (calls: Ref.Ref<ReadonlyArray<RecordedCall>>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(Ref.make<ReadonlyArray<RecordedCall>>([]), (calls) =>
    withLiveCliServer({
      baseDir,
      rpcs: PeerCliRpcs,
      handlers: makeFederationHandlersLayer(calls),
      run: () => run(calls),
    }),
  );

const decodePeersJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(FederationPeer)),
);
const isFederationError = Schema.is(FederationError);

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

it("derives the RPC socket URL from the server origin", () => {
  assert.equal(runningServerWsUrl("http://127.0.0.1:3773"), "ws://127.0.0.1:3773/ws");
  assert.equal(runningServerWsUrl("https://[fd7a:115c::1]:3773"), "wss://[fd7a:115c::1]:3773/ws");
});

it.layer(NodeServices.layer)("t3 peer", (it) => {
  it.effect("registers every peer subcommand", () =>
    Effect.gen(function* () {
      const output = yield* captureStdout(["peer", "--help"]);

      for (const subcommand of ["code", "add", "list", "remove", "projects", "run"]) {
        assert.include(output, subcommand);
      }
      assert.include(output, "Pair with other T3 Code servers and delegate runs to them.");
    }),
  );

  it.effect("validates arguments before contacting any server", () =>
    Effect.gen(function* () {
      expectShowHelpError(yield* flipCli(["peer", "add"]), "MissingArgument");

      const badGrant = expectShowHelpError(
        yield* flipCli(["peer", "add", "t3c://peer/x", "--grant", "nope"]),
        "InvalidValue",
      );
      if (badGrant?._tag !== "InvalidValue") {
        assert.fail("Expected InvalidValue");
      }
      assert.equal(badGrant.option, "grant");

      const noPrompt = expectShowHelpError(
        yield* flipCli(["peer", "run", "env-peer-1", "project-1"]),
        "MissingArgument",
      );
      if (noPrompt?._tag !== "MissingArgument") {
        assert.fail("Expected MissingArgument");
      }
      assert.equal(noPrompt.argument, "prompt");

      expectShowHelpError(yield* flipCli(["peer", "remove", "   "]), "InvalidValue");
    }),
  );

  it.effect("lists peers from the running server", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("list");

      yield* withLiveFederationServer(baseDir, () =>
        Effect.gen(function* () {
          const output = yield* captureStdout(["peer", "list", "--base-dir", baseDir]);
          assert.include(
            output,
            "This environment: env-local (fingerprint SHA256:local-fingerprint)",
          );
          assert.include(output, "Build box (env-peer-1) online");
          assert.include(output, "fingerprint: SHA256:peer-fingerprint");
          assert.include(
            output,
            "granted (they may do here): environment.read projects.read runs.read",
          );
          assert.include(
            output,
            "allowed (we may do there): environment.read projects.read runs.read runs.start",
          );
          assert.include(output, "transport: tailcat tcPeerAddressAbCdEfGhIj:3773");
          assert.include(output, `last seen: ${UPDATED_AT}`);

          const json = yield* captureJson(["peer", "list", "--base-dir", baseDir, "--json"]);
          assert.deepEqual(yield* decodePeersJson(json), [peer]);
        }),
      );
    }),
  );

  it.effect("issues and redeems peer codes, browses projects, and removes peers", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("pairing");

      yield* withLiveFederationServer(baseDir, (calls) =>
        Effect.gen(function* () {
          const code = yield* captureStdout(["peer", "code", "--base-dir", baseDir]);
          assert.include(code, "Peer code (expires 2026-06-21T08:35:00.000Z, single use):");
          assert.include(code, "t3c://peer/test-code");
          assert.include(code, "Offered scopes: environment.read projects.read runs.read");
          assert.include(code, "one-time pairing credential");

          const scoped = yield* captureStdout([
            "peer",
            "code",
            "--base-dir",
            baseDir,
            "--scope",
            "runs.start",
            "--scope",
            "runs.start",
            "--ttl",
            "10m",
          ]);
          assert.include(scoped, "Offered scopes: runs.start");

          const added = yield* captureStdout([
            "peer",
            "add",
            peerCode.code,
            "--base-dir",
            baseDir,
            "--grant",
            "runs.start",
          ]);
          assert.include(added, "Paired with a new peer.");
          assert.include(added, "Build box (env-peer-1) online");
          assert.include(added, "granted (they may do here): runs.start");

          const rejected = yield* flipCli([
            "peer",
            "add",
            "t3c://peer/bogus",
            "--base-dir",
            baseDir,
          ]);
          if (!isFederationError(rejected)) {
            assert.fail(`Expected FederationError, got ${String(rejected)}`);
          }
          assert.equal(rejected.code, "code-invalid");
          assert.equal(rejected.message, "That peer code is not valid.");

          const projects = yield* captureStdout([
            "peer",
            "projects",
            "env-peer-1",
            "--base-dir",
            baseDir,
          ]);
          assert.include(projects, "t3code (project-1)");
          assert.include(projects, "path: /srv/t3code");

          const removed = yield* captureStdout([
            "peer",
            "remove",
            "env-peer-1",
            "--base-dir",
            baseDir,
          ]);
          assert.include(removed, "Removed peer env-peer-1.");

          const unknown = yield* flipCli(["peer", "remove", "env-other", "--base-dir", baseDir]);
          if (!isFederationError(unknown)) {
            assert.fail(`Expected FederationError, got ${String(unknown)}`);
          }
          assert.equal(unknown.code, "peer-unknown");

          const recorded = yield* Ref.get(calls);
          assert.deepEqual(
            recorded.map((call) => call.method),
            ["createPeerCode", "createPeerCode", "addPeer", "removePeer"],
          );
          assert.deepEqual(recorded[0]?.input, {
            scopes: ["environment.read", "projects.read", "runs.read"],
          });
          // Repeated scopes collapse; --ttl arrives in whole seconds.
          assert.deepEqual(recorded[1]?.input, { scopes: ["runs.start"], ttlSeconds: 600 });
          assert.deepEqual(recorded[2]?.input, {
            code: peerCode.code,
            grantedScopes: ["runs.start"],
          });
        }),
      );
    }),
  );

  it.effect("starts a remote run and can follow it to completion", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("run");

      yield* withLiveFederationServer(baseDir, (calls) =>
        Effect.gen(function* () {
          const started = yield* captureStdout([
            "peer",
            "run",
            "env-peer-1",
            "project-1",
            "fix",
            "the",
            "flaky",
            "test",
            "--title",
            "Flaky",
            "--base-dir",
            baseDir,
          ]);
          assert.include(started, "Run thread-remote-1 on Build box: queued");
          assert.include(started, "title: Fix the flaky test");
          assert.include(started, "model: codex/gpt-5-codex");

          const followed = yield* captureStdout([
            "peer",
            "run",
            "env-peer-1",
            "project-1",
            "fix the flaky test",
            "--wait",
            "--base-dir",
            baseDir,
          ]);
          assert.include(followed, "Started run thread-remote-1 on Build box (queued).");
          // Each event prints exactly once even though every snapshot repeats the history.
          assert.equal(countOccurrences(followed, "turn.started: Turn started"), 1);
          assert.equal(countOccurrences(followed, "assistant.message: Working on it"), 1);
          assert.equal(countOccurrences(followed, "turn.completed: Turn completed"), 1);
          assert.include(followed, "Run thread-remote-1 on Build box: completed");
          assert.include(followed, "assistant: Done.");

          const recorded = yield* Ref.get(calls);
          assert.deepEqual(
            recorded.map((call) => call.input),
            [
              {
                peerId: "env-peer-1",
                projectId: "project-1",
                prompt: "fix the flaky test",
                title: "Flaky",
              },
              { peerId: "env-peer-1", projectId: "project-1", prompt: "fix the flaky test" },
            ],
          );
        }),
      );
    }),
  );
});
