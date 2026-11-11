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
  hasLeftNetwork,
} from "@t3tools/contracts";
import type { Tailnet, TailnetPeer, TailnetWhois } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
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
  /** Runs before each whois answers, so a test can hold handshakes at that point. */
  const beforeWhois = yield* Ref.make<Effect.Effect<void>>(Effect.void);
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
        Effect.flatten(Ref.get(beforeWhois)).pipe(
          Effect.andThen(Ref.get(byOrigin)),
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
  /** Tailscale's stable id for the node serving `origin`. */
  const nodeIdOf = (origin: string) => Ref.getUnsafe(byOrigin).get(origin)?.whois.nodeId ?? null;
  return { identityFor, join, announce, nameOf, nodeIdOf, beforeWhois };
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
    const bearerRequests = yield* Ref.make(0);
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
      // Roster stamps name the machine that wrote them, as in production.
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
        }),
      ),
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
          if (
            request.url.startsWith("/api/tailnet-devices/request") &&
            request.headers.authorization !== undefined
          ) {
            yield* Ref.update(bearerRequests, (count) => count + 1);
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
      sql: Context.get(context, SqlClient.SqlClient),
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
      /** Redeems a one-time credential this device issued, as an app connecting to it would. */
      redeem: (credential: string) =>
        auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, {
          deviceType: "bot",
        }),
      /** Grants delivered to this device, each carrying a token. */
      grants,
      /** Descriptor reads this device answered, each one a probe of it. */
      descriptorReads,
      /** Link requests that reached this device carrying someone's token. */
      bearerRequests,
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
  bearer?: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const client = yield* PeerLinks.peerApiClient(
      bearer === undefined
        ? http
        : HttpClient.mapRequest(http, HttpClientRequest.bearerToken(bearer)),
      issuer.url,
    );
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
    // The owner consents on the machine being added.
    yield* member.devices.allowJoin;
    return yield* admitter.devices.admit(member.descriptor.environmentId, access);
  });

/** Puts `member` straight into `device`'s roster, bound to `nodeId`, as if a sync had brought it. */
const knowsMember = (device: Device, member: Device | string, nodeId: string | null) =>
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

