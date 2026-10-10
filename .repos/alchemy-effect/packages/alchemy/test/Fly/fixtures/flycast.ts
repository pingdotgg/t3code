import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const nginx = {
  region: "iad",
  image: "nginx:alpine",
  guest: { cpus: 1, memoryMb: 256 },
};

/** Plain HTTP on port 80: Fly issues no TLS certificate for `.flycast`. */
export const httpService = {
  protocol: "tcp",
  internalPort: 80,
  ports: [{ port: 80, handlers: ["http"] }],
  autostart: true,
  autostop: "off" as const,
};

/** Fetch `url` from inside a Machine until the body contains `expected`. */
export const fetchFrom = (
  caller: { appName: string; machineId: string },
  url: string,
  expected = "Welcome to nginx",
) =>
  machines
    .execMachine({
      app_name: caller.appName,
      machine_id: caller.machineId,
      command: ["sh", "-c", `wget -qO- -T 5 ${url} || true`],
      timeout: 15,
    })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        times: 20,
        until: (result) => result.stdout?.includes(expected) === true,
      }),
      Effect.map((result) => result.stdout ?? ""),
    );

/** Fetch `url` once from inside a Machine; returns the body or wget's error. */
export const fetchOnce = (
  caller: { appName: string; machineId: string },
  url: string,
) =>
  machines
    .execMachine({
      app_name: caller.appName,
      machine_id: caller.machineId,
      command: ["sh", "-c", `wget -qO- -T 5 ${url} 2>&1 || true`],
      timeout: 15,
    })
    .pipe(Effect.map((result) => result.stdout ?? ""));
