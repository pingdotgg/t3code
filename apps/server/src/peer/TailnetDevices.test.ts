import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  NETWORK_APP_SUBJECT_PREFIX,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import type { Tailnet, TailnetPeer, TailnetWhois } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { describe, expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Membership from "./Membership.ts";
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
  const peers = yield* Ref.make<
    ReadonlyArray<{ readonly peer: TailnetPeer; readonly probe: () => ReadonlyArray<string> }>
  >([]);
  const identityFor = (selfUserId: string) =>
    Layer.succeed(TailnetIdentity.TailnetIdentity, {
      read: Ref.get(peers).pipe(
        Effect.map((listed) =>
          Option.some<Tailnet>({
            self: {
              nodeId: null,
              userId: selfUserId,
              magicDnsName: null,
              tailnetAddresses: [],
              httpsServeEnabled: true,
            },
            peers: listed.map((entry) => entry.peer),
          }),
        ),
      ),
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
      probeUrls: (peer) =>
        Ref.getUnsafe(peers)
          .find((entry) => entry.peer.nodeName === peer.nodeName)
          ?.probe() ?? [],
    });
  const join = (origin: string, whois: Partial<TailnetWhois> = {}) =>
    Ref.update(byOrigin, (nodes) => {
      const address = `100.64.0.${nodes.size + 1}`;
      return new Map(nodes).set(origin, {
        address,
        whois: {
          nodeId: `nNode${nodes.size + 1}CNTRL`,
          userId: OWNER,
          loginName: "owner@example.com",
          nodeName: `node-${nodes.size + 1}`,
          tags: [],
          capabilities: [],
          ...whois,
        },
      });
    });
  /** Lists a peer in the tailnet status a scan reads; `probe` answers the addresses it tries. */
  const announce = (nodeName: string, probe: () => ReadonlyArray<string>) =>
    Ref.update(peers, (listed) => [
      ...listed,
      {
        peer: {
          nodeId: null,
          nodeName,
          magicDnsName: null,
          tailnetAddresses: [],
          userId: OWNER,
          tags: [],
          online: true,
          os: null,
        },
        probe,
      },
    ]);
  /** Tailscale's name for the node serving `origin`. */
  const nameOf = (origin: string) => Ref.getUnsafe(byOrigin).get(origin)?.whois.nodeName ?? origin;
  return { identityFor, join, announce, nameOf };
});

type FakeTailnet = Effect.Success<typeof makeTailnet>;

interface DeviceOptions {
  readonly userId?: string;
  readonly devUrl?: URL;
  /** Linked environments is off on this machine. */
  readonly linksOff?: boolean;
}

/** One T3 server on the tailnet: its own database, auth and links, answering on a socket of its own. */
const serveDevice = (
  descriptor: ExecutionEnvironmentDescriptor,
  tailnet: FakeTailnet,
  options: DeviceOptions = {},
) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      serveDeviceOn(descriptor, tailnet, options).pipe(Effect.provideContext(server)),
    ),
  );