/** Seeds `device`'s roster directly, as if syncs had brought it. Nothing goes over the network. */
const withRoster = (
  device: Device,
  entries: ReadonlyArray<readonly [ExecutionEnvironmentDescriptor, "full-access" | "read-only"]>,
) =>
  device.membership.adopt({
    members: entries.map(([member, access]) => ({
      environmentId: member.environmentId,
      label: member.label,
      nodeId: `n-${member.environmentId}`,
      access,
      updatedAt: { wallMs: 1, counter: 0, node: device.descriptor.environmentId },
    })),
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

/** Waits until `device`'s snapshot satisfies `done`, as a live client would see it. */
const until = (
  device: Device,
  done: (snapshot: Effect.Success<ReturnType<Device["devices"]["list"]>>) => boolean,
) => device.devices.subscribe().pipe(Stream.filter(done), Stream.runHead, Effect.asVoid);

/** Invites an app on `inviter` and redeems its code there, until `others` know it too. */
const pairApp = (
  inviter: Device,
  others: ReadonlyArray<Device>,
  input: Parameters<Device["devices"]["inviteApp"]>[0],
) =>
  Effect.gen(function* () {
    const invitation = yield* inviter.devices.inviteApp(input);
    yield* inviter.redeem(invitation.credential);
    const app = (yield* inviter.membership.apps).find(
      (candidate) => candidate.label === (input.label ?? "App"),
    )!;
    for (const other of others) {
      yield* until(other, (snapshot) => snapshot.apps.some((known) => known.appId === app.appId));
    }
    return app;
  });

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
        (yield* a.devices.list()).devices.map((device) => [
          device.environmentId,
          device.incoming,
          device.outgoing,
        ]),
      ).toEqual([[studio.environmentId, true, "tailnet"]]);
    }),
  );

  // On the test clock: the scan's probe timeout never fires, so a slow loopback answer under load
  // cannot drop the machine from the scan.
  it.effect("lists a machine found on the tailnet without linking it", () =>
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
      const found = (yield* a.devices.list()).devices.find(
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
      yield* knowsMember(b, a, tailnet.nodeIdOf(a.url));

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
      yield* knowsMember(issuer, requester, tailnet.nodeIdOf(requester.url));

      const result = yield* requestAs(issuer, {
        environmentId: laptop.environmentId,
        urls: [requester.url],
      });

      expect(result).toEqual({ outcome: "refused", reason: "not_my_device" });
      expect(yield* Ref.get(requester.grants)).toBe(0);
      expect(yield* issuer.issued).toEqual([]);
    }),
  );

  it.live("runs at most four handshakes at once", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(b.url);
      const requesterUrl = "http://requester.test";
      yield* tailnet.join(requesterUrl);
      const requesters = Array.from({ length: 5 }, (_, index) =>
        descriptorOf(`env-requester-${index}`, `Requester ${index}`),
      );
      yield* withRoster(b, [
        [studio, "full-access"],
        ...requesters.map((requester) => [requester, "full-access"] as const),
      ]);
      let entered = 0;
      const releases = yield* Queue.unbounded<void>();
      const fourIn = yield* Deferred.make<void>();
      // Each handshake holds at its whois until released.
      yield* Ref.set(
        tailnet.beforeWhois,
        Effect.suspend(() => {
          entered += 1;
          return (entered === 4 ? Deferred.succeed(fourIn, undefined) : Effect.void).pipe(
            Effect.andThen(Queue.take(releases)),
          );
        }),
      );
      const handshake = (requester: ExecutionEnvironmentDescriptor) =>
        b.devices.handleRequest({
          requester: { ...requester, urls: [requesterUrl] },
          issuerEnvironmentId: studio.environmentId,
          challenge: "c".repeat(43),
        });

      const first = yield* Effect.forEach(requesters.slice(0, 4), handshake, {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(fourIn);
      // Started at once, so it runs until it waits: for a permit, not at a whois.
      const fifth = yield* handshake(requesters[4]!).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(entered).toBe(4);

      yield* Effect.forEach(requesters, () => Queue.offer(releases, undefined));
      yield* Fiber.join(first);
      yield* Fiber.join(fifth);
      expect(entered).toBe(5);
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
      yield* knowsMember(issuer, victim, tailnet.nodeIdOf(victim.url));

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
      yield* knowsMember(issuer, "env-impostor", tailnet.nodeIdOf(requester.url));

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
          (yield* device.devices.list()).devices.find((row) => row.environmentId === "env-box")
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
      yield* knowsMember(impostor, a, tailnet.nodeIdOf(a.url));

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
      const app = yield* pairApp(a, [b], { label: "Phone", scopes: readScopes });
      const subject = `${NETWORK_APP_SUBJECT_PREFIX}${app!.appId}`;
      expect(app).toMatchObject({ label: "Phone", access: "read-only" });

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
        const app = yield* pairApp(a, [b], { scopes: AuthStandardClientScopes });
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

  it.live("a read-only app opens another member read-only, changing nothing in the network", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMembers;
      const app = yield* pairApp(a, [b], { label: "Phone", scopes: readScopes });
      const subject = `${NETWORK_APP_SUBJECT_PREFIX}${app!.appId}`;
      const roster = Effect.gen(function* () {
        return [
          yield* a.membership.members,
          yield* a.membership.apps,
          yield* b.membership.members,
          yield* b.membership.apps,
        ];
      });
      const before = yield* roster;

      const opened = yield* a.devices.openDevice(studio.environmentId, {
        scopes: readScopes,
        subject,
      });

      expect(opened.environmentId).toBe(studio.environmentId);
      const [minted] = yield* b.pairingLinks;
      expect(minted?.subject).toBe(subject);
      expect(minted?.permissions?.toSorted()).toEqual(readScopes.toSorted());
      expect(yield* roster).toEqual(before);
    }),
  );

  it.live("caps a full-access app at what the relaying machine may do on the destination", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMembers;
      const app = yield* pairApp(a, [b], { scopes: AuthStandardClientScopes });
      yield* b.devices.setAccess(laptop.environmentId, "read-only", "user");

      yield* a.devices.openDevice(studio.environmentId, {
        scopes: AuthStandardClientScopes,
        subject: `${NETWORK_APP_SUBJECT_PREFIX}${app!.appId}`,
      });

      const [minted] = yield* b.pairingLinks;
      expect(minted?.permissions?.toSorted()).toEqual(readScopes.toSorted());
    }),
  );

  it.live(
    "a read-only session outside the network opens nothing, and nothing opens a non-member",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoMembers;
        const plain = yield* a.devices
          .openDevice(studio.environmentId, { scopes: readScopes, subject: "one-time-token" })
          .pipe(Effect.flip);
        const outsider = yield* a.devices
          .openDevice(box.environmentId, {
            scopes: AuthStandardClientScopes,
            subject: "browser-session",
          })
          .pipe(Effect.flip);

        expect(plain.reason).toBe("forbidden");
        expect(outsider.reason).toBe("unknown_device");
        expect(yield* b.pairingLinks).toEqual([]);
      }),
  );

  it.live("only a full-access member invites or changes an app", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMembers;
      const app = yield* pairApp(a, [b], { scopes: AuthStandardClientScopes });
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

describe("revocation holds", () => {
  it.live("a narrowing on a machine that missed a revocation does not undo it", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      // The studio is not reached when the laptop revokes the box.
      yield* a.links.unlink(studio.environmentId);
      yield* a.devices.setAccess(box.environmentId, "revoked", "user");
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("full-access"));

      // An agent on the studio narrows the box against its stale roster, then syncs.
      yield* b.devices.setAccess(box.environmentId, "read-only", "agent");

      expect(yield* a.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
    }),
  );

  it.live("revoking a lost laptop ends the sessions it opened on other machines", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      // A browser on the laptop, outside the network, opens the studio through it.
      const opened = yield* a.devices.openDevice(studio.environmentId, {
        scopes: AuthStandardClientScopes,
        subject: "browser-session",
      });
      const { access_token } = yield* b.redeem(opened.credential);
      expect(Exit.isSuccess(yield* Effect.exit(b.sessions.verify(access_token)))).toBe(true);

      yield* c.devices.setAccess(laptop.environmentId, "revoked", "user");

      expect(Exit.isFailure(yield* Effect.exit(b.sessions.verify(access_token)))).toBe(true);
    }),
  );

  it.live(
    "a machine with the switch off takes only revocations and narrowing, and mints nothing",
    () =>
      Effect.gen(function* () {
        const { a, b, c } = yield* threeDevices;
        const { token } = yield* a.links.resolve(studio.environmentId);
        const boxToken = (yield* c.links.resolve(studio.environmentId)).token;
        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const stamp = { wallMs: Number.MAX_SAFE_INTEGER, counter: 0, node: laptop.environmentId };

        const synced = yield* syncAs(b, token, {
          from: { environmentId: laptop.environmentId, label: "Laptop", urls: [a.url] },
          devices: [],
          apps: [],
          members: [
            {
              environmentId: box.environmentId,
              label: "Box",
              nodeId: null,
              access: "revoked",
              updatedAt: stamp,
            },
            {
              environmentId: EnvironmentId.make("env-new"),
              label: "New",
              nodeId: null,
              access: "full-access",
              updatedAt: stamp,
            },
          ],
        }).pipe(Effect.flip);
        const opened = yield* a.devices
          .openDevice(studio.environmentId, {
            scopes: AuthStandardClientScopes,
            subject: "browser-session",
          })
          .pipe(Effect.flip);

        expect(synced._tag).toBe("TailnetDevicesUnauthorizedError");
        expect(opened.reason).toBe("forbidden");
        expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
        expect(Option.isNone(yield* Effect.option(b.authenticate(boxToken)))).toBe(true);
        expect(yield* b.membership.accessOf(EnvironmentId.make("env-new"))).toEqual(Option.none());
        expect(yield* b.pairingLinks).toEqual([]);
      }),
  );

  it.live("an agent cannot revoke or narrow the machine its own link comes from", () =>
    Effect.gen(function* () {
      const b = yield* serveDevice(studio, yield* makeTailnet);
      yield* withRoster(b, [
        [studio, "full-access"],
        [laptop, "full-access"],
      ]);

      // Neither revoked nor narrowed: that is the user's call.
      for (const access of ["revoked", "read-only"] as const) {
        const refused = yield* b.devices
          .setAccess(laptop.environmentId, access, "agent", laptop.environmentId)
          .pipe(Effect.flip);
        expect(refused.reason).toBe("forbidden");
      }
      expect(yield* b.membership.accessOf(laptop.environmentId)).toEqual(
        Option.some("full-access"),
      );
    }),
  );

  it.live("an agent of an outside client cannot change the machine it runs on", () =>
    Effect.gen(function* () {
      const b = yield* serveDevice(studio, yield* makeTailnet);
      yield* withRoster(b, [
        [studio, "full-access"],
        [laptop, "full-access"],
      ]);

      const refused = yield* b.devices
        .setAccess(studio.environmentId, "read-only", "agent")
        .pipe(Effect.flip);

      expect(refused.reason).toBe("self");
      expect(yield* b.membership.accessOf(studio.environmentId)).toEqual(
        Option.some("full-access"),
      );
    }),
  );

  it.live("a revocation that keeps a bound node here is neither a leave nor later", () =>
    Effect.gen(function* () {
      const b = yield* serveDevice(studio, yield* makeTailnet);
      yield* withRoster(b, [
        [studio, "full-access"],
        [laptop, "full-access"],
        [box, "full-access"],
      ]);
      const revokedAt = { wallMs: 5, counter: 0, node: laptop.environmentId };
      // The laptop's copies name no node, as after an upgrade.
      const revoke = (environmentId: EnvironmentId) => ({
        environmentId,
        label: "Revoked",
        nodeId: null,
        access: "revoked" as const,
        updatedAt: revokedAt,
      });
      yield* b.membership.merge(laptop.environmentId, {
        members: [revoke(studio.environmentId), revoke(box.environmentId)],
        apps: [],
      });

      const own = Option.getOrThrow(yield* b.membership.member(studio.environmentId));
      expect(hasLeftNetwork(own)).toBe(false);
      expect(own.nodeId).toBe(`n-${studio.environmentId}`);

      // The user's restore, made after seeing the laptop's revocation, still wins here.
      yield* b.membership.merge(laptop.environmentId, {
        members: [
          {
            ...revoke(box.environmentId),
            access: "auto",
            updatedAt: { wallMs: 6, counter: 0, node: laptop.environmentId },
            restores: revokedAt,
          },
        ],
        apps: [],
      });
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("auto"));
    }),
  );

  it.live("narrowing a machine ends the sessions it opened on other machines", () =>
    Effect.gen(function* () {
      const { b, c, a } = yield* threeDevices;
      const opened = yield* a.devices.openDevice(studio.environmentId, {
        scopes: AuthStandardClientScopes,
        subject: "browser-session",
      });
      const { access_token } = yield* b.redeem(opened.credential);

      // Narrowed on the box; the studio learns it by sync.
      yield* c.devices.setAccess(laptop.environmentId, "read-only", "user");

      expect(yield* b.membership.accessOf(laptop.environmentId)).toEqual(Option.some("read-only"));
      expect(Exit.isFailure(yield* Effect.exit(b.sessions.verify(access_token)))).toBe(true);
    }),
  );
});

