import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeInstallationDiagnostics } from "./installationDiagnostics.ts";

it.effect("bounds diagnostic retention while draining and redacting split startup output", () =>
  Effect.gen(function* () {
    const footer = new TextEncoder().encode(
      "\u001b[31mStartup failed: café\u001b[0m\nC:\\Users\\Private\\runtime\nc:/users/private/runtime\n" +
        "Authorization: Bearer secret-fixture\npassword=private-value\n" +
        "opaque-environment-\u001b[31msecret\u001b[0m\nC:\\Users\\Private\\credential-file\nhttps://example.test/auth?code=private-code#private-fragment\n" +
        'Authorization: Token alternate-secret\nsecret="unfinished secret value',
    );
    const chunks = [
      new TextEncoder().encode("earlier log\n".repeat(500)),
      new TextEncoder().encode("x".repeat(100_000) + "\n"),
      ...Array.from(footer, (byte) => new Uint8Array([byte])),
    ];
    let drained = 0;
    const underlying = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(3)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.fromIterable(chunks).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                drained++;
              }),
            ),
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const capture = yield* makeInstallationDiagnostics("Runtime check").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, underlying),
      Effect.provideService(HostProcess.HomeDirectory, "C:\\Users\\Private"),
      Effect.provideService(HostProcess.Environment, {
        API_KEY: "opaque-environment-secret",
        SECRET_PATH: "C:\\Users\\Private\\credential-file",
      }),
    );
    const child = yield* capture.spawner.spawn(ChildProcess.make("fixture"));
    yield* child.stderr.pipe(Stream.runDrain);
    yield* child.exitCode;
    const diagnostics = capture.snapshot();
    expect(drained).toBe(chunks.length);
    expect(diagnostics.stderr.length).toBeLessThanOrEqual(2_000);
    expect(diagnostics).toMatchObject({ step: "Runtime check", exitCode: 3, truncated: true });
    expect(diagnostics.stderr).toContain("Startup failed: café");
    expect(diagnostics.stderr).toContain("~\\runtime");
    expect(diagnostics.stderr).toContain("[oversized diagnostic line omitted]");
    for (const privateText of [
      "secret-fixture",
      "private-value",
      "opaque-environment-secret",
      "private-code",
      "Private",
      "c:/users/private",
      "credential-file",
      "\u001b",
      "alternate-secret",
      "unfinished secret value",
    ]) {
      expect(diagnostics.stderr).not.toContain(privateText);
    }
  }),
);

it.effect.each(["NotFound", "PermissionDenied"] as const)(
  "reports a %s spawn failure even when no startup stream exists",
  (reason) =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: reason,
            module: "ChildProcess",
            method: "spawn",
          }),
        ),
      );
      const capture = yield* makeInstallationDiagnostics("Runtime check").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const result = yield* capture.spawner.spawn(ChildProcess.make("fixture")).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(capture.snapshot()).toMatchObject({
        stderr: "",
        exitCode: null,
        systemError:
          reason === "NotFound"
            ? "The runtime executable could not be found."
            : "The operating system denied permission to start the runtime.",
      });
    }),
);

it.live("captures a real failed child process without mixing stdout into diagnostics", () =>
  Effect.gen(function* () {
    const executable = yield* HostProcess.ExecutablePath;
    const capture = yield* makeInstallationDiagnostics("Runtime check");
    const child = yield* capture.spawner.spawn(
      ChildProcess.make(executable, [
        "-e",
        "process.stdout.write('private-protocol-payload'); process.stderr.write('Missing startup library\\n'); process.exitCode = 3;",
      ]),
    );
    yield* Effect.all(
      [child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain), child.exitCode],
      { concurrency: "unbounded" },
    );
    expect(capture.snapshot()).toEqual({
      step: "Runtime check",
      stderr: "Missing startup library",
      exitCode: 3,
      signal: null,
      truncated: false,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
