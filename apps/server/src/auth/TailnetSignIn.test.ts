// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, TAILNET_APP_CAPABILITY } from "@t3tools/contracts";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { parseTailscaleStatus, parseTailscaleWhois } from "@t3tools/tailscale";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as TailnetSignIn from "./TailnetSignIn.ts";

// 2^53 + 1 and 2^53: equal as JS numbers, different Tailscale users.
const OWNER_ID = "9007199254740993";
const NEIGHBOR_ID = "9007199254740992";
const HOST_ADDRESS = "100.100.1.1";
const PHONE_ADDRESS = "100.88.1.2";

type JsonObject = Record<string, unknown>;

// Writes user IDs as bare int64 digits, the way Tailscale does.
const tailscaleJson = (value: JsonObject) => JSON.stringify(value).replace(/"int64:(\d+)"/gu, "$1");

const hostStatus = (overrides: JsonObject = {}) => ({
  Version: "1.102.2-t6cac91817",
  BackendState: "Running",
  TUN: true,
  Self: {
    ID: "nBox",
    UserID: `int64:${OWNER_ID}`,
    DNSName: "box.tail.ts.net.",
    TailscaleIPs: [HOST_ADDRESS],
  },
  ...overrides,
});

const phoneNode = (overrides: JsonObject = {}): JsonObject => ({
  StableID: "nPhone",
  User: `int64:${OWNER_ID}`,
  Addresses: [`${PHONE_ADDRESS}/32`],
  AllowedIPs: [`${PHONE_ADDRESS}/32`],
  ComputedName: "phone",
  ...overrides,
});

/** What `tailscale status` and `tailscale whois` print; a test may change it between calls. */
interface Tailnet {
  status: JsonObject;
  node: JsonObject | null;
  /** The whois `CapMap`: the app capabilities grants give the device. */
  capMap?: JsonObject;
  /** The login whois reports for `node`. */
  loginName?: string;
  /** Other devices whois answers for, by address. */
  devices?: Record<string, { readonly node: JsonObject | null; readonly capMap?: JsonObject }>;
  /** Holds the next whois for `address` after it reads the tailnet, until `release`. */
  hold?: {
    readonly address: string;
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

/** A whois `CapMap` with these T3 Code grant values. */
const granted = (...values: ReadonlyArray<unknown>): JsonObject => ({
  [TAILNET_APP_CAPABILITY]: values,
});

const layerTailscaleHost = (tailnet: Tailnet) =>
  Layer.succeed(
    TailscaleHost.TailscaleHost,
    TailscaleHost.TailscaleHost.of({
      inUse: Effect.succeed(true),
      status: Effect.suspend(() => parseTailscaleStatus(tailscaleJson(tailnet.status))),
      whois: (address) =>
        Effect.gen(function* () {
          const device = tailnet.devices?.[address] ?? {
            node: tailnet.node,
            capMap: tailnet.capMap,
          };
          const json =
            device.node === null
              ? "{}"
              : tailscaleJson({
                  Node: device.node,
                  CapMap: device.capMap ?? null,
                  ...(tailnet.loginName === undefined || tailnet.devices?.[address] !== undefined
                    ? {}
                    : { UserProfile: { LoginName: tailnet.loginName } }),
                });
          const hold = tailnet.hold;
          if (hold?.address === address) {
            delete tailnet.hold;
            yield* Deferred.succeed(hold.started, undefined);
            yield* Deferred.await(hold.release);
          }
          return yield* parseTailscaleWhois(json);
        }),
    }),
  );

const layerTest = (
  tailnet: Tailnet,
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
) =>
  TailnetSignIn.layer.pipe(
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerTailscaleHost(tailnet)),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({ ...config, tailscaleSignInEnabled: true, ...overrides })),
        ),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-test-" }))),
    ),
  );

/** What `t3 tailscale require-grant on` writes. */
const requireGrantOn = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  yield* fs.writeFileString(`${config.stateDir}/${TailnetSignIn.REQUIRE_GRANT_FILE}`, "test\n");
});

