import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

class FakeLauncherProcess {
  readonly connected = true;
  readonly env: Record<string, string | undefined>;
  readonly sent: ServiceLauncherChildMessage[] = [];
  readonly #listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();

  constructor(context: unknown) {
    this.env = { [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) };
  }

  send = (message: ServiceLauncherChildMessage, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  };

  on = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  };

  off = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    this.#listeners.get(event)?.delete(listener);
  };

  emit(message: ServiceLauncherParentMessage) {
    for (const listener of this.#listeners.get("message") ?? []) listener(message);
  }
}

const makeClient = (host: FakeLauncherProcess, currentVersion: string) =>
  ServiceLauncherClient.make({ currentVersion }).pipe(
    Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
    Effect.provideService(HostProcessEnvironment, host.env),
  );

it.effect("waits for the launcher to durably commit the trial update ID", () =>
  Effect.gen(function* () {
    const pending = {
      id: "update-1",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      status: "pending" as const,
    };
    const host = new FakeLauncherProcess({
      protocol: 1,
      childVersion: "1.1.0",
      update: pending,
    });
    const client = yield* makeClient(host, "1.1.0");
    const prepared = yield* Effect.forkChild(client.prepareTrial, { startImmediately: true });
    yield* Effect.yieldNow;
    expect(host.sent).toEqual([{ type: "prepared", updateId: "update-1" }]);

    const committed = {
      id: pending.id,
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      status: "committed" as const,
    };
    host.emit({ type: "committed", updateId: committed.id });
    expect(yield* Fiber.join(prepared)).toEqual(committed);
  }),
);

it.effect("returns the launcher-generated ID only after update acceptance", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: 1,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(client.requestUpdate({ targetVersion: "1.1.0" }), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    host.emit({
      type: "update-accepted",
      updateId: "launcher-id",
    });
    expect(yield* Fiber.join(requested)).toBe("launcher-id");
  }),
);

it.effect("preserves a launcher rejection as a distinct error", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({ protocol: 1, childVersion: "1.0.0" });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(client.requestUpdate({ targetVersion: "1.1.0" }), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    host.emit({ type: "update-rejected", reason: "requires local update" });
    expect(yield* Fiber.join(requested).pipe(Effect.flip)).toMatchObject({
      _tag: "ServiceLauncherRejectedError",
      targetVersion: "1.1.0",
      reason: "requires local update",
    });
  }),
);

it.effect("rejects contradictory trial context instead of leaving activation closed", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: 1,
      childVersion: "1.1.0",
      update: {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.2.0",
        status: "pending",
      },
    });
    const error = yield* makeClient(host, "1.1.0").pipe(Effect.flip);
    expect(error.message).toBe("The service launcher supplied invalid startup context.");
  }),
);
