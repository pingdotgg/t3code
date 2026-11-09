import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  TAILNET_DEVICE_CAPABILITY,
} from "@t3tools/contracts";
import type { Tailnet, TailnetWhois } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { describe, expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DevicePolicy from "./DevicePolicy.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf } from "./PeerLinks.testkit.ts";
import * as TailnetDevices from "./TailnetDevices.ts";
import * as TailnetDevicesHttp from "./tailnetDevicesHttp.ts";
import * as TailnetIdentity from "./TailnetIdentity.ts";

class DeviceTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.tailnetDevices) {}

const OWNER = "1001";

interface Node {
  readonly address: string;
  readonly whois: TailnetWhois;
}

/**
 * The tailnet as Tailscale reports it: which node owns each address. Devices
 * run on loopback, so each origin is mapped to the tailnet address a real
 * MagicDNS name or IP would reach.
 */
const makeTailnet = Effect.gen(function* () {
  const byOrigin = yield* Ref.make(new Map<string, Node>());
  const identityFor = (selfUserId: string) =>
    Layer.succeed(TailnetIdentity.TailnetIdentity, {
      read: Effect.succeedSome<Tailnet>({
        self: {
          userId: selfUserId,
          magicDnsName: null,
          tailnetAddresses: [],
          httpsServeEnabled: true,
        },
        peers: [],
      }),
      locate: (url) => {
        const origin = URL.parse(url)?.origin;
        const node = origin === undefined ? undefined : Ref.getUnsafe(byOrigin).get(origin);
        return node === undefined
          ? Option.none()
          : Option.some({ origin: origin!, address: node.address });
      },
      whois: (address) =>
        Ref.get(byOrigin).pipe(
          Effect.map((nodes) =>
            Option.fromNullishOr(
              [...nodes.values()].find((node) => node.address === address)?.whois,
            ),
          ),
        ),
      probeUrls: () => [],
    });
  const join = (origin: string, whois: Partial<TailnetWhois> = {}) =>
    Ref.update(byOrigin, (nodes) => {
      const address = `100.64.0.${nodes.size + 1}`;
      return new Map(nodes).set(origin, {
        address,
        whois: {
          userId: OWNER,
          loginName: "owner@example.com",
          nodeName: `node-${nodes.size + 1}`,
          tags: [],
          capabilities: [],
          ...whois,
        },
      });
    });
  return { identityFor, join };
});

type FakeTailnet = Effect.Success<typeof makeTailnet>;

/** One T3 server on the tailnet: its own database, auth and links, answering on a socket of its own. */
const serveDevice = (
  descriptor: ExecutionEnvironmentDescriptor,
  tailnet: FakeTailnet,
  options: { readonly userId?: string } = {},
) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      serveDeviceOn(descriptor, tailnet, options).pipe(Effect.provideContext(server)),
    ),
  );

