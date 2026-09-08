import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
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
  Marker,
  PublicIp,
  SECRET_NAME,
  Site,
  VOLUME_PATH,
} from "./fixtures/app/shared.ts";
import Worker from "./fixtures/app/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer)),
  );

class ApiNotReady extends Data.TaggedError("ApiNotReady")<{
  status: number;
}> {}

const Stack = Alchemy.Stack(
  "FlyAppFixture",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const secret = yield* Marker;
    const ip = yield* PublicIp;
    const worker = yield* Worker;
    const api = yield* Api;
    return {
      appName: site.appName,
      appId: site.appId,
      appUrl: site.url,
      workerMounts: worker.mounts,
      secretName: secret.name,
      ip: ip.ip,
      workerMachineId: worker.machineId,
      workerName: worker.name,
      workerState: worker.state,
      apiMachineId: api.machineId,
      apiName: api.name,
      apiState: api.state,
      apiUrl: api.url,
      apiRegion: api.region,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys an effectful app and serves over HTTP",
  Effect.gen(function* () {
    const out = yield* stack;

    expect(out.appName).toEqual(expect.any(String));
    expect(out.appName).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(out.appName.length).toBeLessThanOrEqual(30);
    expect(out.appId).toEqual(expect.any(String));
    expect(out.workerMounts[0]?.volumeId).toEqual(expect.any(String));
    expect(out.secretName).toEqual(SECRET_NAME);
    expect(out.ip).toEqual(expect.any(String));
    expect(out.workerMachineId).toEqual(expect.any(String));
    expect(out.apiMachineId).toEqual(expect.any(String));
    expect(out.apiMachineId).not.toEqual(out.workerMachineId);
    expect(out.apiName).not.toEqual(out.workerName);
    expect(out.workerState).toEqual("started");
    expect(out.apiState).toEqual("started");
    expect(out.apiRegion).toEqual("iad");
    expect(out.apiUrl).toEqual(`https://${out.appName}.fly.dev`);

    const liveApp = yield* distilled(
      machines.getApp({
        app_name: out.appName,
      }),
    );
    expect(liveApp.name).toEqual(out.appName);
    expect(liveApp.id).toEqual(out.appId);

    const liveApi = yield* distilled(
      machines.getMachine({
        app_name: out.appName,
        machine_id: out.apiMachineId,
      }),
    );
    expect(liveApi.id).toEqual(out.apiMachineId);
    expect(liveApi.state).toEqual("started");
    expect(liveApi.config?.metadata?.["alchemy.type"]).toEqual("Fly.Service");
    expect(liveApi.config?.guest?.cpus).toEqual(1);
    expect(liveApi.config?.guest?.memory_mb).toEqual(256);

    const liveWorker = yield* distilled(
      machines.getMachine({
        app_name: out.appName,
        machine_id: out.workerMachineId,
      }),
    );
    expect(liveWorker.id).toEqual(out.workerMachineId);
    expect(liveWorker.state).toEqual("started");
    expect(liveWorker.config?.metadata?.["alchemy.type"]).toEqual(
      "Fly.Service",
    );
    expect(liveWorker.config?.mounts?.[0]?.path).toEqual(VOLUME_PATH);
    expect(liveWorker.config?.mounts?.[0]?.volume).toEqual(
      out.workerMounts[0]?.volumeId,
    );

    const liveVolume = yield* distilled(
      machines.getVolumeById({
        app_name: out.appName,
        volume_id: out.workerMounts[0]!.volumeId,
      }),
    );
    expect(liveVolume.id).toEqual(out.workerMounts[0]?.volumeId);
    expect(liveVolume.attached_machine_id).toEqual(out.workerMachineId);

    const liveSecret = yield* distilled(
      machines.getSecret({
        app_name: out.appName,
        secret_name: out.secretName,
        show_secrets: false,
      }),
    );
    expect(liveSecret.name).toEqual(SECRET_NAME);
    expect(liveSecret.value).toBeUndefined();

    const client = yield* HttpClient.HttpClient;
    const url = out.apiUrl ?? `https://${out.appName}.fly.dev`;

    const body = yield* client.get(`${url}/health`).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new ApiNotReady({ status: 0 })),
      }),
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(
              Effect.mapError(() => new ApiNotReady({ status: res.status })),
            )
          : Effect.fail(new ApiNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "ApiNotReady",
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.upTo({ duration: "45 seconds" }),
        ),
        times: 10,
      }),
      Effect.map((value) => value as { ok: boolean; name: string }),
    );
    expect(body.ok).toEqual(true);
    expect(body.name).toEqual(SECRET_NAME);
  }).pipe(logLevel),
  { timeout: 120_000 },
);