const serveDeviceOn = (
  descriptor: ExecutionEnvironmentDescriptor,
  tailnet: FakeTailnet,
  options: DeviceOptions = {},
) =>
  Effect.gen(function* () {
    const url = yield* Ref.make("http://127.0.0.1:0");
    const grants = yield* Ref.make(0);
    const descriptorReads = yield* Ref.make(0);
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
      Layer.provideMerge(
        ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linksOff !== true }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
      Layer.provideMerge(
        Layer.effect(
          ServerConfig.ServerConfig,
          ServerConfig.ServerConfig.pipe(
            Effect.map((config) => ({ ...config, devUrl: options.devUrl ?? config.devUrl })),
          ),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-device-" })),
        ),
      ),
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
          if (request.url.startsWith("/.well-known/t3/environment")) {
            yield* Ref.update(descriptorReads, (count) => count + 1);
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
      membership: Context.get(context, Membership.Membership),
      sessions: Context.get(context, SessionStore.SessionStore),
      /** What this device lets a caller holding `token` do, as its /mcp would see it. */
      authenticate: (token: string) =>
        auth.authenticateMcpClient(
          HttpServerRequest.fromWeb(
            new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${token}` } }),
          ),
        ),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      /** A session like the one a pairing-code link gets: the client names its own environment. */
      issueLinkSession: (peerEnvironmentId: string, access: "read-only" | "full-access") =>
        auth.issueMcpClientSession({
          label: "T3 Code · Paired",
          access,
          peerLink: true,
          peerEnvironmentId: EnvironmentId.make(peerEnvironmentId),
          client: { deviceType: "bot" },
        }),
      /** One-time pairing credentials this device issued, with their scopes. */
      pairingLinks: auth.listPairingLinks(),
      /** Grants delivered to this device, each carrying a token. */
      grants,
      /** Descriptor reads this device answered, each one a probe of it. */
      descriptorReads,
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

type Device = Effect.Success<ReturnType<typeof serveDevice>>;

/** Lets `device` find `other` on the tailnet, as a scan would, so it can be added. */
const find = (tailnet: FakeTailnet, device: Device, other: Device, nodeName: string) =>
  Effect.gen(function* () {
    yield* tailnet.announce(nodeName, () => [other.url]);
    yield* device.devices.scan;
  });

/** `admitter` adds `member` to its network; both must already be on the tailnet. */
const admit = (
  tailnet: FakeTailnet,
  admitter: Device,
  member: Device,
  access: "full-access" | "read-only" = "full-access",
) =>
  Effect.gen(function* () {
    yield* find(tailnet, admitter, member, tailnet.nameOf(member.url));
    return yield* admitter.devices.admit(member.descriptor.environmentId, access);
  });

/** Puts `member` straight into `device`'s roster, as if a sync had brought it. */
const knowsMember = (device: Device, member: Device | string, nodeId: string | null = null) =>
  device.membership.adopt({
    members: [
      {
        environmentId: EnvironmentId.make(
          typeof member === "string" ? member : member.descriptor.environmentId,
        ),
        label: "Member",
        nodeId,
        access: "full-access",
        updatedAt: { wallMs: 1, counter: 0, node: device.descriptor.environmentId },
      },
    ],
  });

/** Sends a sync to a device as whoever holds `token`. */
const syncAs = (
  device: { readonly url: string },
  token: string,
  payload: Parameters<TailnetDevices.TailnetDevices["Service"]["handleSync"]>[1],
) =>
  Effect.gen(function* () {
    const authorized = HttpClient.mapRequest(
      yield* HttpClient.HttpClient,
      HttpClientRequest.bearerToken(token),
    );
    const client = yield* PeerLinks.peerApiClient(authorized, device.url);
    return yield* client.tailnetDevices.sync({ payload });
  }).pipe(Effect.provide(FetchHttpClient.layer));

describe("adding a machine to the network", () => {
  it.live("adds a found machine and links both ways", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);

      yield* admit(tailnet, a, b);

      expect(Option.map(yield* a.links.get(studio.environmentId), (link) => link.origin)).toEqual(
        Option.some("tailnet"),
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
      // Both hold the same roster, each member bound to its own node.
      const rosterOf = (device: Device) =>
        device.membership.members.pipe(
          Effect.map((members) =>
            members
              .map((member) => [member.environmentId, member.access, member.nodeId !== null])
              .toSorted(),
          ),
        );
      expect(yield* rosterOf(b)).toEqual(yield* rosterOf(a));
      expect(yield* rosterOf(a)).toEqual([
        [laptop.environmentId, "full-access", true],
        [studio.environmentId, "full-access", true],
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

  it.live("lists a machine found on the tailnet without linking it", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);

      yield* find(tailnet, a, b, "studio");
      yield* a.devices.scan;

      expect(yield* a.links.get(studio.environmentId)).toEqual(Option.none());
      expect(yield* a.devices.linkIfMine({ url: b.url })).toEqual(Option.none());
      expect(yield* Ref.get(b.grants)).toBe(0);
      expect(yield* b.issued).toEqual([]);
      const found = (yield* a.devices.list).devices.find(
        (device) => device.environmentId === studio.environmentId,
      );
      expect([found?.member, found?.access, found?.outgoing]).toEqual([null, null, null]);
    }),
  );

  it.live("a machine in another network keeps its own and does not join", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      const c = yield* serveDevice(box, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* tailnet.join(c.url);
      yield* admit(tailnet, b, c);

      const refused = yield* admit(tailnet, a, c).pipe(Effect.flip);

      expect(refused).toMatchObject({ reason: "forbidden" });
      expect(yield* a.membership.member(box.environmentId)).toEqual(Option.none());
      expect(yield* c.membership.member(laptop.environmentId)).toEqual(Option.none());
      expect(yield* c.links.get(laptop.environmentId)).toEqual(Option.none());
    }),
  );

  it.live("a machine added on one member is linked from every member after a scan", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      const c = yield* serveDevice(box, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* tailnet.join(c.url);
      yield* admit(tailnet, a, b);
      yield* admit(tailnet, b, c);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());

      // The scan's probes find nothing new; only the studio knows the box.
      yield* a.devices.scan;

      const linked = yield* a.links.get(box.environmentId);
      expect(Option.map(linked, (link) => [link.origin, link.urls])).toEqual(
        Option.some(["tailnet", [c.url]]),
      );
      expect(Option.isSome(yield* c.links.get(laptop.environmentId))).toBe(true);
    }),
  );

  // A dev server's fresh environment would otherwise join every one of the developer's machines.
  it.live.each([
    { name: "Linked environments is off there", linksOff: true, dev: false },
    { name: "it runs as a dev server", linksOff: false, dev: true },
  ])("a machine joins nothing while $name", ({ linksOff, dev }) =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet, {
        linksOff,
        ...(dev ? { devUrl: new URL("http://127.0.0.1:5733") } : {}),
      });
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* knowsMember(b, a);

      expect(yield* admit(tailnet, a, b).pipe(Effect.flip)).toMatchObject({ reason: "forbidden" });
      expect(yield* requestAs(b, { environmentId: laptop.environmentId, urls: [a.url] })).toEqual({
        outcome: "refused",
        reason: "disabled",
      });
      expect(yield* b.devices.linkIfMine({ url: a.url })).toEqual(Option.none());
      expect(yield* Ref.get(a.grants)).toBe(0);
      expect(yield* Ref.get(b.grants)).toBe(0);
      expect(yield* a.issued).toEqual([]);
      expect(yield* b.issued).toEqual([]);
      expect(yield* b.membership.member(laptop.environmentId).pipe(Effect.map(Option.isSome))).toBe(
        true,
      );
      expect(yield* a.membership.member(studio.environmentId)).toEqual(Option.none());
    }),
  );
});

describe("tailnet device handshake", () => {
  it.live.each([
    { name: "same user but tagged", whois: { tags: ["tag:server"] }, joins: true },
    { name: "another user", whois: { userId: "2002" }, joins: true },
    { name: "a node without a stable id", whois: { nodeId: null }, joins: true },
    { name: "a non-tailnet address", whois: {}, joins: false },
  ])("refuses $name without sending a token", ({ whois, joins }) =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const issuer = yield* serveDevice(studio, tailnet);
      const requester = yield* serveDevice(laptop, tailnet);
      yield* tailnet.join(issuer.url);
      if (joins) yield* tailnet.join(requester.url, whois);
      yield* knowsMember(issuer, requester);

      const result = yield* requestAs(issuer, {
        environmentId: laptop.environmentId,
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "not_my_device" });
      expect(yield* Ref.get(requester.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
    }),
  );

  it.live("refuses a same-user machine that is not in the network", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const issuer = yield* serveDevice(studio, tailnet);
      const requester = yield* serveDevice(laptop, tailnet);
      yield* tailnet.join(issuer.url);
      yield* tailnet.join(requester.url);

      const result = yield* requestAs(issuer, {
        environmentId: laptop.environmentId,
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "not_member" });
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
      yield* knowsMember(issuer, victim);

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
      yield* knowsMember(issuer, "env-impostor");

      const result = yield* requestAs(issuer, {
        environmentId: "env-impostor",
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "descriptor_mismatch" });
      expect(yield* Ref.get(requester.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
    }),
  );
});

/** Laptop, studio and box in one network, every pair linked both ways. */
const threeDevices = Effect.gen(function* () {
  const tailnet = yield* makeTailnet;
  const a = yield* serveDevice(laptop, tailnet);
  const b = yield* serveDevice(studio, tailnet);
  const c = yield* serveDevice(box, tailnet);
  yield* tailnet.join(a.url);
  yield* tailnet.join(b.url);
  yield* tailnet.join(c.url);
  yield* admit(tailnet, a, b);
  yield* admit(tailnet, a, c);
  yield* b.devices.scan;
  return { a, b, c };
});

const box = descriptorOf("env-box", "Box");

describe("tailnet scan", () => {
  // Stored links are listed with a reachability probe each, all at once; a scan only needs the rows.
  it.live("probes a linked device only where it sends the link's token", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);

      yield* Ref.set(b.descriptorReads, 0);
      yield* a.devices.scan;
      expect(yield* Ref.get(b.descriptorReads)).toBe(1);

      yield* Ref.set(b.descriptorReads, 0);
      yield* a.devices.setAccess(studio.environmentId, "auto", "user");
      expect(yield* Ref.get(b.descriptorReads)).toBe(1);
    }),
  );

  it.live("renews a pairing that runs out while the scan probes", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url, { nodeName: "studio" });
      yield* admit(tailnet, a, b);
      // The user paired the studio by code too, and that pairing runs out in a minute.
      const linked = Option.getOrThrow(yield* a.links.get(studio.environmentId));
      yield* a.links.store(
        {
          ...linked,
          origin: "paired",
          expiresAt: DateTime.add(yield* DateTime.now, { minutes: 1 }),
        },
        "pairing-token",
      );
      // Probing the studio takes two minutes on the laptop's clock.
      const live = yield* Clock.Clock;
      let skewMs = 0;
      const skewed: Clock.Clock = {
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
        currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + skewMs,
        currentTimeMillis: Effect.sync(() => live.currentTimeMillisUnsafe() + skewMs),
        currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe() + BigInt(skewMs) * 1_000_000n,
        currentTimeNanos: Effect.sync(
          () => live.currentTimeNanosUnsafe() + BigInt(skewMs) * 1_000_000n,
        ),
      };
      yield* tailnet.announce("studio-again", () => {
        skewMs = 2 * 60_000;
        return [b.url];
      });

      yield* a.devices.scan.pipe(Effect.provideService(Clock.Clock, skewed));

      expect(Option.map(yield* a.links.get(studio.environmentId), (link) => link.origin)).toEqual(
        Option.some("tailnet"),
      );
    }),
  );
});

describe("tailnet device access", () => {
  it.live("applies a changed access level to the next request without re-linking", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      const { token } = yield* b.links.resolve(laptop.environmentId);
      expect((yield* a.authenticate(token)).access).toBe("full-access");

      yield* a.devices.setAccess(studio.environmentId, "read-only", "user");

      expect((yield* a.authenticate(token)).access).toBe("read-only");
    }),
  );

  it.live("revoking a device on one machine cuts it off on every machine", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const { token } = yield* c.links.resolve(studio.environmentId);

      yield* a.devices.setAccess(box.environmentId, "revoked", "user");

      for (const device of [a, b]) {
        expect(yield* device.membership.accessOf(box.environmentId)).toEqual(
          Option.some("revoked"),
        );
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

  it.live("a revoked machine cannot restore itself", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const { token } = yield* c.links.resolve(studio.environmentId);
      yield* a.devices.setAccess(box.environmentId, "revoked", "user");
      const selfRestore = {
        environmentId: box.environmentId,
        label: "Box",
        nodeId: null,
        access: "full-access" as const,
        updatedAt: { wallMs: Number.MAX_SAFE_INTEGER, counter: 0, node: box.environmentId },
      };

      const refused = yield* syncAs(b, token, {
        from: { environmentId: box.environmentId, label: "Box", urls: [c.url] },
        devices: [],
        apps: [],
        members: [selfRestore],
      }).pipe(Effect.flip);
      expect(
        yield* b.devices.setAccess(studio.environmentId, "full-access", "user").pipe(Effect.flip),
      ).toMatchObject({ reason: "self" });

      expect(refused._tag).toBe("TailnetDevicesUnauthorizedError");
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
    }),
  );

  it.live("a machine below full access can neither change the roster nor be followed", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      yield* b.devices.setAccess(laptop.environmentId, "read-only", "user");

      // The laptop learned it was narrowed, so it refuses to change anything itself.
      expect(
        yield* a.devices.setAccess(box.environmentId, "revoked", "user").pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
      // And a write it relays anyway is ignored.
      const { token } = yield* a.links.resolve(studio.environmentId);
      yield* syncAs(b, token, {
        from: { environmentId: laptop.environmentId, label: "Laptop", urls: [a.url] },
        devices: [],
        apps: [],
        members: [
          {
            environmentId: box.environmentId,
            label: "Box",
            nodeId: null,
            access: "revoked",
            updatedAt: { wallMs: Number.MAX_SAFE_INTEGER, counter: 0, node: studio.environmentId },
          },
        ],
      });

      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("full-access"));
    }),
  );

  it.live("restoring a revoked device lets it link again", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      yield* a.devices.setAccess(box.environmentId, "revoked", "user");
      // Restoring is the user's call; an agent may only narrow.
      expect(
        yield* b.devices.setAccess(box.environmentId, "read-only", "agent").pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });

      yield* b.devices.setAccess(box.environmentId, "full-access", "user");

      expect(yield* a.membership.accessOf(box.environmentId)).toEqual(Option.some("full-access"));
      const linked = yield* c.devices.linkIfMine({ url: a.url });
      expect(Option.map(linked, (link) => link.environmentId)).toEqual(
        Option.some(laptop.environmentId),
      );
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
    }),
  );
});

describe("tailnet device authority", () => {
  it.live("refuses a same-user node answering as a linked device from another node", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      // Another of the owner's nodes, running a server that claims to be the studio.
      const impostor = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(impostor.url);
      yield* knowsMember(impostor, a);

      yield* impostor.devices.linkIfMine({ url: a.url });

      expect(yield* Ref.get(impostor.grants)).toBe(0);
      expect(
        (yield* a.issued).filter((session) => session.peerEnvironmentId === studio.environmentId),
      ).toHaveLength(1);
      expect(Option.map(yield* a.links.get(studio.environmentId), (link) => link.urls)).toEqual(
        Option.some([b.url]),
      );
    }),
  );

  it.live("a pairing-code link session cannot write device access, whatever id it claims", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      // A full-access pairing-code link, naming a real member.
      const paired = yield* b.issueLinkSession(laptop.environmentId, "full-access");

      const forged = yield* syncAs(b, paired.token, {
        from: { environmentId: laptop.environmentId, label: "Laptop", urls: [] },
        devices: [],
        apps: [],
        members: [
          {
            environmentId: laptop.environmentId,
            label: "Laptop",
            nodeId: null,
            access: "revoked",
            updatedAt: { wallMs: Number.MAX_SAFE_INTEGER, counter: 0, node: studio.environmentId },
          },
        ],
      }).pipe(Effect.flip);

      expect(forged._tag).toBe("TailnetDevicesUnauthorizedError");
      expect(yield* b.membership.accessOf(laptop.environmentId)).toEqual(
        Option.some("full-access"),
      );
      expect(
        (yield* b.issued).filter((session) => session.peerEnvironmentId === laptop.environmentId),
      ).toHaveLength(2);
    }),
  );
});

describe("apps of the network", () => {
  const twoMembers = Effect.gen(function* () {
    const tailnet = yield* makeTailnet;
    const a = yield* serveDevice(laptop, tailnet);
    const b = yield* serveDevice(studio, tailnet);
    yield* tailnet.join(a.url);
    yield* tailnet.join(b.url);
    yield* admit(tailnet, a, b);
    return { a, b };
  });
  const readScopes = [
    AuthOrchestrationReadScope,
    AuthFilesystemReadScope,
    AuthDiagnosticsReadScope,
    AuthAccessReadScope,
  ];

  it.live("opens every member at the app's own access, not the relaying machine's", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMembers;
      yield* a.devices.inviteApp({ label: "Phone", scopes: readScopes });
      const [app] = yield* b.membership.apps;
      const subject = `${NETWORK_APP_SUBJECT_PREFIX}${app!.appId}`;
      expect(app).toMatchObject({ label: "Phone", access: "read-only" });
      expect((yield* a.pairingLinks).map((link) => link.subject)).toEqual([subject]);

      // The laptop holds full access on the studio, but relays for a read-only app.
      yield* a.devices.openDevice(studio.environmentId, {
        scopes: AuthStandardClientScopes,
        subject,
      });

      const [minted] = yield* b.pairingLinks;
      expect(minted?.subject).toBe(subject);
      expect(minted?.permissions?.toSorted()).toEqual(readScopes.toSorted());
    }),
  );

  it.live(
    "narrowing an app ends its sessions on every member, and a revoked app opens nothing",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoMembers;
        yield* a.devices.inviteApp({ scopes: AuthStandardClientScopes });
        const [app] = yield* a.membership.apps;
        expect(app?.access).toBe("full-access");
        const subject = `${NETWORK_APP_SUBJECT_PREFIX}${app!.appId}`;
        const appSessions = (device: typeof a) =>
          device.sessions
            .listActive()
            .pipe(Effect.map((all) => all.filter((session) => session.subject === subject)));
        yield* a.sessions.issue({ subject });
        yield* b.sessions.issue({ subject });

        yield* a.devices.setAppAccess(app!.appId, "read-only");

        expect(yield* appSessions(a)).toEqual([]);
        expect(yield* appSessions(b)).toEqual([]);
        expect(yield* b.membership.appAccessOf(app!.appId)).toEqual(Option.some("read-only"));

        yield* a.devices.setAppAccess(app!.appId, "revoked");
        const refused = yield* a.devices
          .openDevice(studio.environmentId, { scopes: AuthStandardClientScopes, subject })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("forbidden");
        expect(yield* b.pairingLinks).toEqual([]);
      }),
  );

  it.live("only a full-access member invites or changes an app", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMembers;
      yield* a.devices.inviteApp({ scopes: AuthStandardClientScopes });
      const [app] = yield* a.membership.apps;
      yield* a.devices.setAccess(studio.environmentId, "read-only", "user");

      expect(
        yield* b.devices.inviteApp({ scopes: AuthStandardClientScopes }).pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
      expect(
        yield* b.devices.setAppAccess(app!.appId, "full-access").pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
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
      yield* admit(tailnet, a, b);
      const app = { scopes: AuthStandardClientScopes, subject: "browser-session" };

      const full = yield* a.devices.openDevice(studio.environmentId, app);
      expect([full.environmentId, full.urls]).toEqual([studio.environmentId, [b.url]]);
      yield* a.devices.setAccess(laptop.environmentId, "read-only", "user").pipe(Effect.ignore);
      yield* b.devices.setAccess(laptop.environmentId, "read-only", "user");
      yield* a.devices.openDevice(studio.environmentId, app);

      expect((yield* b.pairingLinks).map((link) => link.permissions?.toSorted())).toEqual([
        [
          AuthAccessReadScope,
          AuthDiagnosticsReadScope,
          AuthFilesystemReadScope,
          AuthOrchestrationReadScope,
        ].toSorted(),
        [...AuthStandardClientScopes].toSorted(),
      ]);
    }),
  );

  it.live("caps an app credential at the scopes of the app that asked", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      const narrow = [AuthOrchestrationReadScope, AuthAccessReadScope, AuthAccessWriteScope];

      yield* a.devices.openDevice(studio.environmentId, {
        scopes: narrow,
        subject: "browser-session",
      });

      const minted = (yield* b.pairingLinks).flatMap((link) => link.permissions ?? []);
      expect(minted.length).toBeGreaterThan(0);
      expect(minted.every((scope) => (narrow as ReadonlyArray<string>).includes(scope))).toBe(true);
    }),
  );

  it.live("gets nothing from a device that revoked it, nor without its member session", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      const paired = yield* b.issueLinkSession(laptop.environmentId, "full-access");
      yield* b.devices.setAccess(laptop.environmentId, "revoked", "user");

      const refused = yield* a.devices
        .openDevice(studio.environmentId, {
          scopes: AuthStandardClientScopes,
          subject: "browser-session",
        })
        .pipe(Effect.flip);
      // Anyone can claim to be a device, even holding a pairing-code link; nothing is minted.
      const claimed = (token?: string) =>
        Effect.gen(function* () {
          const base = yield* HttpClient.HttpClient;
          const client = yield* PeerLinks.peerApiClient(
            token === undefined
              ? base
              : HttpClient.mapRequest(base, HttpClientRequest.bearerToken(token)),
            b.url,
          );
          return yield* client.tailnetDevices.clientCredential({
            payload: { from: laptop.environmentId, scopes: AuthStandardClientScopes },
          });
        }).pipe(Effect.flip, Effect.provide(FetchHttpClient.layer));

      expect(refused._tag).toBe("TailnetDevicesError");
      expect((yield* claimed())._tag).toBe("TailnetDevicesUnauthorizedError");
      expect((yield* claimed(paired.token))._tag).toBe("TailnetDevicesUnauthorizedError");
      expect(yield* b.pairingLinks).toEqual([]);
    }),
  );
});

describe("locating a tailnet target", () => {
  const tailnet: Tailnet = {
    self: {
      nodeId: "nLaptopCNTRL",
      userId: OWNER,
      magicDnsName: "laptop.tail.ts.net",
      tailnetAddresses: [],
      httpsServeEnabled: true,
    },
    peers: [
      {
        nodeId: "nStudioCNTRL",
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
    nodeId: "nNodeCNTRL",
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
