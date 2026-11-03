import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";
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

const noPublicRegistry = HttpClient.make(() =>
  Effect.die("a configured npm lookup must not fall back to public npm"),
);
// A fake npm on PATH decides whether npm counts as installed.
const makeService = Effect.fnUntraced(function* (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  publicRegistry: HttpClient.HttpClient = noPublicRegistry,
  npmInstalled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const npmBin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-release-" });
  for (const name of ["npm", "npm.cmd"]) {
    yield* fs.writeFileString(path.join(npmBin, name), "", { mode: 0o755 });
  }
  return yield* NpmRelease.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(HttpClient.HttpClient, publicRegistry),
    Effect.provideService(HostProcess.Environment, {
      PATH: npmInstalled ? npmBin : "",
      PATHEXT: ".CMD",
    }),
  );
}, Effect.provide(NodeServices.layer));

it.effect.each([
  {
    spec: version,
    stdout: JSON.stringify({ version, t3code: { databaseMigration: 42 } }),
    migration: 42,
  },
  {
    spec: "nightly",
    stdout: JSON.stringify([{ version, t3code: { databaseMigration: 42 } }]),
    migration: 42,
  },
  { spec: "latest", stdout: JSON.stringify(version), migration: undefined },
])("reads $spec through npm and retains migration compatibility metadata", (fixture) =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const service = yield* makeService((input) => {
      calls.push(input);
      return Effect.succeed(output(fixture.stdout));
    });
    const expected = {
      version,
      ...(fixture.migration === undefined ? {} : { databaseMigration: fixture.migration }),
    };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: expect.stringMatching(/[/\\]npm(?:\.cmd)?$/i),
      args: ["view", "--global", "--json", `t3@${fixture.spec}`, "version", "t3code"],
      maxOutputBytes: 256 * 1024,
    });
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(2);
  }),
);

it.effect("treats a registry 404 as unpublished without trying another registry", () =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      Effect.succeed(output('{"error":{"code":"E404"}}', 1)),
    );
    expect(yield* service.get({ spec: version })).toBeNull();
  }),
);

const spawnFailure = () =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: "npm",
      argumentCount: 6,
      cause: new Error("EACCES"),
    }),
  );

it.effect.each([
  output("not json"),
  output('{"error":{"code":"E401","detail":"sensitive"}}', 1),
  output('{"version":"9.9.9"}'),
  output("[]"),
  output("", 9009),
  { ...output(JSON.stringify({ version })), stdoutTruncated: true },
  { ...output(JSON.stringify({ version })), timedOut: true },
  "spawn failure",
] as const)("reports an unavailable lookup rather than an unpublished release: %j", (result) =>
  Effect.gen(function* () {
    const service = yield* makeService(() =>
      result === "spawn failure" ? spawnFailure() : Effect.succeed(result),
    );
    const found = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) {
      expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(found.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("falls back to public npm only when npm is not installed", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      () => Effect.die("npm is not installed"),
      HttpClient.make((request) => {
        urls.push(request.url);
        const response = request.url.endsWith("/nightly")
          ? new Response(JSON.stringify({ version, t3code: { databaseMigration: 42 } }))
          : request.url.endsWith("/latest")
            ? new Response(new ReadableStream())
            : new Response("{}", { status: 404 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
      false,
    );
    expect(yield* service.get({ spec: "nightly" })).toEqual({ version, databaseMigration: 42 });
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
    expect(urls).toEqual([
      "https://registry.npmjs.org/t3/nightly",
      "https://registry.npmjs.org/t3/9.9.9",
      "https://registry.npmjs.org/t3/latest",
    ]);
  }),
);

it.effect("runs at most two npm lookups at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let running = 0;
    let peak = 0;
    const service = yield* makeService(() =>
      Effect.gen(function* () {
        peak = Math.max(peak, ++running);
        yield* Queue.offer(started, undefined);
        yield* Deferred.await(release);
        running--;
        return output('{"error":{"code":"E404"}}', 1);
      }),
    );
    const lookups = yield* Effect.forEach(
      ["1.0.0", "1.0.1", "1.0.2"],
      (spec) => service.get({ spec }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Queue.take(started);
    yield* Queue.take(started);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(lookups)).toEqual([null, null, null]);
    expect(peak).toBe(2);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before spawning npm: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(() => Effect.die("invalid specs must not spawn npm"));
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