const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let proofCount = 0;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: (url: string, iat: number) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encode({ htm: "POST", htu: url, jti: `proof-${++proofCount}`, iat });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

interface RequestShape {
  readonly origin?: string;
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly localAddress?: string;
  readonly dpop?: boolean;
}

const signInRequest = Effect.fn("test.signInRequest")(function* (
  key: ReturnType<typeof makeDpopKey>,
  shape: RequestShape = {},
) {
  const host = shape.host ?? `${HOST_ADDRESS}:3773`;
  const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
  return {
    method: "POST",
    url: "/api/auth/tailnet",
    originalUrl: "/api/auth/tailnet",
    cookies: {},
    headers: {
      host,
      ...(shape.origin === undefined ? {} : { origin: shape.origin }),
      ...(shape.dpop === false ? {} : { dpop: key.sign(`http://${host}/api/auth/tailnet`, iat) }),
    },
    source: {
      socket: {
        remoteAddress: shape.remoteAddress ?? PHONE_ADDRESS,
        localAddress: shape.localAddress ?? HOST_ADDRESS,
        localPort: 3773,
      },
    },
  } as unknown as HttpServerRequest.HttpServerRequest;
});

const signIn = (key: ReturnType<typeof makeDpopKey>, shape?: RequestShape) =>
  Effect.gen(function* () {
    const service = yield* TailnetSignIn.TailnetSignIn;
    return yield* service.signIn(yield* signInRequest(key, shape));
  });

const exchange = (credential: string, key: ReturnType<typeof makeDpopKey>) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.exchangeBootstrapCredentialForAccessToken(
      credential,
      undefined,
      { deviceType: "mobile" },
      { proofKeyThumbprint: key.thumbprint },
    );
  });

const isRefusal = Schema.is(TailnetSignIn.TailnetSignInRefusedError);

/** The refusal reason, or the tag of any other failure. */
const refusalOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error): string => (isRefusal(error) ? error.reason : error._tag)),
  );