describe("binding members to their nodes", () => {
  it.live("an unbound member after an upgrade is not bound by the first node to answer", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      // Another of the owner's nodes claims to be the studio, and answers first.
      const impostor = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(impostor.url);
      // The upgraded roster names the studio without a node.
      yield* knowsMember(a, a, null);
      yield* knowsMember(a, studio.environmentId, null);
      yield* knowsMember(impostor, a, tailnet.nodeIdOf(a.url));

      yield* impostor.devices.linkIfMine({ url: a.url });

      expect(yield* Ref.get(impostor.grants)).toBe(0);
      expect(yield* a.issued).toEqual([]);
      expect(
        Option.map(yield* a.membership.member(studio.environmentId), (member) => member.nodeId),
      ).toEqual(Option.some(null));

      // The user adds the real studio again; that binds it, and the impostor stays out.
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(b.url);
      yield* knowsMember(b, a, null);
      yield* admit(tailnet, a, b);

      expect(
        Option.map(yield* a.membership.member(studio.environmentId), (member) => member.nodeId),
      ).toEqual(Option.some(tailnet.nodeIdOf(b.url)));
      expect(
        Option.map(yield* b.membership.member(laptop.environmentId), (member) => member.nodeId),
      ).toEqual(Option.some(tailnet.nodeIdOf(a.url)));
      yield* impostor.devices.linkIfMine({ url: a.url });
      expect(yield* Ref.get(impostor.grants)).toBe(0);
    }),
  );
});

