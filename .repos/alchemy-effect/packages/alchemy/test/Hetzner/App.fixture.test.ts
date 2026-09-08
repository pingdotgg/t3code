import * as Hetzner from "@/Hetzner";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { CredentialsFromEnv, Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Api from "./fixtures/app/api.ts";
import {
  API_PORT,
  AppRecord,
  Box,
  Data as Volume,
  DnsZone,
  Edge,
  MARKER,
  VOLUME_PATH,
  Wall,
} from "./fixtures/app/shared.ts";
import Worker from "./fixtures/app/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Hetzner.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer)),
  );

class ApiNotReady extends Data.TaggedError("ApiNotReady")<{
  status: number;
}> {}

const Stack = Alchemy.Stack(
  "HetznerAppFixture",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Box;
    const volume = yield* Volume;
    const firewall = yield* Wall;
    const lb = yield* Edge;
    const zone = yield* DnsZone;
    const records = yield* AppRecord;
    const worker = yield* Worker;
    const api = yield* Api;
    return {
      serverId: server.serverId,
      serverIpv4: server.ipv4,
      volumeId: volume.id,
      firewallId: firewall.id,
      lbId: lb.id,
      lbIpv4: lb.ipv4,
      zoneId: zone.zoneId,
      zoneName: zone.name,
      recordName: records.name,
      recordType: records.type,
      apiUrl: api.url,
      apiPort: api.port,
      apiUnit: api.unitName,
      workerUnit: worker.unitName,
    };
  }),
);

const stack = hasHetznerCreds
  ? beforeAll(deploy(Stack), { timeout: 180_000, exclusive: true })
  : null;

afterAll.skipIf(!hasHetznerCreds || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
  exclusive: true,
});

test.skipIf(!hasHetznerCreds)(
  "deploys an effectful app and serves the mounted volume over HTTP",
  Effect.gen(function* () {
    const out = yield* stack!;

    expect(out.serverId).toEqual(expect.any(Number));
    expect(out.serverIpv4).toEqual(expect.any(String));
    expect(out.volumeId).toEqual(expect.any(Number));
    expect(out.firewallId).toEqual(expect.any(Number));
    expect(out.lbId).toEqual(expect.any(Number));
    expect(out.lbIpv4).toEqual(expect.any(String));
    expect(out.zoneId).toEqual(expect.any(Number));
    expect(out.recordName).toEqual("app");
    expect(out.recordType).toEqual("A");
    expect(out.apiPort).toEqual(API_PORT);
    expect(out.apiUnit).not.toEqual(out.workerUnit);
    expect(out.apiUrl).toContain(out.serverIpv4);

    const liveServer = yield* distilled(
      Services.servers.getServer({ id: out.serverId }),
    );
    expect(liveServer.server?.id).toEqual(out.serverId);
    expect(liveServer.server?.public_net.ipv4?.ip).toEqual(out.serverIpv4);

    const liveVolume = yield* distilled(
      Services.volumes.getVolume({ id: out.volumeId }),
    );
    expect(liveVolume.volume.server).toEqual(out.serverId);
    expect(liveVolume.volume.linux_device).toMatch(/^\/dev\//);

    const liveFirewall = yield* distilled(
      Services.firewalls.getFirewall({ id: out.firewallId }),
    );
    expect(liveFirewall.firewall.applied_to).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "server",
          server: expect.objectContaining({ id: out.serverId }),
        }),
      ]),
    );
    expect(liveFirewall.firewall.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "in",
          protocol: "tcp",
          port: "22",
        }),
        expect.objectContaining({
          direction: "in",
          protocol: "tcp",
          port: String(API_PORT),
        }),
      ]),
    );

    const liveLb = yield* distilled(
      Services.loadBalancers.getLoadBalancer({ id: out.lbId }),
    );
    expect(liveLb.load_balancer.public_net.ipv4.ip).toEqual(out.lbIpv4);
    expect(liveLb.load_balancer.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "server",
          server: expect.objectContaining({ id: out.serverId }),
        }),
      ]),
    );

    const liveRecord = yield* distilled(
      Services.zoneRrsets.getZoneRrset({
        id_or_name: String(out.zoneId),
        rr_name: out.recordName,
        rr_type: out.recordType,
      }),
    );
    expect(liveRecord.rrset.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: out.lbIpv4 })]),
    );

    const client = yield* HttpClient.HttpClient;
    const url = out.apiUrl ?? `http://${out.serverIpv4}:${out.apiPort}`;

    const body = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(
              Effect.mapError(() => new ApiNotReady({ status: res.status })),
            )
          : Effect.fail(new ApiNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "ApiNotReady",
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
      Effect.map((value) => value as { text: string; path: string }),
    );
    expect(body.path).toEqual(VOLUME_PATH);
    expect(body.text).toEqual(MARKER);
  }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
