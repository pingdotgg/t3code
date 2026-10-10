import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import type { MachineProps } from "@/Fly/Machine";
import type { ScratchStack } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const checks = {
  ready: {
    type: "http" as const,
    port: 80,
    path: "/",
    interval: "2s",
    timeout: "1s",
  },
};

export const deployWorker = (
  stack: ScratchStack,
  version: string,
  props: Partial<Omit<Extract<MachineProps, { image: string }>, "app">> = {},
) =>
  stack.deploy(
    Effect.gen(function* () {
      const app = yield* Fly.App("Site");
      return yield* Fly.Machine("Worker", {
        app,
        image: "nginx:alpine",
        env: { VERSION: version },
        checks,
        deploy: { strategy: "bluegreen", healthTimeout: "20 seconds" },
        shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
        ...props,
      });
    }),
  );

export const census = (appName: string) =>
  machines.listMachines({ app_name: appName }).pipe(
    Effect.map((listed) =>
      listed.filter((machine) => machine.state !== "destroyed"),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

export const assertAppGone = (appName: string) =>
  Effect.gen(function* () {
    const gone = yield* machines.getApp({ app_name: appName }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        times: 8,
        until: (gone) => gone,
      }),
      Effect.provide(FetchHttpClient.layer),
    );
    expect(gone).toBe(true);
  });

export const assertCommitted = (appName: string, ids: string[]) =>
  Effect.gen(function* () {
    const live = yield* census(appName);
    expect(live.map((machine) => machine.id).sort()).toEqual([...ids].sort());
    expect(
      live.every(
        (machine) => machine.config?.metadata?.["alchemy.phase"] === "active",
      ),
    ).toBe(true);
    expect(live.every((machine) => !!machine.image_ref?.digest)).toBe(true);
    expect(new Set(live.map((machine) => machine.image_ref?.digest)).size).toBe(
      1,
    );
    return live;
  });