describe("crossing the upgrade", () => {
  it.live("a member left unbound by the upgrade rebinds through the link it already holds", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* knowsMember(b, a, null);
      yield* admit(tailnet, a, b);
      // What migration 017 leaves: every member unbound, the old links and sessions kept.
      yield* a.sql`UPDATE network_members SET node_id = NULL`;
      yield* b.sql`UPDATE network_members SET node_id = NULL`;
      const nodeOf = (device: Device, environmentId: EnvironmentId) =>
        device.membership
          .member(environmentId)
          .pipe(Effect.map(Option.map((member) => member.nodeId)));

      yield* b.devices.linkIfMine({ url: a.url });

      expect(yield* nodeOf(a, studio.environmentId)).toEqual(Option.some(tailnet.nodeIdOf(b.url)));
      expect(yield* nodeOf(b, laptop.environmentId)).toEqual(Option.some(tailnet.nodeIdOf(a.url)));
    }),
  );
});

describe("crossing the upgrade without trusting a claim", () => {
  /** Laptop and studio linked by the handshake, then left unbound as migration 017 does. */
  const upgradedPair = Effect.gen(function* () {
    const tailnet = yield* makeTailnet;
    const a = yield* serveDevice(laptop, tailnet);
    const b = yield* serveDevice(studio, tailnet);
    // Another of the owner's nodes answers as the studio.
    const impostor = yield* serveDevice(studio, tailnet);
    yield* tailnet.join(a.url);
    yield* tailnet.join(b.url);
    yield* tailnet.join(impostor.url);
    yield* knowsMember(b, a, null);
    yield* admit(tailnet, a, b);
    yield* a.sql`UPDATE network_members SET node_id = NULL`;
    yield* b.sql`UPDATE network_members SET node_id = NULL`;
    const studioNode = a.membership
      .member(studio.environmentId)
      .pipe(Effect.map(Option.map((member) => member.nodeId)));
    return { tailnet, a, b, impostor, studioNode };
  });

  it.live("a pairing-code session naming a member does not bind another node as it", () =>
    Effect.gen(function* () {
      const { a, impostor, studioNode } = yield* upgradedPair;
      // A read-only code holder names the studio's environment id; codes let it choose.
      const paired = yield* a.issueLinkSession(studio.environmentId, "read-only");

      const result = yield* requestAs(
        a,
        { environmentId: studio.environmentId, urls: [impostor.url] },
        paired.token,
      );

      expect(result.outcome).toBe("refused");
      expect(yield* studioNode).toEqual(Option.some(null));
    }),
  );

  it.live("a hinted address is not trusted with the stored token or the binding", () =>
    Effect.gen(function* () {
      const { tailnet, a, b, impostor, studioNode } = yield* upgradedPair;

      yield* a.devices.linkIfMine({ url: impostor.url }).pipe(Effect.ignore);

      expect(yield* Ref.get(impostor.bearerRequests)).toBe(0);
      expect(yield* studioNode).not.toEqual(Option.some(tailnet.nodeIdOf(impostor.url)));
      // The studio's own address still proves it, and that binds the real node.
      yield* a.devices.linkIfMine({ url: b.url });
      expect(yield* studioNode).toEqual(Option.some(tailnet.nodeIdOf(b.url)));
    }),
  );

  // The studio asks the laptop. Each side alone must hold: the laptop's session it issued, and
  // the studio's link at the address whois proved when it was made.
  const broken = {
    // Expiry is the token's signed claim; a pruned row is what the laptop holds after it.
    "the laptop no longer holds the session it issued": (a: Device) =>
      a.sql`DELETE FROM auth_sessions`,
    "the laptop revoked the session it issued": (a: Device) =>
      a.sql`UPDATE auth_sessions SET revoked_at = '2026-01-01T00:00:00.000Z'`,
    "the studio's link expired": (_a: Device, b: Device) =>
      b.sql`UPDATE peer_environment_links SET expires_at = '2000-01-01T00:00:00.000Z'`,
    "the laptop no longer answers at the studio's stored address": (_a: Device, b: Device) =>
      b.sql`UPDATE peer_environment_links SET urls_json = '["http://127.0.0.1:9"]'`,
    "the laptop holds no link to the studio": (a: Device) =>
      a.sql`DELETE FROM peer_environment_links`,
    "the laptop's link to the studio was paired by code": (a: Device) =>
      a.sql`UPDATE peer_environment_links SET origin = 'paired'`,
    "the studio no longer answers at the laptop's stored address": (a: Device) =>
      a.sql`UPDATE peer_environment_links SET urls_json = '["http://127.0.0.1:9"]'`,
  };
  it.live.each(Object.entries(broken))(
    "does not rebind across the upgrade when %s",
    ([, breakIt]) =>
      Effect.gen(function* () {
        const { a, b, studioNode } = yield* upgradedPair;
        yield* breakIt(a, b);

        yield* b.devices.linkIfMine({ url: a.url }).pipe(Effect.ignore);

        expect(yield* studioNode).toEqual(Option.some(null));
        expect(
          yield* b.membership
            .member(laptop.environmentId)
            .pipe(Effect.map(Option.map((member) => member.nodeId))),
        ).toEqual(Option.some(null));
      }),
  );

  // Continuity restores the binding only; the roster's level on the granting side still decides.
  const sessionsFor = (device: Device) =>
    device.sql<{ readonly session_id: string; readonly scopes: string }>`
      SELECT session_id, scopes FROM auth_sessions
      WHERE peer_environment_id = ${studio.environmentId} AND revoked_at IS NULL
    `;

  it.live("does not bring back a member the laptop revoked before the upgrade", () =>
    Effect.gen(function* () {
      const { a, b, studioNode } = yield* upgradedPair;
      yield* a.sql`UPDATE network_members SET access = 'revoked' WHERE environment_id = ${studio.environmentId}`;
      const before = (yield* sessionsFor(a)).length;

      yield* b.devices.linkIfMine({ url: a.url }).pipe(Effect.ignore);

      expect(yield* studioNode).toEqual(Option.some(null));
      expect((yield* sessionsFor(a)).length).toBe(before);
    }),
  );

  it.live("rebinds a member the laptop narrowed at its narrowed level", () =>
    Effect.gen(function* () {
      const { tailnet, a, b, studioNode } = yield* upgradedPair;
      yield* a.sql`UPDATE network_members SET access = 'read-only' WHERE environment_id = ${studio.environmentId}`;
      const before = new Set((yield* sessionsFor(a)).map((row) => row.session_id));

      yield* b.devices.linkIfMine({ url: a.url });

      expect(yield* studioNode).toEqual(Option.some(tailnet.nodeIdOf(b.url)));
      const issued = (yield* sessionsFor(a)).filter((row) => !before.has(row.session_id));
      expect(issued).toHaveLength(1);
      expect(issued[0]?.scopes).not.toContain("orchestration:operate");
    }),
  );
});

