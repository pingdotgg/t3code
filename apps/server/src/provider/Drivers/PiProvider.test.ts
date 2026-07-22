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
});
