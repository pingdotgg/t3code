import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProcessRunner } from "../../processRunner.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const settings = (overrides: Partial<PiSettings> = {}): PiSettings => ({
  enabled: true,
  binaryPath: "pi",
  configDirectory: "",
  launchArgs: "",
  ...overrides,
});

const withProcessResult = (
  result: ReturnType<ProcessRunner["Service"]["run"]>,
) =>
  checkPiProviderStatus(settings(), process.env).pipe(
    Effect.provideService(ProcessRunner, ProcessRunner.of({ run: () => result })),
  );

describe("checkPiProviderStatus", () => {
  it.effect("reports a usable supported Pi binary", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.81.1\n",
        stderr: "",
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("ready");
          expect(snapshot.version).toBe("0.81.1");
        }),
      ),
    ),
  );

  it.effect("passes the selected Pi config directory to the status probe", () => {
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    return checkPiProviderStatus(
      settings({ configDirectory: "/Users/example/.pi-work" }),
      { EXAMPLE: "value" },
    ).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: (input) => {
            receivedEnvironment = input.env;
            return Effect.succeed({
              stdout: "pi 0.81.1\n",
              stderr: "",
              code: 0,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(receivedEnvironment).toMatchObject({
            EXAMPLE: "value",
            PI_AGENT_DIR: "/Users/example/.pi-work",
          });
        }),
      ),
    );
  });

  it.effect("rejects protected launch arguments before probing Pi", () =>
    checkPiProviderStatus(settings({ launchArgs: "--mode json" }), process.env).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({ run: () => Effect.die("must not run") }),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("managed by T3 Code");
        }),
      ),
    ),
  );

  it.effect("reports an upgrade requirement for an old Pi binary", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.81.0\n",
        stderr: "",
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("Upgrade to v0.81.1");
        }),
      ),
    ),
  );

  it.effect("reports a missing or invalid Pi binary", () =>
    withProcessResult(
      Effect.fail({ _tag: "ProcessSpawnError" } as never),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(false);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("could not be started");
        }),
      ),
    ),
  );

  it.effect("reports output from a non-Pi executable as invalid", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "not a Pi version\n",
        stderr: "",
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("Could not determine");
        }),
      ),
    ),
  );

  it.effect("does not treat a failed version command as usable", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.81.1\n",
        stderr: "fatal error",
        code: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("version check failed");
        }),
      ),
    ),
  );

  it.effect("does not treat a timed-out version command as usable", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("timed out");
        }),
      ),
    ),
  );
});
