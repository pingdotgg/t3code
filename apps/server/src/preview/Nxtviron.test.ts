import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { NxtvironInstanceList } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { NxtvironInstances, layer, parseInstanceList } from "./Nxtviron.ts";

const instance = (overrides: Record<string, unknown>) => ({
  process: "api",
  id: "main",
  ref: "api#main",
  status: "online",
  manager: "pm2",
  branch: "main",
  ports: { http: 4100 },
  proxy: { hostname: "repo.main.localhost" },
  url: "https://repo.main.localhost:8443",
  configPath: "/home/u/.config/nxtviron/config.yml",
  workingDir: "/work/repo",
  createdAt: "2026-11-09T11:00:00.000Z",
  ...overrides,
});

const listing = (...instances: ReadonlyArray<Record<string, unknown>>) =>
  JSON.stringify({ ok: true, command: "instances", data: { instances } });

const success = (data: unknown) => JSON.stringify({ ok: true, command: "action", data });
const failure = (code: string, message: string) =>
  JSON.stringify({ ok: false, command: "action", error: { code, message } });

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

const withService = <A, E>(
  options: {
    readonly list?: string;
    readonly missingBinary?: boolean;
    readonly respond?: (call: Call) => string | undefined;
  },
  body: (input: {
    readonly service: NxtvironInstances["Service"];
    readonly calls: ReadonlyArray<Call>;
  }) => Effect.Effect<A, E>,
) => {
  const calls: Array<Call> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: ({ command, args, cwd }) => {
      calls.push({ args, cwd });
      if (options.missingBinary) {
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command,
            argumentCount: args.length,
            cause: new Error("spawn nxtviron ENOENT"),
          }),
        );
      }
      const stdout = args.includes("instances")
        ? (options.list ?? listing())
        : (options.respond?.({ args, cwd }) ?? success({ stopped: [{}] }));
      return Effect.succeed(output(stdout, JSON.parse(stdout).ok ? 0 : 1));
    },
  });
  return Effect.gen(function* () {
    const service = yield* NxtvironInstances;
    return yield* body({ service, calls });
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};

const actionCalls = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => !call.args.includes("instances"));

describe("parseInstanceList", () => {
  it("decodes the envelope and maps each status to a state", () => {
    const parsed = parseInstanceList(
      listing(
        instance({}),
        instance({ ref: "api#a", id: "a", status: "errored", proxy: undefined }),
        instance({ ref: "api#b", id: "b", status: "missing", ports: { http: 0, debug: 9229 } }),
        instance({ ref: "api#c", id: "c", status: "pm2-unavailable", branch: undefined }),
      ),
    );
    expect(Option.getOrThrow(parsed)).toEqual({
      available: true,
      instances: [
        expect.objectContaining({
          ref: "api#main",
          state: "running",
          ports: { http: 4100 },
          proxyHostname: "repo.main.localhost",
          url: "https://repo.main.localhost:8443",
        }),
        expect.objectContaining({
          ref: "api#a",
          state: "stopped",
          proxyHostname: null,
          url: "https://repo.main.localhost:8443",
        }),
        expect.objectContaining({ ref: "api#b", state: "missing", ports: { debug: 9229 } }),
        expect.objectContaining({ ref: "api#c", state: "unavailable", branch: null }),
      ],
    });
  });

  it("rejects failed or malformed output", () => {
    const failed = JSON.stringify({
      ok: false,
      command: "instances",
      error: { code: "internal", message: "boom" },
    });
    expect(Option.isNone(parseInstanceList(failed))).toBe(true);
    expect(Option.isNone(parseInstanceList("pm2 noise"))).toBe(true);
  });
});

describe("NxtvironInstances", () => {
  it.effect("reports unavailable once when the binary is missing", () =>
    withService({ missingBinary: true }, ({ service, calls }) =>
      Effect.gen(function* () {
        const received: Array<NxtvironInstanceList> = [];
        const listener = (list: NxtvironInstanceList) => Effect.sync(() => received.push(list));
        yield* Effect.scoped(service.subscribe(listener));
        yield* Effect.scoped(service.subscribe(listener));
        expect(received).toEqual([
          { available: false, instances: [] },
          { available: false, instances: [] },
        ]);
        expect(calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("runs each action with its argv from the instance's working directory", () =>
    withService(
      {
        list: listing(
          instance({}),
          instance({ ref: "web#main", process: "web", status: "stopped" }),
          instance({ ref: "job#main", process: "job", status: "missing" }),
        ),
      },
      ({ service, calls }) =>
        Effect.gen(function* () {
          yield* service.act({ ref: "api#main", action: "stop" });
          yield* service.act({ ref: "web#main", action: "resume" });
          yield* service.act({ ref: "job#main", action: "delete" });
          const config = "/home/u/.config/nxtviron/config.yml";
          expect(actionCalls(calls)).toEqual([
            {
              args: ["--json", "--config", config, "stop", "api", "--instance", "main"],
              cwd: "/work/repo",
            },
            {
              args: [
                "--json",
                "--config",
                config,
                "start",
                "web",
                "--instance",
                "main",
                "--action",
                "restart",
              ],
              cwd: "/work/repo",
            },
            { args: ["--json", "delete", "job#main"], cwd: "/work/repo" },
          ]);
        }),
    ),
  );

  it.effect("retries from the config's directory when the working directory misses the scope", () =>
    withService(
      {
        list: listing(
          instance({}),
          instance({ ref: "web#main", process: "web", status: "exited" }),
        ),
        respond: ({ args, cwd }) => {
          if (cwd !== "/work/repo") return undefined;
          return args.includes("stop")
            ? success({ stopped: [], removed: false })
            : failure("not_found", "No known instance main");
        },
      },
      ({ service, calls }) =>
        Effect.gen(function* () {
          yield* service.act({ ref: "api#main", action: "stop" });
          yield* service.act({ ref: "web#main", action: "resume" });
          expect(actionCalls(calls).map((call) => [call.args[3], call.cwd])).toEqual([
            ["stop", "/work/repo"],
            ["stop", "/home/u/.config/nxtviron"],
            ["start", "/work/repo"],
            ["start", "/home/u/.config/nxtviron"],
          ]);
        }),
    ),
  );

  it.effect("fails when no directory holds the instance's scope", () =>
    withService(
      {
        list: listing(instance({})),
        respond: () => success({ stopped: [], removed: false }),
      },
      ({ service }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.act({ ref: "api#main", action: "stop" }));
          expect(error.code).toBe("not_found");
        }),
    ),
  );

  it.effect("rejects unknown refs and actions the state does not allow", () =>
    withService(
      { list: listing(instance({ ref: "job#main", process: "job", status: "missing" })) },
      ({ service, calls }) =>
        Effect.gen(function* () {
          const unknown = yield* Effect.flip(service.act({ ref: "nope#x", action: "delete" }));
          expect(unknown.code).toBe("not_found");
          const resume = yield* Effect.flip(service.act({ ref: "job#main", action: "resume" }));
          expect(resume.code).toBe("invalid_state");
          expect(actionCalls(calls)).toEqual([]);
        }),
    ),
  );

  it.effect("surfaces nxtviron's error code and message", () =>
    withService(
      {
        list: listing(instance({})),
        respond: () => failure("unavailable", "PM2 could not be reached."),
      },
      ({ service }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.act({ ref: "api#main", action: "stop" }));
          expect(error.code).toBe("unavailable");
          expect(error.message).toBe("PM2 could not be reached.");
        }),
    ),
  );
});
