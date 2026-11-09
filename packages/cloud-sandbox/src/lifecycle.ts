import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { CloudSandboxError, type BaseCloudSandboxDriver } from "./driver.ts";

export const ensureCloudSandboxReady = Effect.fn("CloudSandbox.ensureReady")(function* (
  driver: BaseCloudSandboxDriver,
  sandboxId: string,
  allowResume = true,
) {
  let resumed = false;
  const poll = Effect.gen(function* () {
    const sandbox = yield* driver.get(sandboxId);
    if (sandbox.state === "error" || sandbox.state === "degraded")
      return yield* new CloudSandboxError({
        reason: "unavailable",
        cause: new Error("Sandbox failed to start."),
      });
    // A sandbox that was still stopping on an earlier read lands here later.
    if (sandbox.state === "stopped" && !resumed) {
      if (!allowResume)
        return yield* new CloudSandboxError({
          reason: "configuration",
          cause: new Error("Resuming this sandbox is not allowed."),
        });
      resumed = true;
      yield* driver.resume(sandboxId);
      return yield* driver.get(sandboxId);
    }
    return sandbox;
  });
  return yield* poll.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1500 millis"),
      while: (sandbox) => sandbox.state !== "ready",
    }),
    Effect.timeout("60 seconds"),
    Effect.catchTags({
      TimeoutError: (cause) => Effect.fail(new CloudSandboxError({ reason: "unavailable", cause })),
    }),
  );
});

export interface MaintainActiveSandboxOptions {
  readonly autoStopMinutes?: number | undefined;
}

export const maintainActiveSandbox = Effect.fn("CloudSandbox.maintainActiveSandbox")(function* <E>(
  keepalive: import("./driver.ts").KeepaliveSandbox,
  sandboxId: string,
  isActive: Effect.Effect<boolean, E>,
  options?: MaintainActiveSandboxOptions,
) {
  const configuredMinutes =
    options?.autoStopMinutes !== undefined &&
    Number.isFinite(options.autoStopMinutes) &&
    options.autoStopMinutes > 0
      ? options.autoStopMinutes
      : 60;
  const extensionHours = Math.max(1, configuredMinutes / 60);
  const renewalIntervalMs =
    Math.max(1, Math.min(15, Math.floor(configuredMinutes / 2))) * 60 * 1000;
  let lastExtension: number | null = null;
  while (true) {
    const active = yield* isActive.pipe(Effect.orElseSucceed(() => false));
    const now = yield* Clock.currentTimeMillis;
    if (active && (lastExtension === null || now - lastExtension >= renewalIntervalMs)) {
      const extended = yield* keepalive
        .extendAutoStop(sandboxId, extensionHours)
        .pipe(Effect.result);
      if (extended._tag === "Success") lastExtension = now;
    }
    yield* Effect.sleep("1 minute");
  }
});