describe("joining a network", () => {
  it.live("a machine in no network does not join without its owner's consent", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* find(tailnet, a, b, tailnet.nameOf(b.url));

      const refused = yield* a.devices.admit(studio.environmentId, "full-access").pipe(Effect.flip);

      expect(refused.reason).toBe("forbidden");
      expect(yield* b.membership.members).toEqual([]);
      expect(yield* b.links.get(laptop.environmentId)).toEqual(Option.none());

      const { openUntil } = yield* b.devices.allowJoin;
      expect((yield* b.devices.list()).joinOpenUntil).toEqual(openUntil);
      yield* a.devices.admit(studio.environmentId, "full-access");

      expect(Option.isSome(yield* b.links.get(laptop.environmentId))).toBe(true);
      // One join per consent.
      expect((yield* b.devices.list()).joinOpenUntil).toBeNull();
    }),
  );

  it.live("a machine linked here only joins no network, and can be promoted later", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* find(tailnet, a, b, tailnet.nameOf(b.url));
      // The studio already reaches the laptop by pairing code.
      const paired = {
        environmentId: laptop.environmentId,
        label: "Laptop",
        urls: [a.url],
        access: "full-access" as const,
        origin: "paired" as const,
        linkedAt: yield* DateTime.now,
        expiresAt: DateTime.add(yield* DateTime.now, { days: 30 }),
        lastReachedAt: null,
        lastError: null,
      };
      yield* b.links.store(paired, "pairing-token");

      // Same account is not consent, even for a link to one machine.
      const refused = yield* a.devices
        .admit(studio.environmentId, "read-only", "local")
        .pipe(Effect.flip);
      expect(refused.message).toContain("has not allowed joining");
      expect(Option.map(yield* b.links.get(laptop.environmentId), (link) => link.origin)).toEqual(
        Option.some("paired"),
      );

      yield* b.devices.allowJoin;
      expect(yield* a.devices.admit(studio.environmentId, "read-only", "local")).toBeNull();
      expect((yield* b.devices.list()).joinOpenUntil).toBeNull();

      // The studio holds a read-only link to the laptop; the laptop holds none to it.
      const { token } = yield* b.links.resolve(laptop.environmentId);
      expect((yield* a.authenticate(token)).access).toBe("read-only");
      expect(yield* a.links.get(studio.environmentId)).toEqual(Option.none());
      expect(yield* a.membership.members).toEqual([]);
      expect(yield* b.membership.members).toEqual([]);
      const listed = (yield* a.devices.list()).devices.find(
        (device) => device.environmentId === studio.environmentId,
      );
      expect([listed?.member, listed?.access, listed?.nodeId]).toEqual([
        null,
        "read-only",
        tailnet.nodeIdOf(b.url),
      ]);

      yield* b.devices.allowJoin;
      yield* a.devices.admit(studio.environmentId, "full-access", "network");

      // In the network at full access; the grant it already held here stays as a limit here.
      expect(
        Option.map(yield* a.membership.member(studio.environmentId), (member) => member.access),
      ).toEqual(Option.some("full-access"));
      expect(yield* a.membership.accessOf(studio.environmentId)).toEqual(Option.some("read-only"));
      expect(yield* a.membership.local).toEqual([]);
      expect(yield* b.membership.accessOf(laptop.environmentId)).toEqual(
        Option.some("full-access"),
      );
    }),
  );

  it.live("a machine in a network may consent to a link to another machine alone", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      // The studio is in a network the laptop is not part of.
      yield* withRoster(b, [
        [studio, "full-access"],
        [box, "full-access"],
      ]);
      yield* find(tailnet, a, b, tailnet.nameOf(b.url));

      const refused = yield* a.devices
        .admit(studio.environmentId, "read-only", "local")
        .pipe(Effect.flip);
      expect(refused.message).toContain("has not allowed joining");

      yield* b.devices.allowJoin;
      yield* a.devices.admit(studio.environmentId, "read-only", "local");

      const { token } = yield* b.links.resolve(laptop.environmentId);
      expect((yield* a.authenticate(token)).access).toBe("read-only");
      expect(
        (yield* b.membership.members).map((member) => member.environmentId).toSorted(),
      ).toEqual([box.environmentId, studio.environmentId]);
    }),
  );

  it.live("promoting a machine paired here by code keeps that grant as a limit here", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* a.issueLinkSession(studio.environmentId, "read-only");

      yield* admit(tailnet, a, b);

      expect(yield* a.membership.accessOf(studio.environmentId)).toEqual(Option.some("read-only"));
      expect(
        Option.map(yield* a.membership.member(studio.environmentId), (member) => member.access),
      ).toEqual(Option.some("full-access"));
    }),
  );

  it.live("a machine already limited by a pairing code is not widened when it joins", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      const c = yield* serveDevice(box, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* tailnet.join(c.url);
      yield* admit(tailnet, a, b);
      // The studio let the box in read-only by pairing code.
      yield* b.issueLinkSession(box.environmentId, "read-only");

      yield* admit(tailnet, a, c);

      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("read-only"));
      expect(yield* a.membership.accessOf(box.environmentId)).toEqual(Option.some("full-access"));
    }),
  );
});