const serveDeviceOn = (
  descriptor: ExecutionEnvironmentDescriptor,
  tailnet: FakeTailnet,
  options: { readonly userId?: string } = {},
) =>
  Effect.gen(function* () {
    const url = yield* Ref.make("http://127.0.0.1:0");
    const grants = yield* Ref.make(0);
    const context = yield* TailnetDevices.layer.pipe(
      Layer.provideMerge(PeerLinks.layer),
      Layer.provideMerge(EnvironmentAuth.layer),
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provide(tailnet.identityFor(options.userId ?? OWNER)),
      Layer.provide(
        Layer.effect(
          DirectEndpoints.DirectEndpoints,
          Effect.sync(() => {
            const resolve = () =>
              Ref.get(url).pipe(
                Effect.map((origin) => [{ kind: "tailnet" as const, httpBaseUrl: `${origin}/` }]),
              );
            return { resolve, resolveAvailable: resolve };
          }),
        ),
      ),
      Layer.provideMerge(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-device-" })),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.fresh,
      Layer.build,
    );
    const countGrants = HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/api/tailnet-devices/grant")) {
            yield* Ref.update(grants, (count) => count + 1);
          }
          return yield* httpEffect;
        }),
      { global: true },
    );
    yield* HttpRouter.serve(
      HttpApiBuilder.layer(DeviceTestApi).pipe(
        Layer.provide(TailnetDevicesHttp.layer),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(countGrants),
        Layer.provide(Layer.succeedContext(context)),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.fresh, Layer.build);
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    yield* Ref.set(url, origin);
    const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
    return {
      url: origin,
      descriptor,
      devices: Context.get(context, TailnetDevices.TailnetDevices),
      links: Context.get(context, PeerLinks.PeerLinks),
      policy: Context.get(context, DevicePolicy.DevicePolicy),
      /** What this device lets a caller holding `token` do, as its /mcp would see it. */
      authenticate: (token: string) =>
        auth.authenticateMcpClient(
          HttpServerRequest.fromWeb(
            new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${token}` } }),
          ),
        ),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      /** One-time pairing credentials this device issued, with their scopes. */
      pairingLinks: auth.listPairingLinks(),
      /** Grants delivered to this device, each carrying a token. */
      grants,
      /** Sessions this device issued to other devices. */
      issued: auth
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.peerEnvironmentId !== undefined),
          ),
        ),
    };
  });

const laptop = descriptorOf("env-laptop", "Laptop");
const studio = descriptorOf("env-studio", "Studio");

/** Calls a device's request endpoint as anyone on the network could. */
const requestAs = (
  issuer: { readonly url: string; readonly descriptor: ExecutionEnvironmentDescriptor },
  requester: { readonly environmentId: string; readonly urls: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const client = yield* PeerLinks.peerApiClient(yield* HttpClient.HttpClient, issuer.url);
    return yield* client.tailnetDevices.request({
      payload: {
        requester: {
          environmentId: EnvironmentId.make(requester.environmentId),
          label: "Requester",
          urls: requester.urls,
        },
        issuerEnvironmentId: issuer.descriptor.environmentId,
        challenge: "c".repeat(43),
      },
    });
  }).pipe(Effect.provide(FetchHttpClient.layer));

describe("tailnet device handshake", () => {
  it.live("links both ways from one request between two of my devices", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);

      const linked = yield* a.devices.linkIfMine({ url: b.url });

      expect(Option.map(linked, (link) => [link.environmentId, link.origin])).toEqual(
        Option.some([studio.environmentId, "tailnet"]),
      );
      const back = yield* b.links.get(laptop.environmentId);
      expect(Option.map(back, (link) => [link.origin, link.urls])).toEqual(
        Option.some(["tailnet", [a.url]]),
      );
      // Each side holds exactly the session the other issued it, labelled by device.
      expect((yield* a.issued).map((session) => session.peerEnvironmentId)).toEqual([
        studio.environmentId,
      ]);
      expect((yield* b.issued).map((session) => session.peerEnvironmentId)).toEqual([
        laptop.environmentId,
      ]);
      expect(
        (yield* a.devices.list).devices.map((device) => [
          device.environmentId,
          device.incoming,
          device.outgoing,
        ]),
      ).toEqual([[studio.environmentId, true, "tailnet"]]);
    }),
  );

  it.live.each([
    { name: "same user but tagged", whois: { tags: ["tag:server"] }, joins: true },
    { name: "another user", whois: { userId: "2002" }, joins: true },
    { name: "a non-tailnet address", whois: {}, joins: false },
  ])("refuses $name without sending a token", ({ whois, joins }) =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const issuer = yield* serveDevice(studio, tailnet);
      const requester = yield* serveDevice(laptop, tailnet);
      yield* tailnet.join(issuer.url);
      if (joins) yield* tailnet.join(requester.url, whois);

      const result = yield* requestAs(issuer, {
        environmentId: laptop.environmentId,
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "not_my_device" });
      expect(yield* Ref.get(requester.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
    }),
  );

  it.live("refuses a forged request naming a real device's address without sending a token", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const issuer = yield* serveDevice(studio, tailnet);
      const victim = yield* serveDevice(laptop, tailnet);
      yield* tailnet.join(issuer.url);
      yield* tailnet.join(victim.url);

      // Anyone can claim the laptop's identity and address; the laptop has no pending challenge.
      const result = yield* requestAs(issuer, {
        environmentId: laptop.environmentId,
        urls: [victim.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "grant_rejected" });
      expect(yield* Ref.get(victim.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
      expect(yield* victim.links.get(studio.environmentId)).toEqual(Option.none());
    }),
  );

  it.live("refuses a request whose address answers as another environment", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const issuer = yield* serveDevice(studio, tailnet);
      const requester = yield* serveDevice(laptop, tailnet);
      yield* tailnet.join(issuer.url);
      yield* tailnet.join(requester.url);

      const result = yield* requestAs(issuer, {
        environmentId: "env-impostor",
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "descriptor_mismatch" });
      expect(yield* Ref.get(requester.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
    }),
  );

  it.live("counts only nodes with the device capability when it is required", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      const c = yield* serveDevice(descriptorOf("env-phone", "Phone"), tailnet);
      yield* tailnet.join(a.url, { capabilities: [TAILNET_DEVICE_CAPABILITY] });
      yield* tailnet.join(b.url, { capabilities: [TAILNET_DEVICE_CAPABILITY] });
      yield* tailnet.join(c.url);
      yield* b.devices.updateSettings({ requireCapability: true });

      expect(yield* requestAs(b, { environmentId: "env-phone", urls: [c.url] })).toEqual({
        outcome: "refused",
        reason: "not_my_device",
      });
      expect(yield* Ref.get(c.grants)).toBe(0);

      const linked = yield* a.devices.linkIfMine({ url: b.url });
      expect(Option.map(linked, (link) => link.environmentId)).toEqual(
        Option.some(studio.environmentId),
      );
    }),
  );

  it.live("links a device another device found, once they sync", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      const c = yield* serveDevice(descriptorOf("env-box", "Box"), tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* tailnet.join(c.url);
      yield* a.devices.linkIfMine({ url: b.url });
      yield* b.devices.linkIfMine({ url: c.url });
      expect(yield* a.links.get(EnvironmentId.make("env-box"))).toEqual(Option.none());

      // The scan's probes find nothing; only the studio knows the box.
      yield* a.devices.scan;

      const linked = yield* a.links.get(EnvironmentId.make("env-box"));
      expect(Option.map(linked, (link) => [link.origin, link.urls])).toEqual(
        Option.some(["tailnet", [c.url]]),
      );
      expect(Option.isSome(yield* c.links.get(laptop.environmentId))).toBe(true);
    }),
  );

  it.live("refuses every request while linking tailnet devices is off", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* b.devices.updateSettings({ autoLink: false });

      expect(yield* requestAs(b, { environmentId: laptop.environmentId, urls: [a.url] })).toEqual({
        outcome: "refused",
        reason: "disabled",
      });
      expect(yield* a.devices.linkIfMine({ url: b.url })).toEqual(Option.none());
      expect(yield* Ref.get(a.grants)).toBe(0);
    }),
  );
});

/** Laptop, studio and box, every pair linked both ways. */
const threeDevices = Effect.gen(function* () {
  const tailnet = yield* makeTailnet;
  const a = yield* serveDevice(laptop, tailnet);
  const b = yield* serveDevice(studio, tailnet);
  const c = yield* serveDevice(box, tailnet);
  yield* tailnet.join(a.url);
  yield* tailnet.join(b.url);
  yield* tailnet.join(c.url);
  yield* a.devices.linkIfMine({ url: b.url });
  yield* a.devices.linkIfMine({ url: c.url });
  yield* b.devices.linkIfMine({ url: c.url });
  return { a, b, c };
});

const box = descriptorOf("env-box", "Box");

describe("tailnet device access", () => {
  it.live("applies a changed access level to the next request without re-linking", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* a.devices.linkIfMine({ url: b.url });
      const { token } = yield* b.links.resolve(laptop.environmentId);
      expect((yield* a.authenticate(token)).access).toBe("full-access");

      yield* a.devices.setAccess(studio.environmentId, "read-only");

      expect((yield* a.authenticate(token)).access).toBe("read-only");
    }),
  );

  it.live("revoking a device on one machine cuts it off on every machine", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const { token } = yield* c.links.resolve(studio.environmentId);

      yield* a.devices.setAccess(box.environmentId, "revoked");

      for (const device of [a, b]) {
        expect(yield* device.policy.accessFor(box.environmentId)).toBe("revoked");
        expect(
          (yield* device.issued).filter((session) => session.peerEnvironmentId === "env-box"),
        ).toEqual([]);
        expect(yield* device.links.get(box.environmentId)).toEqual(Option.none());
        expect(
          (yield* device.devices.list).devices.find((row) => row.environmentId === "env-box")
            ?.status,
        ).toBe("revoked");
      }
      expect(Option.isNone(yield* Effect.option(b.authenticate(token)))).toBe(true);
      const grants = yield* Ref.get(c.grants);
      expect(yield* requestAs(b, { environmentId: "env-box", urls: [c.url] })).toEqual({
        outcome: "refused",
        reason: "revoked",
      });
      expect(yield* c.devices.linkIfMine({ url: b.url })).toEqual(Option.none());
      expect(yield* Ref.get(c.grants)).toBe(grants);
    }),
  );

  it.live("a revoked device cannot restore itself, directly or relayed", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      yield* a.devices.setAccess(box.environmentId, "revoked");
      const settings = yield* b.policy.settings;
      const selfRestore = {
        environmentId: box.environmentId,
        access: "full-access" as const,
        updatedAt: { wallMs: Number.MAX_SAFE_INTEGER, counter: 0, node: box.environmentId },
        updatedBy: box.environmentId,
      };

      yield* b.policy.merge(box.environmentId, { policy: [selfRestore], settings });
      yield* b.policy.merge(laptop.environmentId, { policy: [selfRestore], settings });
      expect(
        yield* b.devices.setAccess(studio.environmentId, "full-access").pipe(Effect.flip),
      ).toMatchObject({ reason: "self" });

      expect(yield* b.policy.accessFor(box.environmentId)).toBe("revoked");
    }),
  );

  it.live("ignores policy from a device below full access", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      yield* b.devices.setAccess(laptop.environmentId, "read-only");
      const settings = yield* b.policy.settings;

      yield* a.devices.setAccess(box.environmentId, "revoked");

      expect(yield* b.policy.accessFor(box.environmentId)).toBe("full-access");
      expect(
        yield* b.policy.merge(laptop.environmentId, { policy: yield* a.policy.entries, settings }),
      ).toEqual([]);
    }),
  );

  it.live("restoring a revoked device lets it link again", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      yield* a.devices.setAccess(box.environmentId, "revoked");

      yield* b.devices.setAccess(box.environmentId, "full-access");

      expect(yield* a.policy.accessFor(box.environmentId)).toBe("full-access");
      const linked = yield* c.devices.linkIfMine({ url: a.url });
      expect(Option.map(linked, (link) => link.environmentId)).toEqual(
        Option.some(laptop.environmentId),
      );
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
    }),
  );
});

describe("opening a device from the app", () => {
  it.live("gets a one-time app credential from the device, within its access", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* a.devices.linkIfMine({ url: b.url });

      const full = yield* a.devices.openDevice(studio.environmentId);
      expect([full.environmentId, full.urls]).toEqual([studio.environmentId, [b.url]]);
      yield* b.devices.setAccess(laptop.environmentId, "read-only");
      yield* a.devices.openDevice(studio.environmentId);

      expect((yield* b.pairingLinks).map((link) => link.permissions?.toSorted())).toEqual([
        [
          AuthAccessReadScope,
          AuthDiagnosticsReadScope,
          AuthFilesystemReadScope,
          AuthOrchestrationReadScope,
          AuthRelayReadScope,
        ].toSorted(),
        [...AuthStandardClientScopes].toSorted(),
      ]);
    }),
  );

  it.live("gets nothing from a device that revoked it, nor without its device session", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* a.devices.linkIfMine({ url: b.url });
      yield* b.devices.setAccess(laptop.environmentId, "revoked");

      const refused = yield* a.devices.openDevice(studio.environmentId).pipe(Effect.flip);
      // Anyone can claim to be a device; without its session the device mints nothing.
      const forged = yield* Effect.gen(function* () {
        const client = yield* PeerLinks.peerApiClient(yield* HttpClient.HttpClient, b.url);
        return yield* client.tailnetDevices.clientCredential({
          payload: { from: laptop.environmentId },
        });
      }).pipe(Effect.flip, Effect.provide(FetchHttpClient.layer));

      expect(refused._tag).toBe("TailnetDevicesError");
      expect(forged._tag).toBe("TailnetDevicesUnauthorizedError");
      expect(yield* b.pairingLinks).toEqual([]);
    }),
  );
});

describe("locating a tailnet target", () => {
  const tailnet: Tailnet = {
    self: {
      userId: OWNER,
      magicDnsName: "laptop.tail.ts.net",
      tailnetAddresses: [],
      httpsServeEnabled: true,
    },
    peers: [
      {
        nodeName: "studio",
        magicDnsName: "studio.tail.ts.net",
        tailnetAddresses: ["100.64.0.7", "fd7a:115c:a1e0::7"],
        userId: OWNER,
        tags: [],
        online: true,
        os: "macOS",
      },
    ],
  };

  it.each([
    ["https://studio.tail.ts.net", { origin: "https://studio.tail.ts.net", address: "100.64.0.7" }],
    [
      "https://STUDIO.tail.ts.net:8443/x",
      { origin: "https://studio.tail.ts.net:8443", address: "100.64.0.7" },
    ],
    ["http://100.64.0.9:3773", { origin: "http://100.64.0.9:3773", address: "100.64.0.9" }],
    [
      "http://[fd7a:115c:a1e0::7]:3773",
      { origin: "http://[fd7a:115c:a1e0::7]:3773", address: "fd7a:115c:a1e0::7" },
    ],
    // A name over plain http is whatever DNS says; it is never trusted.
    ["http://studio.tail.ts.net", null],
    ["https://unknown.tail.ts.net", null],
    ["http://192.168.1.20:3773", null],
    ["https://example.com", null],
    ["ftp://100.64.0.7", null],
  ])("%s", (url, expected) => {
    expect(TailnetIdentity.locateTailnetTarget(url, tailnet)).toEqual(expected);
  });
});

describe("tailnet scan probe addresses", () => {
  const peer = (os: string | null) => ({
    nodeName: "node",
    magicDnsName: "node.tail.ts.net",
    tailnetAddresses: ["100.64.0.7"],
    userId: OWNER,
    tags: [],
    online: true,
    os,
  });

  it.each([
    ["macOS", 4],
    ["linux", 4],
    [null, 4],
    ["iOS", 0],
    ["android", 0],
  ])("%s peers get %i probes", (os, count) => {
    expect(TailnetIdentity.probeUrlsFor(peer(os))).toHaveLength(count);
  });
});
