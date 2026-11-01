import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claimTailscaleServe,
  ensureTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleSshEnabled,
  parseTailscaleProfiles,
  parseTailscaleStatus,
  parseTailscaleWhois,
  probeTailscaleHttpsEndpoint,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  readTailscaleWhois,
  releaseTailscaleServe,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleStatusParseError,
  TailscaleWhoisParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20","100.64.0.1abc","100.064.0.1"]}}`;

// 9007199254740993 is 2^53 + 1, which a JS number rounds to 2^53.
const fullStatusJson = `{
  "Version": "1.102.2-t6cac91817-g1",
  "BackendState": "NeedsLogin",
  "TUN": false,
  "Health": ["Tailscale could not connect to the relay server."],
  "CertDomains": ["desktop.tail.ts.net"],
  "CurrentTailnet": { "Name": "theo@", "MagicDNSEnabled": true },
  "Self": {
    "ID": "nSelf",
    "UserID": 9007199254740993,
    "DNSName": "desktop.tail.ts.net.",
    "TailscaleIPs": ["100.100.100.100"],
    "KeyExpiry": "2026-12-23T01:09:33Z",
    "CapMap": { "https": null }
  },
  "Peer": {
    "nodekey:a": {
      "ID": "nOwn", "HostName": "studio", "DNSName": "studio.tail.ts.net.", "OS": "linux",
      "UserID": 9007199254740993, "TailscaleIPs": ["100.88.1.2", "fd7a:115c:a1e0::2"],
      "Online": true, "Active": true, "CurAddr": "192.168.1.5:41641", "Relay": "sfo",
      "PeerRelay": "", "LastSeen": "0001-01-01T00:00:00Z"
    },
    "nodekey:b": {
      "ID": "nTagged", "UserID": 123, "Tags": ["tag:server"], "Online": false,
      "LastSeen": "2026-10-27T10:00:00Z", "Expired": true
    },
    "nodekey:c": { "ID": "nShared", "UserID": 456, "AltSharerUserID": 789 },
    "nodekey:d": { "ID": "nSharee", "UserID": 457, "ShareeNode": true },
    "nodekey:e": { "HostName": "no-id" },
    "nodekey:f": { "ID": "nOdd", "HostName": 7, "Online": "yes" }
  },
  "User": {
    "9007199254740993": { "ID": 9007199254740993, "LoginName": "theo@example.com" },
    "123": { "ID": 123, "LoginName": "tagged-devices" }
  }
}`;