describe("listing", () => {
  it.live("does not ask linked machines whether they answer", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      yield* Ref.set(b.descriptorReads, 0);

      yield* a.devices.list();

      expect(yield* Ref.get(b.descriptorReads)).toBe(0);
    }),
  );
});

describe("app lifecycle", () => {
  it.live("an invitation is not an app of the network until its code is redeemed", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);

      const invitation = yield* a.devices.inviteApp({
        label: "Phone",
        scopes: AuthStandardClientScopes,
      });
      expect(yield* a.membership.apps).toEqual([]);
      expect(yield* b.membership.apps).toEqual([]);

      yield* a.redeem(invitation.credential);
      // The other member learns it from the push that follows, with no scan.
      yield* until(b, (snapshot) => snapshot.apps.length > 0);

      expect((yield* a.membership.apps).map((app) => [app.label, app.access])).toEqual([
        ["Phone", "full-access"],
      ]);
      expect((yield* b.membership.apps).map((app) => [app.label, app.access])).toEqual([
        ["Phone", "full-access"],
      ]);
    }),
  );

  it.live("an app is only ever narrowed; it pairs again for more", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      const app = yield* pairApp(a, [b], { scopes: AuthStandardClientScopes });
      yield* a.devices.setAppAccess(app!.appId, "read-only");

      const widened = yield* a.devices.setAppAccess(app!.appId, "full-access").pipe(Effect.flip);
      yield* a.devices.setAppAccess(app!.appId, "revoked");
      const restored = yield* a.devices.setAppAccess(app!.appId, "read-only").pipe(Effect.flip);

      expect([widened.reason, restored.reason]).toEqual(["forbidden", "forbidden"]);
      expect(yield* b.membership.appAccessOf(app!.appId)).toEqual(Option.some("revoked"));
    }),
  );

  it.live("pairing an app again replaces it on every member, at its new access", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);
      const old = yield* pairApp(a, [b], { label: "Phone", scopes: AuthStandardClientScopes });
      yield* a.devices.setAppAccess(old.appId, "read-only");
      const oldSubject = `${NETWORK_APP_SUBJECT_PREFIX}${old.appId}`;
      yield* a.sessions.issue({ subject: oldSubject });

      const invitation = yield* a.devices.inviteApp({
        label: "Phone",
        scopes: AuthStandardClientScopes,
        replacesAppId: old.appId,
      });
      // Nothing changes until the new code is redeemed.
      expect(yield* a.membership.appAccessOf(old.appId)).toEqual(Option.some("read-only"));
      yield* a.redeem(invitation.credential);
      yield* until(b, (snapshot) => snapshot.apps.length === 2);

      const listed = (yield* a.devices.list()).apps;
      expect(listed.map((app) => [app.label, app.access])).toEqual([["Phone", "full-access"]]);
      const replacement = listed[0]!.appId;
      expect(yield* b.membership.appAccessOf(old.appId)).toEqual(Option.some("revoked"));
      expect(yield* b.membership.appAccessOf(replacement)).toEqual(Option.some("full-access"));
      expect(
        (yield* a.sessions.listActive()).filter((session) => session.subject === oldSubject),
      ).toEqual([]);
    }),
  );
});

