import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type TailcatConnectionCodeResult,
  TailcatRemoteAccessError,
  TailcatRemoteAccessState,
  WS_METHODS,
  WsTailcatCreateConnectionCodeRpc,
  WsTailcatRevokeTrustedPeerRpc,
  WsTailcatSetRemoteAccessEnabledRpc,
  WsTailcatSubscribeRemoteAccessRpc,
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
import { NoRunningServerError } from "./pair.ts";
import { TailcatUnavailableError } from "./remote.ts";
import { runningServerWsUrl } from "./runningServer.ts";

const TAILCAT_ADDRESS = "tcAbCdEfGhIjKlMnOpQrStUv";
const NODE_KEY = `nodekey:${"0123456789abcdef".repeat(4)}`;

const readyState: TailcatRemoteAccessState = {
  enabled: true,
  status: "ready",
  address: TAILCAT_ADDRESS,
  remotePort: 3773,
  pairingOpen: false,
  trustedPeers: [
    {
      id: "peer-phone",
      nodeKey: NODE_KEY,
      label: "Phone",
      createdAt: "2026-06-20T00:00:00.000Z",
      lastSeenAt: "2026-06-21T08:30:00.000Z",
      sessionIds: [],
    },
  ],
  runtime: {
    executablePath: "/opt/t3/tailcat",
    source: "bundled",
    version: "1.4.0",
    pinnedVersion: "1.4.0",
  },
  identityFingerprint: "SHA256:remote-test",
  lastError: null,
  updatedAt: "2026-06-21T08:30:00.000Z",
};

const disabledState: TailcatRemoteAccessState = {
  ...readyState,
  enabled: false,
  status: "disabled",
  address: null,
  remotePort: null,
};

const unavailableState: TailcatRemoteAccessState = {
  ...disabledState,
  status: "unavailable",
  runtime: null,
  lastError: {
    code: "binary-missing",
    message: "The tailcat binary was not found.",
    at: "2026-06-21T08:30:00.000Z",
  },
};

const connectionCode: TailcatConnectionCodeResult = {
  code: "t3c://tailcat/remote-test-code",
  payload: {
    v: 1,
    transport: "tailcat",
    address: TAILCAT_ADDRESS,
    port: 3773,
    environmentId: EnvironmentId.make("remote-test-environment"),
    name: "remote-test",
    serverVersion: "0.0.1",
    pairingToken: "one-time",
    expiresAt: "2026-06-21T08:35:00.000Z",
  },
  pairingLinkId: "pairing-link-1",
  expiresAt: "2026-06-21T08:35:00.000Z",
};

/** Only the Tailcat RPCs the CLI drives; the client is built from the full group and dispatches by tag. */
const RemoteCliRpcs = RpcGroup.make(
  WsTailcatSubscribeRemoteAccessRpc,
  WsTailcatSetRemoteAccessEnabledRpc,
  WsTailcatCreateConnectionCodeRpc,
  WsTailcatRevokeTrustedPeerRpc,
);

/**
 * Scripted remote access over a state ref. Enabling reports "starting" the way
 * the real service does before its listener is up, so `enable` has to follow
 * the subscription until the state settles.
 */
const makeTailcatHandlersLayer = (stateRef: Ref.Ref<TailcatRemoteAccessState>) =>
  RemoteCliRpcs.toLayer({
    [WS_METHODS.tailcatSubscribeRemoteAccess]: () => Stream.fromEffect(Ref.get(stateRef)),
    [WS_METHODS.tailcatSetRemoteAccessEnabled]: ({ enabled }) =>
      enabled
        ? Ref.updateAndGet(stateRef, (state): TailcatRemoteAccessState => ({
            ...state,
            enabled: true,
            status: "ready",
            address: TAILCAT_ADDRESS,
            remotePort: 3773,
          })).pipe(Effect.map((state) => ({ ...state, status: "starting" as const })))
        : Ref.updateAndGet(stateRef, (state) => ({
            ...state,
            enabled: false,
            status: "disabled",
            address: null,
            remotePort: null,
          })),
    [WS_METHODS.tailcatCreateConnectionCode]: () => Effect.succeed(connectionCode),
    [WS_METHODS.tailcatRevokeTrustedPeer]: ({ peerId }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        if (!current.trustedPeers.some((peer) => peer.id === peerId)) {
          return yield* new TailcatRemoteAccessError({
            code: "unknown",
            message: "That device is no longer in the trusted list.",
          });
        }
        return yield* Ref.updateAndGet(stateRef, (state) => ({
          ...state,
          trustedPeers: state.trustedPeers.filter((peer) => peer.id !== peerId),
        }));
      }),
  });

const withLiveTailcatServer = <A, E, R>(
  baseDir: string,
  stateRef: Ref.Ref<TailcatRemoteAccessState>,
  run: () => Effect.Effect<A, E, R>,
) =>
  withLiveCliServer({
    baseDir,
    rpcs: RemoteCliRpcs,
    handlers: makeTailcatHandlersLayer(stateRef),
    run,
  });

const decodeStateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TailcatRemoteAccessState));
const isTailcatRemoteAccessError = Schema.is(TailcatRemoteAccessError);
const isTailcatUnavailableError = Schema.is(TailcatUnavailableError);
const isNoRunningServerError = Schema.is(NoRunningServerError);

it("derives the RPC socket URL from the server origin", () => {
  assert.equal(runningServerWsUrl("http://127.0.0.1:3773"), "ws://127.0.0.1:3773/ws");
  assert.equal(runningServerWsUrl("https://[fd7a:115c::1]:3773"), "wss://[fd7a:115c::1]:3773/ws");
});