// Shaped like `tailscale whois --json` on Tailscale 1.102.2 for an untagged owner node.
const whoisJson = (node: string = "", top: string = "") => `{
  "Node": {
    "ID": 42, "StableID": "nOwn", "Name": "studio.tail.ts.net.", "User": 9007199254740993,
    "Addresses": ["100.88.1.2/32"], "AllowedIPs": ["100.88.1.2/32"],
    "ComputedName": "studio", "Hostinfo": { "OS": "linux" }${node}
  },
  "UserProfile": { "ID": 9007199254740993, "LoginName": "theo@example.com", "DisplayName": "Theo" }${top}
}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

/**
 * A Serve daemon whose root a `serve --bg` write replaces. `racer` is another
 * server's target written just after each of ours.
 */
function layerServeFixture(
  rootProxy: string | null,
  listener: object = { HTTPS: true },
  extra: object = {},
  racer?: string,
) {
  const writes: Array<ReadonlyArray<string>> = [];
  let root = rootProxy;
  const layer = layerMockSpawner((_command, args) => {
    if (args.join(" ") === "serve status --json") {
      return {
        stdout: JSON.stringify({
          TCP: { "443": listener },
          Web: {
            "desktop.tail.ts.net:443": {
              Handlers: {
                ...(root === null ? {} : { "/": { Proxy: root } }),
                "/keep/": { Proxy: "http://127.0.0.1:8081" },
              },
            },
          },
          ...extra,
        }),
      };
    }
    writes.push(args);
    if (args.includes("--bg")) root = racer ?? args.at(-1)!;
    return {};
  });
  return { layer, writes };
}

/** A loopback port with a listener for the rest of the scope. */
const listenOnLoopback = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

const layerEnvironmentAnswer = (response: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
  );

describe("tailscale", () => {
  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        version: null,
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
        backendState: null,
        selfNodeId: null,
        selfUserId: null,
        selfTags: [],
        keyExpiry: null,
        keyExpired: false,
        health: [],
        magicDnsEnabled: null,
        tailnetName: null,
        certDomains: [],
        userspaceNetworking: null,
        peers: [],
        unidentifiedPeerAddresses: [],
        users: [],
      });
    }),
  );

  // `tailscale switch --list --json`, as Tailscale 1.94 prints it.
  it.effect("parses the selected login profile and every profile's ID", () =>
    Effect.gen(function* () {
      const profiles = yield* parseTailscaleProfiles(
        JSON.stringify([
          {
            id: "a1b2",
            nickname: "",
            tailnet: "example.com",
            account: "me@example.com",
            selected: false,
          },
          {
            id: "c3d4",
            nickname: "",
            tailnet: "me@gmail.com",
            account: "me@gmail.com",
            selected: true,
          },
        ]),
      );
      assert.deepEqual(profiles, {
        selected: { id: "c3d4", tailnet: "me@gmail.com", account: "me@gmail.com" },
        ids: ["a1b2", "c3d4"],
      });
    }),
  );

  // A policy scan must still count it, or a granted peer beside it would be hidden.
  it.effect("keeps the other peers when one cannot be read, and counts it unreadable", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(
        JSON.stringify({
          BackendState: "Running",
          Peer: {
            "nodekey:a": { ID: "nLaptop", TailscaleIPs: ["100.88.1.3"] },
            "nodekey:b": null,
          },
        }),
      );
      assert.deepEqual(
        status.peers.map((peer) => peer.stableNodeId),
        ["nLaptop"],
      );
      assert.deepEqual(status.unidentifiedPeerAddresses, [null]);
    }),
  );

  it.effect("parses host facts and peers, keeping user IDs past 2^53 exact", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(fullStatusJson);
      assert.deepInclude(status, {
        version: "1.102.2-t6cac91817-g1",
        backendState: "NeedsLogin",
        selfNodeId: "nSelf",
        selfUserId: "9007199254740993",
        selfTags: [],
        keyExpiry: "2026-12-23T01:09:33Z",
        health: ["Tailscale could not connect to the relay server."],
        magicDnsEnabled: true,
        tailnetName: "theo@",
        certDomains: ["desktop.tail.ts.net"],
        userspaceNetworking: true,
        httpsServeEnabled: true,
        users: [
          { userId: "123", loginName: "tagged-devices" },
          { userId: "9007199254740993", loginName: "theo@example.com" },
        ],
      });
      assert.deepEqual(
        status.peers.map((peer) => [peer.stableNodeId, peer.userId, peer.tags, peer.sharedIn]),
        [
          ["nOwn", "9007199254740993", [], false],
          ["nTagged", "123", ["tag:server"], false],
          ["nShared", "456", [], true],
          ["nSharee", "457", [], true],
          ["nOdd", null, [], false],
        ],
      );
      assert.deepEqual(status.peers[0], {
        stableNodeId: "nOwn",
        hostName: "studio",
        magicDnsName: "studio.tail.ts.net",
        os: "linux",
        tailnetIpv4Addresses: ["100.88.1.2"],
        tailnetIpv6Addresses: ["fd7a:115c:a1e0::2"],
        userId: "9007199254740993",
        tags: [],
        sharedIn: false,
        online: true,
        lastSeen: null,
        keyExpired: false,
        active: true,
        curAddr: "192.168.1.5:41641",
        relay: "sfo",
        peerRelay: null,
      });
      assert.deepInclude(status.peers[1], { online: false, keyExpired: true, active: false });
      // A field of an unexpected type reads as absent instead of failing the whole status.
      assert.deepInclude(status.peers[4], { hostName: null, online: false });
    }),
  );

  it.effect("names the exit node in use", () =>
    Effect.gen(function* () {
      const inUse = yield* parseTailscaleExitNode(
        JSON.stringify({
          ExitNodeStatus: { ID: "nX", Online: true, TailscaleIPs: ["100.101.102.103/32"] },
          Peer: {
            "nodekey:a": { HostName: "laptop", DNSName: "laptop.tail.ts.net.", ExitNode: false },
            "nodekey:b": {
              HostName: "raspberrypi",
              DNSName: "home-pi.tail.ts.net.",
              ExitNode: true,
            },
          },
        }),
      );
      assert.deepEqual(inUse, { name: "home-pi", online: true });

      const unnamed = yield* parseTailscaleExitNode(`{"ExitNodeStatus":{"Online":false}}`);
      assert.deepEqual(unnamed, { name: null, online: false });

      assert.equal(yield* parseTailscaleExitNode(tailscaleStatusJson), null);
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus("passive").pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus("passive").pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus("passive").pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  // regression: #21609 - without forceKillAfter a timed-out probe only gets
  // SIGTERM, so a group member that ignores it outlives the call.
  it.effect("escalates timed-out probes to SIGKILL", () => {
    const killGraces: Array<number | undefined> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const { forceKillAfter } = command.options;
          killGraces.push(
            forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter)),
          );
        }
        return Effect.succeed(mockHandle({ stdout: "{}" }));
      }),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus("passive").pipe(Effect.provide(layer));
      yield* readTailscaleSshEnabled.pipe(Effect.provide(layer));
      assert.deepEqual(killGraces, [500, 500]);
    });
  });

  it.effect("reads whois facts and treats omitted optional fields as empty", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const layer = layerMockSpawner((_command, args) => {
      calls.push(args);
      return { stdout: whoisJson() };
    });

    return Effect.gen(function* () {
      assert.deepEqual(yield* readTailscaleWhois("100.88.1.2").pipe(Effect.provide(layer)), {
        stableNodeId: "nOwn",
        userId: "9007199254740993",
        addresses: ["100.88.1.2/32"],
        allowedIps: ["100.88.1.2/32"],
        tags: [],
        primaryRoutes: [],
        sharerUserId: null,
        computedName: "studio",
        os: "linux",
        loginName: "theo@example.com",
        displayName: "Theo",
        capabilities: {},
      });
      assert.deepEqual(calls, [["whois", "--json", "--", "100.88.1.2"]]);

      const granted = yield* parseTailscaleWhois(
        whoisJson(
          "",
          `, "CapMap": { "t3.codes/cap/t3code": [{ "scopes": ["read"] }], "x/cap/y": null }`,
        ),
      );
      assert.deepEqual(granted.capabilities, {
        "t3.codes/cap/t3code": [{ scopes: ["read"] }],
        "x/cap/y": [],
      });

      const routerShared = yield* parseTailscaleWhois(
        whoisJson(`, "Tags": ["tag:server"], "PrimaryRoutes": ["10.0.0.0/24"], "Sharer": 77`),
      );
      assert.deepInclude(routerShared, {
        tags: ["tag:server"],
        primaryRoutes: ["10.0.0.0/24"],
        sharerUserId: "77",
      });
    });
  });

  it.effect("refuses whois output missing a required node field or with a malformed one", () =>
    Effect.gen(function* () {
      const node = (JSON.parse(whoisJson()) as { Node: Record<string, unknown> }).Node;
      for (const field of ["StableID", "User", "Addresses", "AllowedIPs"]) {
        const { [field]: _removed, ...rest } = node;
        const error = yield* parseTailscaleWhois(JSON.stringify({ Node: rest })).pipe(Effect.flip);
        assert.instanceOf(error, TailscaleWhoisParseError, field);
      }
      // Reading a malformed Tags as "no tags" would pass a tagged node as untagged.
      const malformedTags = yield* parseTailscaleWhois(whoisJson(`, "Tags": "tag:server"`)).pipe(
        Effect.flip,
      );
      assert.instanceOf(malformedTags, TailscaleWhoisParseError);
      // Grants decide access, so a malformed CapMap fails rather than reads as no grants.
      const malformedCapMap = yield* parseTailscaleWhois(whoisJson("", `, "CapMap": []`)).pipe(
        Effect.flip,
      );
      assert.instanceOf(malformedCapMap, TailscaleWhoisParseError);
    }),
  );

  it.effect("finds the macOS CLI outside PATH and keeps paths out of errors", () => {
    const appBundle = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    const attempt = (
      platform: NodeJS.Platform,
      installedAt: string | null,
      use: "passive" | "active" = "active",
    ) => {
      const tried: Array<{ readonly command: string; readonly beCli: string | undefined }> = [];
      const layer = Layer.merge(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
            tried.push({
              command: command.command,
              beCli: command.options.env?.["TS_BE_CLI"],
            });
            return command.command === installedAt
              ? Effect.succeed(mockHandle({ stdout: tailscaleStatusJson }))
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    pathOrDescriptor: command.command,
                  }),
                );
          }),
        ),
        Layer.succeed(HostProcess.Platform, platform),
      );
      return readTailscaleStatus(use).pipe(
        Effect.result,
        Effect.map((result) => ({ result, tried })),
        Effect.provide(layer),
      );
    };

    return Effect.gen(function* () {
      const found = yield* attempt("darwin", appBundle);
      assert.isTrue(Result.isSuccess(found.result));
      assert.deepEqual(found.tried, [
        { command: "tailscale", beCli: undefined },
        { command: "/usr/local/bin/tailscale", beCli: undefined },
        { command: "/opt/homebrew/bin/tailscale", beCli: undefined },
        { command: appBundle, beCli: "1" },
      ]);
      // A passive read never spawns the app bundle, which can raise a macOS data-access prompt.
      const passive = yield* attempt("darwin", appBundle, "passive");
      assert.isTrue(Result.isFailure(passive.result));
      assert.notInclude(
        passive.tried.map((entry) => entry.command),
        appBundle,
      );

      const missing = yield* attempt("darwin", null);
      assert.isTrue(Result.isFailure(missing.result));
      if (Result.isFailure(missing.result)) {
        const error = missing.result.failure;
        assert.instanceOf(error, TailscaleCommandSpawnError);
        assert.equal(error.executable, "tailscale");
        assert.notInclude(error.message, "/");
      }

      const linux = yield* attempt("linux", null);
      assert.deepEqual(
        linux.tried.map((entry) => entry.command),
        ["tailscale"],
      );
    });
  });

  it.effect("counts a Serve URL as reachable only when it answers as this environment", () =>
    Effect.gen(function* () {
      const probe = (response: () => Response) =>
        probeTailscaleHttpsEndpoint({
          baseUrl: "https://desktop.tail.ts.net/",
          environmentId: "this-server",
        }).pipe(Effect.provide(layerEnvironmentAnswer(response)));

      const descriptor = (environmentId: string) =>
        new Response(JSON.stringify({ environmentId, label: "desktop" }));
      assert.isTrue(yield* probe(() => descriptor("this-server")));
      assert.isFalse(yield* probe(() => descriptor("other-server")));
      assert.isFalse(yield* probe(() => new Response("<html>proxy</html>")));
      assert.isFalse(yield* probe(() => new Response(null, { status: 502 })));
    }),
  );

  it.live("leaves a Serve root that fronts another running server in place", () =>
    Effect.gen(function* () {
      const runningPort = yield* listenOnLoopback;
      const fixture = layerServeFixture(`http://127.0.0.1:${runningPort}`);

      const claimed = yield* claimTailscaleServe({ localPort: 3774 }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, []);
      assert.isTrue(
        Result.isFailure(claimed) && claimed.failure._tag === "TailscaleServeOccupiedError",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("leaves Funnel, plain HTTP, foreground and ambiguous hostname mappings untouched", () =>
    Effect.gen(function* () {
      for (const [listener, extra] of [
        [{ HTTP: true }, {}],
        [{ HTTPS: true }, { AllowFunnel: { "desktop.tail.ts.net:443": true } }],
        [
          { HTTPS: true },
          {
            Web: {
              "old.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
              "desktop.tail.ts.net:443": {
                Handlers: { "/": { Proxy: "http://another-server:3774" } },
              },
            },
          },
        ],
        [
          { HTTPS: true },
          {
            Foreground: {
              session: {
                TCP: { "443": { HTTPS: true } },
                Web: {
                  "desktop.tail.ts.net:443": {
                    Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
                  },
                },
              },
            },
          },
        ],
      ] as const) {
        const fixture = layerServeFixture(null, listener, extra);
        const claimed = yield* claimTailscaleServe({ localPort: 3773 }).pipe(
          Effect.result,
          Effect.provide(fixture.layer),
        );
        assert.isTrue(
          Result.isFailure(claimed) && claimed.failure._tag === "TailscaleServeOccupiedError",
        );
        assert.isFalse(
          yield* releaseTailscaleServe({ localPort: 3773 }).pipe(Effect.provide(fixture.layer)),
        );
        assert.deepEqual(fixture.writes, []);
      }
    }),
  );

  it.effect("claims a free Serve port and does not write when Serve status is unreadable", () =>
    Effect.gen(function* () {
      for (const [stdout, claims] of [
        ["null\n", true],
        ["{}", true],
        ["", false],
        ["not-json", false],
      ] as const) {
        const writes: Array<ReadonlyArray<string>> = [];
        let status: string = stdout;
        const layer = layerMockSpawner((_command, args) => {
          if (args.join(" ") === "serve status --json") return { stdout: status };
          writes.push(args);
          status = JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: { "desktop.tail.ts.net:443": { Handlers: { "/": { Proxy: args.at(-1) } } } },
          });
          return {};
        });
        const claimed = yield* claimTailscaleServe({ localPort: 3773 }).pipe(
          Effect.result,
          Effect.provide(layer),
        );
        if (claims) {
          assert.isTrue(Result.isSuccess(claimed), stdout);
          assert.deepEqual(writes, [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]]);
        } else {
          assert.isTrue(
            Result.isFailure(claimed) && claimed.failure._tag === "TailscaleStatusParseError",
          );
          const released = yield* releaseTailscaleServe({ localPort: 3773 }).pipe(
            Effect.flip,
            Effect.provide(layer),
          );
          assert.instanceOf(released, TailscaleStatusParseError);
          assert.deepEqual(writes, []);
        }
      }
    }),
  );

  it.live("replaces a Serve root left behind by a stopped server", () =>
    Effect.gen(function* () {
      const stoppedPort = yield* Effect.scoped(listenOnLoopback);
      const fixture = layerServeFixture(`http://127.0.0.1:${stoppedPort}`);

      yield* claimTailscaleServe({ localPort: 3773 }).pipe(Effect.provide(fixture.layer));
      assert.deepEqual(fixture.writes, [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]]);
    }),
  );

  it.effect("reports a Serve port another server wrote at the same time as occupied", () =>
    Effect.gen(function* () {
      const fixture = layerServeFixture(null, { HTTPS: true }, {}, "http://127.0.0.1:3774");
      const claimed = yield* claimTailscaleServe({ localPort: 3773 }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.isTrue(
        Result.isFailure(claimed) && claimed.failure._tag === "TailscaleServeOccupiedError",
      );
    }),
  );

  it.effect("removes only its own Serve root on release", () => {
    const fixture = layerServeFixture("http://127.0.0.1:3773");

    return Effect.gen(function* () {
      const releasedOther = yield* releaseTailscaleServe({ localPort: 3774 }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, []);
      assert.isFalse(releasedOther);

      const releasedOwn = yield* releaseTailscaleServe({ localPort: 3773 }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, [["serve", "--https=443", "--set-path=/", "off"]]);
      assert.isTrue(releasedOwn);
    });
  });
});