describe("removing and leaving", () => {
  it.live("forgetting a member revokes it everywhere and drops it from the members here", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;

      yield* a.devices.forget(box.environmentId);

      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());
      // No longer a member in this view, but still revoked here.
      const listed = (device: Device) =>
        device.devices
          .list()
          .pipe(
            Effect.map((snapshot) =>
              snapshot.devices
                .filter((row) => row.environmentId === box.environmentId)
                .map((row) => [row.member?.access ?? null, row.access]),
            ),
          );
      expect(yield* listed(a)).toEqual([[null, "revoked"]]);
      expect(yield* listed(b)).toEqual([["revoked", "revoked"]]);
      // Each other machine that still lists it as a member forgets it too, harmlessly.
      yield* b.devices.forget(box.environmentId);
      expect(yield* listed(b)).toEqual([[null, "revoked"]]);
      // Forgetting what is already gone is a no-op.
      yield* a.devices.forget(box.environmentId);
    }),
  );

  it.live("forgetting an app revokes it everywhere and hides it here", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      const app = yield* pairApp(a, [b], { label: "Phone", scopes: AuthStandardClientScopes });

      yield* a.devices.forgetApp(app.appId);

      expect(yield* b.membership.appAccessOf(app.appId)).toEqual(Option.some("revoked"));
      expect((yield* a.devices.list()).apps).toEqual([]);
    }),
  );

  it.live("a machine that leaves is revoked everywhere, and can be added again", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const { token } = yield* c.links.resolve(studio.environmentId);

      yield* c.devices.leave();

      expect(yield* a.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));
      expect(Option.isNone(yield* Effect.option(b.authenticate(token)))).toBe(true);
      expect(yield* c.membership.members).toEqual([]);
      expect(yield* c.links.get(laptop.environmentId)).toEqual(Option.none());

      // A restore runs no join, so it cannot bring back a machine that left.
      const restored = yield* a.devices
        .setAccess(box.environmentId, "full-access", "user")
        .pipe(Effect.flip);
      expect(restored.message).toContain("left the network");
      expect(yield* a.membership.accessOf(box.environmentId)).toEqual(Option.some("revoked"));

      // Its owner allows joining again, and the user adds it: a rejoin that outranks the leave.
      yield* c.devices.allowJoin;
      yield* a.devices.admit(box.environmentId, "full-access");
      for (const device of [a, b, c]) {
        expect(yield* device.membership.accessOf(box.environmentId)).toEqual(
          Option.some("full-access"),
        );
      }
      expect(Option.isSome(yield* c.links.get(laptop.environmentId))).toBe(true);
    }),
  );

  it.live("a forgotten machine still on the tailnet can be added again", () =>
    Effect.gen(function* () {
      const { a, b } = yield* threeDevices;
      yield* a.devices.forget(box.environmentId);
      const listed = (yield* a.devices.list()).devices.find(
        (device) => device.environmentId === box.environmentId,
      );
      // Still listed as revoked, so a client capping what it relays from there sees it.
      expect([listed?.member, listed?.access]).toEqual([null, "revoked"]);

      // Found again by the next scan, it is offered as a machine to add, not a member.
      yield* a.devices.scan;
      const found = (yield* a.devices.list()).devices.find(
        (device) => device.environmentId === box.environmentId,
      );
      expect([found?.member, found?.access, found?.urls.length]).toEqual([null, "revoked", 1]);

      yield* a.devices.admit(box.environmentId, "read-only");

      const added = (yield* a.devices.list()).devices.find(
        (device) => device.environmentId === box.environmentId,
      );
      expect(added?.member?.access).toBe("read-only");
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("read-only"));
    }),
  );

  it.live("the session that leaves keeps its access to this machine, and no other", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const phone = yield* pairApp(a, [b, c], { label: "Phone", scopes: AuthStandardClientScopes });
      const subject = `${NETWORK_APP_SUBJECT_PREFIX}${phone.appId}`;
      // A headless box reached only through the phone, and the same app on a tablet.
      const caller = yield* c.sessions.issue({ subject, scopes: AuthStandardClientScopes });
      const other = yield* c.sessions.issue({ subject, scopes: AuthStandardClientScopes });

      yield* c.devices.leave({ sessionId: caller.sessionId });

      const kept = yield* c.sessions.verify(caller.token);
      expect(kept.scopes.toSorted()).toEqual(caller.scopes.toSorted());
      expect(Exit.isFailure(yield* Effect.exit(c.sessions.verify(other.token)))).toBe(true);

      // From that session the owner allows joining, and the box is added again.
      yield* c.devices.allowJoin;
      yield* a.devices.admit(box.environmentId, "full-access");
      expect(yield* c.membership.accessOf(box.environmentId)).toEqual(Option.some("full-access"));
      expect(Exit.isSuccess(yield* Effect.exit(c.sessions.verify(caller.token)))).toBe(true);
    }),
  );

  it.live(
    "a session kept on leave, opened through another member, ends on rejoin if its app was removed",
    () =>
      Effect.gen(function* () {
        const { a, b, c } = yield* threeDevices;
        const phone = yield* pairApp(a, [b, c], {
          label: "Phone",
          scopes: AuthStandardClientScopes,
        });
        // The phone reaches the headless box only through the laptop.
        const opened = yield* a.devices.openDevice(box.environmentId, {
          scopes: AuthStandardClientScopes,
          subject: `${NETWORK_APP_SUBJECT_PREFIX}${phone.appId}`,
        });
        const { access_token } = yield* c.redeem(opened.credential);
        const caller = yield* c.sessions.verify(access_token);

        yield* c.devices.leave({ sessionId: caller.sessionId });
        expect(Exit.isSuccess(yield* Effect.exit(c.sessions.verify(access_token)))).toBe(true);

        // While the box is out, the phone is removed from the network; the box rejoins.
        yield* a.devices.setAppAccess(phone.appId, "revoked");
        yield* c.devices.allowJoin;
        yield* a.devices.admit(box.environmentId, "full-access");

        expect(yield* c.membership.appAccessOf(phone.appId)).toEqual(Option.some("revoked"));
        expect(Exit.isFailure(yield* Effect.exit(c.sessions.verify(access_token)))).toBe(true);
      }),
  );

  it.live("the last full-access machine cannot leave others stranded", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* withRoster(a, [
        [laptop, "full-access"],
        [studio, "read-only"],
        [box, "read-only"],
      ]);
      yield* withRoster(b, [
        [laptop, "full-access"],
        [studio, "read-only"],
      ]);

      expect(yield* a.devices.leave().pipe(Effect.flip)).toMatchObject({ reason: "forbidden" });
      expect(yield* a.membership.accessOf(laptop.environmentId)).toEqual(
        Option.some("full-access"),
      );
      // A member below full access may leave; how the others learn it is the test above.
      yield* b.devices.leave();
      expect(yield* b.membership.members).toEqual([]);
    }),
  );
});

