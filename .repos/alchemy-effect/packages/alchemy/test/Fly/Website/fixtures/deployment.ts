import * as machines from "@distilled.cloud/fly-io/machines";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

export const websiteServices = (path: string) => [
  {
    protocol: "tcp" as const,
    internalPort: 3000,
    autostop: "off" as const,
    ports: [
      { port: 80, handlers: ["http"], forceHttps: true },
      { port: 443, handlers: ["tls", "http"] },
    ],
    checks: [
      {
        type: "http" as const,
        port: 3000,
        path,
        interval: "5s",
        timeout: "2s",
      },
    ],
  },
];

export const websiteChecks = (path: string) => ({
  website: {
    type: "http" as const,
    port: 3000,
    path,
    interval: "5s",
    timeout: "2s",
  },
});

export const getText = (url: string) =>
  HttpClient.get(url, {
    headers: { connection: "close", "cache-control": "no-cache" },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : Effect.fail(new Error(`Website returned HTTP ${response.status}`)),
    ),
    Effect.timeout("10 seconds"),
  );

export const initialText = (url: string) =>
  getText(url).pipe(
    Effect.retry({ times: 8, schedule: Schedule.spaced("2 seconds") }),
  );

export const startTraffic = (url: string) =>
  Effect.gen(function* () {
    const samples = yield* Ref.make<
      Array<{ body: string } | { failure: string }>
    >([]);
    let active = true;
    const fiber = yield* Stream.range(0, 1799, 1).pipe(
      Stream.takeWhile(() => active),
      Stream.runForEach(() =>
        getText(url).pipe(
          Effect.result,
          Effect.flatMap((result) =>
            Ref.update(samples, (values) => [
              ...values,
              Result.isSuccess(result)
                ? { body: result.success }
                : { failure: String(result.failure) },
            ]),
          ),
          Effect.andThen(Effect.sleep("500 millis")),
        ),
      ),
      Effect.timeout("15 minutes"),
      Effect.forkScoped,
    );
    const finish = Effect.gen(function* () {
      yield* Effect.sync(() => {
        active = false;
      });
      yield* Fiber.join(fiber);
      const values = yield* Ref.get(samples);
      expect(values.filter((sample) => "failure" in sample)).toEqual([]);
      return values.flatMap((sample) =>
        "body" in sample ? [sample.body] : [],
      );
    });
    const waitFor = (predicate: (body: string) => boolean) =>
      Ref.get(samples).pipe(
        Effect.repeat({
          until: (values) =>
            values.some((sample) => "body" in sample && predicate(sample.body)),
          times: 8,
          schedule: Schedule.spaced("500 millis"),
        }),
        Effect.tap((values) =>
          Effect.sync(() => {
            expect(
              values.some(
                (sample) => "body" in sample && predicate(sample.body),
              ),
            ).toBe(true);
          }),
        ),
      );
    return { finish, waitFor };
  });

export const assertOnlyMachine = (appName: string, machineId: string) =>
  Effect.gen(function* () {
    const live = (yield* machines.listMachines({ app_name: appName })).filter(
      (machine) => machine.state !== "destroyed",
    );
    expect(live.map((machine) => machine.id)).toEqual([machineId]);
  });

export const assertMachineGone = (appName: string, machineId: string) =>
  Effect.gen(function* () {
    const gone = yield* machines
      .getMachine({ app_name: appName, machine_id: machineId })
      .pipe(
        Effect.map((machine) => machine.state === "destroyed"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
    expect(gone).toBe(true);
  });

export const assertAppGone = (appName: string) =>
  Effect.gen(function* () {
    const gone = yield* machines.getApp({ app_name: appName }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
      Effect.repeat({
        until: (value) => value,
        times: 8,
        schedule: Schedule.spaced("1 second"),
      }),
    );
    expect(gone).toBe(true);
  });