it.layer(NodeServices.layer)("TailnetSignIn", (it) => {
  it.effect.each<{
    readonly name: string;
    readonly request?: RequestShape;
    readonly status?: JsonObject;
    readonly node?: JsonObject | null;
    readonly capMap?: JsonObject;
    readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
    readonly requireGrant?: boolean;
    readonly refused: string;
  }>([
    { name: "sign-in is off", config: { tailscaleSignInEnabled: false }, refused: "disabled" },
    { name: "Origin is null", request: { origin: "null" }, refused: "browser_request" },
    {
      name: "a web page asks",
      request: { origin: "https://evil.example" },
      refused: "browser_request",
    },
    {
      name: "Host is a rebound name",
      request: { host: "evil.example:3773" },
      refused: "browser_request",
    },
    {
      name: "Host names another port",
      request: { host: HOST_ADDRESS },
      refused: "browser_request",
    },
    {
      name: "the peer is not on the tailnet",
      request: { remoteAddress: "192.168.1.5" },
      refused: "not_direct_tailnet",
    },
    {
      name: "the request comes through Serve or Funnel",
      request: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
      refused: "not_direct_tailnet",
    },
    {
      name: "it arrives on the LAN interface",
      request: { localAddress: "192.168.1.20" },
      refused: "not_direct_tailnet",
    },
    {
      name: "the proof is missing",
      request: { dpop: false },
      refused: "ServerAuthInvalidCredentialError",
    },
    {
      name: "Tailscale uses userspace networking",
      status: hostStatus({ TUN: false }),
      refused: "tailscale_unavailable",
    },
    {
      name: "Tailscale is too old",
      status: hostStatus({ Version: "1.62.0" }),
      refused: "tailscale_outdated",
    },
    {
      name: "the host is tagged with no owner set",
      status: hostStatus({
        Self: { ID: "nBox", Tags: ["tag:server"], TailscaleIPs: [HOST_ADDRESS] },
      }),
      refused: "owner_unknown",
    },
    {
      name: "the device is tagged",
      node: phoneNode({ Tags: ["tag:ci"] }),
      refused: "tagged_device",
    },
    {
      name: "the device is shared in",
      node: phoneNode({ Sharer: "int64:555" }),
      refused: "shared_device",
    },
    {
      name: "it is this host's own node",
      node: phoneNode({ StableID: "nBox" }),
      refused: "own_node",
    },
    {
      name: "another user owns the device",
      node: phoneNode({ User: `int64:${NEIGHBOR_ID}` }),
      refused: "other_user",
    },
    {
      name: "the device is a subnet router",
      node: phoneNode({
        AllowedIPs: [`${PHONE_ADDRESS}/32`, "192.168.1.0/24"],
        PrimaryRoutes: ["192.168.1.0/24"],
      }),
      refused: "routes_for_others",
    },
    {
      name: "the host requires a grant and the owner's device has none",
      requireGrant: true,
      refused: "no_grant",
    },
    {
      name: "the device's grant names no scope T3 Code knows",
      capMap: granted({ scopes: ["sudo"] }),
      refused: "grant_unusable",
    },
    {
      name: "the policy grants a subnet router",
      node: phoneNode({
        AllowedIPs: [`${PHONE_ADDRESS}/32`, "192.168.1.0/24"],
        PrimaryRoutes: ["192.168.1.0/24"],
      }),
      capMap: granted({ scopes: ["standard"] }),
      refused: "routes_for_others",
    },
    {
      name: "the device's grant has no value",
      capMap: granted(),
      refused: "grant_unusable",
    },
    {
      name: "the device's grant names inherited object keys",
      capMap: granted({ scopes: ["__proto__", "constructor", "toString"] }),
      refused: "grant_unusable",
    },
    {
      name: "a grant reaches the host's own node",
      node: phoneNode({ StableID: "nBox" }),
      capMap: granted({ scopes: ["standard"] }),
      refused: "own_node",
    },
    {
      name: "whois leaves out a required field",
      node: { StableID: "nPhone", User: `int64:${OWNER_ID}`, Addresses: [`${PHONE_ADDRESS}/32`] },
      refused: "tailscale_unavailable",
    },
  ])("refuses when $name", ({ request, status, node, capMap, config, requireGrant, refused }) =>
    Effect.gen(function* () {
      if (requireGrant === true) yield* requireGrantOn;
      expect(yield* refusalOf(signIn(makeDpopKey(), request))).toBe(refused);
    }).pipe(
      Effect.provide(
        layerTest(
          {
            status: status ?? hostStatus(),
            node: node ?? phoneNode(),
            ...(capMap === undefined ? {} : { capMap }),
          },
          config,
        ),
      ),
    ),
  );

  const READ_SCOPES = [
    "orchestration:read",
    "diagnostics:read",
    "terminal:read",
    "filesystem:read",
    "access:read",
    "relay:read",
  ];
  // A standard grant cannot manage access or the T3 Connect link, so it cannot let in a device
  // the policy does not name.
  const STANDARD_GRANT_SCOPES = AuthStandardClientScopes.filter(
    (scope) => scope !== "access:write" && scope !== "relay:write",
  );
  const TAGGED_HOST = hostStatus({
    Self: { ID: "nBox", Tags: ["tag:t3-box"], TailscaleIPs: [HOST_ADDRESS] },
  });

  it.effect.each<{
    readonly name: string;
    readonly request?: RequestShape;
    readonly status?: JsonObject;
    readonly node?: JsonObject;
    readonly capMap?: JsonObject;
    readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
    readonly requireGrant?: boolean;
    readonly scopes?: ReadonlyArray<string>;
  }>([
    { name: "a native app" },
    {
      name: "a tagged device the policy grants",
      node: phoneNode({ Tags: ["tag:ci"] }),
      capMap: granted({ scopes: ["standard"] }),
      scopes: STANDARD_GRANT_SCOPES,
    },
    { name: "a device the policy grants admin", capMap: granted({ scopes: ["admin"] }) },
    {
      name: "another user's device the policy grants read-only access",
      node: phoneNode({ User: `int64:${NEIGHBOR_ID}` }),
      capMap: granted({ scopes: ["read"] }),
      scopes: READ_SCOPES,
    },
    {
      name: "a granted device on a tagged host with no owner, which requires grants",
      status: TAGGED_HOST,
      capMap: granted({ scopes: ["orchestration:read"] }, { scopes: ["read", "nope"] }),
      requireGrant: true,
      scopes: READ_SCOPES,
    },
    {
      name: "an exit node",
      node: phoneNode({ AllowedIPs: [`${PHONE_ADDRESS}/32`, "0.0.0.0/0", "::/0"] }),
    },
    { name: "the desktop renderer", request: { origin: "t3code://app" } },
    { name: "an IPv4-mapped peer address", request: { remoteAddress: `::ffff:${PHONE_ADDRESS}` } },
    { name: "the MagicDNS name", request: { host: "box.tail.ts.net:3773" } },
  ])(
    "signs in $name, and the exchange makes a tailnet session",
    ({ request, status, node, capMap, config, requireGrant, scopes }) =>
      Effect.gen(function* () {
        if (requireGrant === true) yield* requireGrantOn;
        const key = makeDpopKey();
        const grant = yield* signIn(key, request);
        const token = yield* exchange(grant.credential, key);
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* sessions.verify(token.access_token);
        expect(session).toMatchObject({
          subject: "tailscale:nPhone",
          method: "dpop-access-token",
          proofKeyThumbprint: key.thumbprint,
        });
        expect(session.scopes).toEqual(scopes ?? AuthStandardClientScopes);
      }).pipe(
        Effect.provide(
          layerTest(
            {
              status: status ?? hostStatus(),
              node: node ?? phoneNode(),
              ...(capMap === undefined ? {} : { capMap }),
            },
            config,
          ),
        ),
      ),
  );

  it.effect("a Tailscale session gets exactly its grant's scopes, never a narrower request", () =>
    Effect.gen(function* () {
      const key = makeDpopKey();
      const grant = yield* signIn(key);
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const narrowed = auth.exchangeBootstrapCredentialForAccessToken(
        grant.credential,
        ["orchestration:read"],
        { deviceType: "mobile" },
        { proofKeyThumbprint: key.thumbprint },
      );
      expect(yield* refusalOf(narrowed)).toBe("ServerAuthScopeNotGrantedError");
    }).pipe(Effect.provide(layerTest({ status: hostStatus(), node: phoneNode() }))),
  );

  it.effect("a shared-in device's suggested grant names its address, not its login", () =>
    Effect.gen(function* () {
      yield* requireGrantOn;
      const error = yield* Effect.flip(signIn(makeDpopKey()));
      expect(isRefusal(error) ? error.suggestedGrant : error).toContain(
        `"src": ["${PHONE_ADDRESS}"]`,
      );
    }).pipe(
      Effect.provide(
        layerTest({
          status: hostStatus(),
          node: phoneNode({ Sharer: "int64:555" }),
          loginName: "friend@other.example",
        }),
      ),
    ),
  );

  it.effect("signs in the configured owner's device on a tagged host", () =>
    Effect.gen(function* () {
      const grant = yield* signIn(makeDpopKey());
      expect(grant.credential).toBeTruthy();
    }).pipe(
      Effect.provide(
        layerTest(
          {
            status: hostStatus({
              Self: { ID: "nBox", Tags: ["tag:server"], TailscaleIPs: [HOST_ADDRESS] },
            }),
            node: phoneNode(),
          },
          { tailscaleOwnerUserId: OWNER_ID },
        ),
      ),
    ),
  );

  it.effect("reruns every check on renewal", () => {
    const tailnet: Tailnet = { status: hostStatus(), node: phoneNode() };
    return Effect.gen(function* () {
      const key = makeDpopKey();
      yield* signIn(key);
      tailnet.node = phoneNode({ Tags: ["tag:agents"] });
      expect(yield* refusalOf(signIn(key))).toBe("tagged_device");
      // A grant lets the tagged device in, and after that grants decide here.
      tailnet.capMap = granted({ scopes: ["standard"] });
      yield* signIn(key);
      delete tailnet.capMap;
      expect(yield* refusalOf(signIn(key))).toBe("no_grant");
      tailnet.node = null;
      expect(yield* refusalOf(signIn(key))).toBe("tailscale_unavailable");
    }).pipe(Effect.provide(layerTest(tailnet)));
  });

  describe("once the policy grants T3 Code here", () => {
    const LAPTOP_ADDRESS = "100.88.1.3";
    const laptop = phoneNode({
      StableID: "nLaptop",
      Addresses: [`${LAPTOP_ADDRESS}/32`],
      AllowedIPs: [`${LAPTOP_ADDRESS}/32`],
      ComputedName: "laptop",
    });
    const peers = {
      phone: { ID: "nPhone", TailscaleIPs: [PHONE_ADDRESS], UserID: `int64:${OWNER_ID}` },
      laptop: { ID: "nLaptop", TailscaleIPs: [LAPTOP_ADDRESS], UserID: `int64:${OWNER_ID}` },
    };
    const withLaptop = (capMap?: JsonObject): Tailnet => ({
      status: hostStatus({ Peer: peers }),
      node: phoneNode(),
      devices: { [LAPTOP_ADDRESS]: { node: laptop, ...(capMap === undefined ? {} : { capMap }) } },
    });
    const revoked = (token: string) =>
      SessionStore.SessionStore.pipe(
        Effect.flatMap((sessions) => sessions.verify(token)),
        Effect.match({
          onFailure: (error) => error._tag === "SessionTokenRevokedError",
          onSuccess: () => false,
        }),
      );
    const signInLaptop = (key: ReturnType<typeof makeDpopKey>) =>
      signIn(key, { remoteAddress: LAPTOP_ADDRESS }).pipe(
        Effect.flatMap((grant) => exchange(grant.credential, key)),
      );

    it.effect("the owner's devices without a grant are refused before anyone signs in", () =>
      Effect.gen(function* () {
        expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("no_grant");
      }).pipe(Effect.provide(layerTest(withLaptop(granted({ scopes: ["standard"] }))))),
    );

    it.effect(
      "a granted peer that Tailscale lists with no ID still turns the owner rule off",
      () => {
        const { ID: _, ...unidentified } = peers.laptop;
        const tailnet = withLaptop(granted({ scopes: ["standard"] }));
        tailnet.status = hostStatus({ Peer: { ...peers, laptop: unidentified } });
        return Effect.gen(function* () {
          expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("no_grant");
        }).pipe(Effect.provide(layerTest(tailnet)));
      },
    );

    it.effect("turning sign-in off ends Tailscale sessions at the next start", () => {
      const tailnet = withLaptop();
      return Effect.gen(function* () {
        const key = makeDpopKey();
        const session = yield* exchange((yield* signIn(key)).credential, key);
        const unusedKey = makeDpopKey();
        // The laptop has a sign-in code but no session yet.
        const unused = yield* signIn(unusedKey, { remoteAddress: LAPTOP_ADDRESS });
        const config = yield* ServerConfig.ServerConfig;
        yield* TailnetSignIn.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            tailscaleSignInEnabled: false,
          }),
          Effect.provide(layerTailscaleHost(tailnet)),
          Effect.scoped,
        );
        expect(yield* revoked(session.access_token)).toBe(true);
        // A sign-in code not yet exchanged cannot bring the device back.
        expect((yield* Effect.exit(exchange(unused.credential, unusedKey)))._tag).toBe("Failure");
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect("a device that loses or narrows its grant, or leaves, is cut off", () => {
      const tailnet = withLaptop();
      return Effect.gen(function* () {
        const service = yield* TailnetSignIn.TailnetSignIn;
        const phoneKey = makeDpopKey();
        const phone = yield* exchange((yield* signIn(phoneKey)).credential, phoneKey);

        // The first sign-in through a grant ends the owner rule without waiting for a scan.
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        const laptopKey = makeDpopKey();
        const standard = yield* signInLaptop(laptopKey);
        yield* service.recheckSessions;
        expect(yield* revoked(phone.access_token)).toBe(true);

        // A changed grant ends each session it no longer matches, narrower or wider.
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["read"] }) },
        };
        yield* service.recheckSessions;
        expect(yield* revoked(standard.access_token)).toBe(true);
        const read = yield* signInLaptop(laptopKey);
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        const widened = yield* signInLaptop(laptopKey);
        yield* service.recheckSessions;
        expect(yield* revoked(read.access_token)).toBe(true);
        expect(yield* revoked(widened.access_token)).toBe(false);

        // Removing the grant ends the session and the sign-in not yet exchanged.
        const pending = yield* signIn(laptopKey, { remoteAddress: LAPTOP_ADDRESS });
        tailnet.devices = { [LAPTOP_ADDRESS]: { node: laptop } };
        yield* service.recheckSessions;
        expect(yield* revoked(widened.access_token)).toBe(true);
        expect(yield* refusalOf(exchange(pending.credential, laptopKey))).toBe(
          "ServerAuthInvalidCredentialError",
        );

        // So does leaving the tailnet, but a Tailscale that is starting proves nothing.
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["read"] }) },
        };
        const last = yield* signInLaptop(laptopKey);
        tailnet.status = hostStatus({ BackendState: "Starting" });
        yield* service.recheckSessions;
        expect(yield* revoked(last.access_token)).toBe(false);
        tailnet.status = hostStatus({ Peer: { phone: peers.phone } });
        yield* service.recheckSessions;
        expect(yield* revoked(last.access_token)).toBe(true);
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect("an unused sign-in is revoked with its grant, even with no session", () => {
      // Tagged, so the owner rule cannot let it back in once the grant is gone.
      const ciBox = { ...laptop, Tags: ["tag:ci"] };
      const tailnet: Tailnet = {
        ...withLaptop(),
        devices: { [LAPTOP_ADDRESS]: { node: ciBox, capMap: granted({ scopes: ["standard"] }) } },
      };
      return Effect.gen(function* () {
        const service = yield* TailnetSignIn.TailnetSignIn;
        const key = makeDpopKey();
        const pending = yield* signIn(key, { remoteAddress: LAPTOP_ADDRESS });
        tailnet.devices = { [LAPTOP_ADDRESS]: { node: ciBox } };
        yield* service.recheckSessions;
        expect(yield* refusalOf(exchange(pending.credential, key))).toBe(
          "ServerAuthInvalidCredentialError",
        );
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect("removing every grant lets the owner's devices back in after the next scan", () => {
      const tailnet = withLaptop();
      return Effect.gen(function* () {
        // A scan that found no grants is cached when the laptop's grant appears and is used.
        yield* signIn(makeDpopKey());
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        yield* signInLaptop(makeDpopKey());
        expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("no_grant");
        tailnet.devices = { [LAPTOP_ADDRESS]: { node: laptop } };
        yield* TestClock.adjust("5 minutes");
        yield* signIn(makeDpopKey());
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    // Switching Tailscale accounts switches tailnets, so the last account's scan says nothing.
    it.effect("after a switch to another Tailscale account, its own policy decides at once", () => {
      const tailnet = withLaptop();
      return Effect.gen(function* () {
        yield* signIn(makeDpopKey());
        tailnet.status = hostStatus({
          Peer: peers,
          Self: { ...hostStatus().Self, ID: "nBoxAtWork" },
        });
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("no_grant");
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect("with no node ID for this host, the owner rule does not apply", () => {
      const { ID: _, ...self } = hostStatus().Self;
      const tailnet = withLaptop();
      tailnet.status = hostStatus({ Peer: peers, Self: self });
      return Effect.gen(function* () {
        expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("policy_unknown");
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect("a grant sign-in during a scan that finds no grants keeps the owner rule off", () => {
      const tailnet = withLaptop();
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // The scan reads the laptop with no grant, then waits while the grant lands and is used.
        tailnet.hold = { address: LAPTOP_ADDRESS, started, release };
        const phone = yield* refusalOf(signIn(makeDpopKey())).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        yield* signInLaptop(makeDpopKey());
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(phone)).toBe("no_grant");
      }).pipe(Effect.provide(layerTest(tailnet)));
    });

    it.effect(
      "a peer whois cannot read reuses the last full scan for five minutes, then fails closed",
      () => {
        const tailnet = withLaptop();
        return Effect.gen(function* () {
          yield* signIn(makeDpopKey());
          tailnet.devices = { [LAPTOP_ADDRESS]: { node: null } };
          yield* TestClock.adjust("270 seconds");
          yield* signIn(makeDpopKey());
          yield* TestClock.adjust("30 seconds");
          expect(yield* refusalOf(signIn(makeDpopKey()))).toBe("policy_unknown");
        }).pipe(Effect.provide(layerTest(tailnet)));
      },
    );

    it.effect("a device whois cannot read keeps access for two minutes, then loses it", () => {
      const tailnet = withLaptop(granted({ scopes: ["standard"] }));
      return Effect.gen(function* () {
        const service = yield* TailnetSignIn.TailnetSignIn;
        const session = yield* signInLaptop(makeDpopKey());
        tailnet.devices = { [LAPTOP_ADDRESS]: { node: null } };
        yield* service.recheckSessions;
        expect(yield* revoked(session.access_token)).toBe(false);
        yield* TestClock.adjust("2 minutes");
        yield* service.recheckSessions;
        expect(yield* revoked(session.access_token)).toBe(true);

        // A Tailscale that stays down vouches for no one past the same grace period.
        tailnet.devices = {
          [LAPTOP_ADDRESS]: { node: laptop, capMap: granted({ scopes: ["standard"] }) },
        };
        const next = yield* signInLaptop(makeDpopKey());
        tailnet.status = hostStatus({ BackendState: "Stopped" });
        yield* service.recheckSessions;
        expect(yield* revoked(next.access_token)).toBe(false);
        yield* TestClock.adjust("2 minutes");
        yield* service.recheckSessions;
        expect(yield* revoked(next.access_token)).toBe(true);
      }).pipe(Effect.provide(layerTest(tailnet)));
    });
  });

  it.effect("blocking ends live sessions and refuses a grant minted before the block", () =>
    Effect.gen(function* () {
      const service = yield* TailnetSignIn.TailnetSignIn;
      const sessions = yield* SessionStore.SessionStore;
      const key = makeDpopKey();
      const live = yield* exchange((yield* signIn(key)).credential, key);
      const pending = yield* signIn(key);

      expect(yield* service.blockDevice("nPhone")).toBe(1);
      expect((yield* Effect.flip(sessions.verify(live.access_token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect(yield* refusalOf(exchange(pending.credential, key))).toBe(
        "ServerAuthInvalidCredentialError",
      );
      expect(yield* refusalOf(signIn(key))).toBe("blocked");
      expect(yield* service.listDevices("tailscale:nPhone")).toMatchObject([
        { stableNodeId: "nPhone", label: "phone", activeSessionCount: 0, current: true },
      ]);

      expect(yield* service.unblockDevice("nPhone")).toBe(true);
      const renewed = yield* exchange((yield* signIn(key)).credential, key);
      expect((yield* sessions.verify(renewed.access_token)).subject).toBe("tailscale:nPhone");
      expect(yield* service.listDevices("bearer:laptop")).toMatchObject([
        { stableNodeId: "nPhone", blockedAt: null, activeSessionCount: 1, current: false },
      ]);
    }).pipe(Effect.provide(layerTest({ status: hostStatus(), node: phoneNode() }))),
  );
});