describe("limits and the live snapshot", () => {
  it.live("a local limit narrows a member here only, and the snapshot follows it live", () =>
    Effect.gen(function* () {
      const { a, b, c } = yield* threeDevices;
      const { token } = yield* b.links.resolve(laptop.environmentId);
      const subscribed = yield* Deferred.make<void>();
      const limited = yield* a.devices.subscribe().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.filter((snapshot) =>
          snapshot.devices.some(
            (device) =>
              device.environmentId === studio.environmentId && device.localLimit === "read-only",
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);

      yield* a.devices.setLimit(studio.environmentId, "read-only");

      yield* Fiber.join(limited);
      expect((yield* a.authenticate(token)).access).toBe("read-only");
      expect(yield* c.membership.accessOf(studio.environmentId)).toEqual(
        Option.some("full-access"),
      );
      yield* a.devices.setLimit(studio.environmentId, null);
      expect((yield* a.authenticate(token)).access).toBe("full-access");
    }),
  );

  it.live("a rescan that finds nothing new writes and pushes nothing", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* find(tailnet, a, b, tailnet.nameOf(b.url));
      const first = yield* Deferred.make<void>();
      const snapshots = yield* a.devices.subscribe().pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.takeUntil((snapshot) => snapshot.joinOpenUntil !== null),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(first);

      yield* a.devices.scan;
      // A change that always pushes, so the count is exact.
      yield* a.devices.allowJoin;

      const [before, after] = Array.from(yield* Fiber.join(snapshots));
      // Nothing was written, so the scan woke no subscriber either.
      expect(after?.devices.map((device) => device.lastSeenAt)).toEqual(
        before?.devices.map((device) => device.lastSeenAt),
      );
    }),
  );

  it.live("every roster change merged from another machine reaches subscribers", () =>
    Effect.gen(function* () {
      const b = yield* serveDevice(studio, yield* makeTailnet);
      yield* withRoster(b, [
        [studio, "full-access"],
        [laptop, "full-access"],
        [box, "full-access"],
      ]);
      const changes = yield* b.membership.subscribeChanges;
      const seen = yield* changes.pipe(
        Stream.takeUntil((change) => change === "appRedeemed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const boxAt = (access: "read-only" | "revoked" | "auto", wallMs: number) => ({
        environmentId: box.environmentId,
        label: "Box",
        nodeId: `n-${box.environmentId}`,
        access,
        updatedAt: { wallMs, counter: 0, node: laptop.environmentId },
        ...(access === "auto"
          ? { restores: { wallMs: 3, counter: 0, node: laptop.environmentId } }
          : {}),
      });

      // A narrowing, a revocation and a restore, each merged from the laptop.
      for (const [access, wallMs] of [
        ["read-only", 2],
        ["revoked", 3],
        ["auto", 4],
      ] as const) {
        yield* b.membership.merge(laptop.environmentId, {
          members: [boxAt(access, wallMs)],
          apps: [],
        });
      }
      // A marker that always publishes, so the count above is exact.
      yield* b.membership.redeemApp({ appId: "marker", label: "Marker", access: "read-only" });

      expect(Array.from(yield* Fiber.join(seen))).toEqual([
        "written",
        "written",
        "written",
        "appRedeemed",
      ]);
      expect(yield* b.membership.accessOf(box.environmentId)).toEqual(Option.some("auto"));
    }),
  );

  it.live("the snapshot names the calling app, the switch and each machine's node", () =>
    Effect.gen(function* () {
      const tailnet = yield* makeTailnet;
      const a = yield* serveDevice(laptop, tailnet);
      const b = yield* serveDevice(studio, tailnet);
      yield* tailnet.join(a.url);
      yield* tailnet.join(b.url);
      yield* admit(tailnet, a, b);

      const asApp = yield* a.devices.list({ subject: `${NETWORK_APP_SUBJECT_PREFIX}phone` });
      const asBrowser = yield* a.devices.list({ subject: "browser-session" });

      expect([asApp.callerAppId, asBrowser.callerAppId, asApp.enabled]).toEqual([
        "phone",
        null,
        true,
      ]);
      expect(asApp.devices.map((device) => device.nodeId)).toEqual([tailnet.nodeIdOf(b.url)]);
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