it.layer(NodeServices.layer)("t3 remote tailcat", (it) => {
  it.effect("registers every tailcat subcommand", () =>
    Effect.gen(function* () {
      const output = yield* captureStdout(["remote", "tailcat", "--help"]);

      for (const subcommand of ["status", "enable", "disable", "code", "peers", "revoke"]) {
        assert.include(output, subcommand);
      }
      assert.include(output, "Manage Tailcat remote access on the running server.");
    }),
  );

  it.effect("rejects a missing or blank peer id before contacting any server", () =>
    Effect.gen(function* () {
      expectShowHelpError(yield* flipCli(["remote", "tailcat", "revoke"]), "MissingArgument");
      expectShowHelpError(yield* flipCli(["remote", "tailcat", "revoke", "   "]), "InvalidValue");
    }),
  );

  it.effect("reports remote access state and trusted peers from the running server", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("status");
      const stateRef = yield* Ref.make(readyState);

      yield* withLiveTailcatServer(baseDir, stateRef, () =>
        Effect.gen(function* () {
          const status = yield* captureStdout([
            "remote",
            "tailcat",
            "status",
            "--base-dir",
            baseDir,
          ]);
          assert.include(status, "Tailcat remote access");
          assert.include(status, "Enabled: yes");
          assert.include(status, "Status: ready");
          assert.include(status, `Address: ${TAILCAT_ADDRESS}`);
          assert.include(status, "Connection code: none active");
          assert.include(status, "Runtime: bundled 1.4.0 (pinned 1.4.0) at /opt/t3/tailcat");
          assert.include(status, "Trusted peers: 1");
          assert.include(status, "Last error: none");

          const json = yield* captureJson([
            "remote",
            "tailcat",
            "status",
            "--base-dir",
            baseDir,
            "--json",
          ]);
          assert.deepEqual(yield* decodeStateJson(json), readyState);

          const peers = yield* captureStdout(["remote", "tailcat", "peers", "--base-dir", baseDir]);
          assert.include(peers, "peer-phone (Phone)");
          assert.include(peers, "node key: 0123·4567·cdef");
          assert.include(peers, "created: 2026-06-20T00:00:00.000Z");
          assert.include(peers, "last seen: 2026-06-21T08:30:00.000Z");
        }),
      );
    }),
  );

  it.effect("enables, mints a connection code, revokes a peer, and disables again", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("toggle");
      const stateRef = yield* Ref.make(disabledState);

      yield* withLiveTailcatServer(baseDir, stateRef, () =>
        Effect.gen(function* () {
          const enabled = yield* captureStdout([
            "remote",
            "tailcat",
            "enable",
            "--base-dir",
            baseDir,
          ]);
          assert.include(enabled, "Status: ready");
          assert.include(enabled, `Address: ${TAILCAT_ADDRESS}`);
          assert.include(enabled, "Next: run `t3 remote tailcat code`");
          assert.isTrue((yield* Ref.get(stateRef)).enabled);

          const code = yield* captureStdout([
            "remote",
            "tailcat",
            "code",
            "--base-dir",
            baseDir,
            "--label",
            "Laptop",
          ]);
          assert.include(code, "Connection code (expires 2026-06-21T08:35:00.000Z, single use):");
          assert.include(code, "t3c://tailcat/remote-test-code");
          assert.include(code, "Paste the code in the T3 Code desktop app");
          assert.include(code, "one-time pairing credential");

          const revoked = yield* captureStdout([
            "remote",
            "tailcat",
            "revoke",
            "peer-phone",
            "--base-dir",
            baseDir,
          ]);
          assert.include(revoked, "Revoked trusted peer peer-phone. 0 trusted peer(s) remain.");

          // The server's typed failure surfaces with its own wording.
          const revokedAgain = yield* flipCli([
            "remote",
            "tailcat",
            "revoke",
            "peer-phone",
            "--base-dir",
            baseDir,
          ]);
          if (!isTailcatRemoteAccessError(revokedAgain)) {
            assert.fail(`Expected TailcatRemoteAccessError, got ${String(revokedAgain)}`);
          }
          assert.equal(revokedAgain.message, "That device is no longer in the trusted list.");

          const disabled = yield* captureStdout([
            "remote",
            "tailcat",
            "disable",
            "--base-dir",
            baseDir,
          ]);
          assert.include(disabled, "Tailcat remote access is disabled.");
          assert.isFalse((yield* Ref.get(stateRef)).enabled);
        }),
      );
    }),
  );

  it.effect("fails with the binary override hint when the server reports Tailcat unavailable", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("unavailable");
      const stateRef = yield* Ref.make(unavailableState);

      yield* withLiveTailcatServer(baseDir, stateRef, () =>
        Effect.gen(function* () {
          const error = yield* flipCli(["remote", "tailcat", "status", "--base-dir", baseDir]);

          if (!isTailcatUnavailableError(error)) {
            assert.fail(`Expected TailcatUnavailableError, got ${String(error)}`);
          }
          assert.equal(error.code, "binary-missing");
          assert.include(error.message, "The tailcat binary was not found.");
          assert.include(error.message, "T3CODE_TAILCAT_BINARY");
        }),
      );
    }),
  );

  it.effect("directs to t3 serve when no server is running", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("none");

      const error = yield* flipCli(["remote", "tailcat", "status", "--base-dir", baseDir]);

      if (!isNoRunningServerError(error)) {
        assert.fail(`Expected NoRunningServerError, got ${String(error)}`);
      }
      assert.include(error.message, "No running T3 Code server found.");
      assert.include(error.message, "npx t3 serve");
    }),
  );
});
