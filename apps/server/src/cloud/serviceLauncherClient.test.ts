import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";
import { make } from "./serviceLauncherClient.ts";

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

it.effect("parks a trial until the launcher durably commits its update ID", () =>
  Effect.gen(function* () {
    const pending = {
      id: "update-1",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      status: "pending" as const,
      requestedAt: "2026-08-01T00:00:00.000Z",
    };
    const host = new FakeLauncherProcess({
      protocol: 1,
      activeVersion: "1.0.0",
      childVersion: "1.1.0",
      trial: true,
      update: pending,
    });
    const client = yield* make({ process: host, currentVersion: "1.1.0" });
    const prepared = yield* Effect.forkChild(client.prepareTrial, { startImmediately: true });
    yield* Effect.yieldNow;
    expect(host.sent).toEqual([{ type: "prepared", updateId: "update-1" }]);

    const committed = {
      id: pending.id,
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      status: "committed" as const,
      completedAt: "2026-08-01T00:00:01.000Z",
    };
    host.emit({ type: "committed", update: committed });
    expect(Option.getOrThrow(yield* Fiber.join(prepared))).toEqual(committed);
    yield* client.awaitActivation;
  }),
);

it.effect("returns the launcher-generated ID only after update acceptance", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: 1,
      activeVersion: "1.0.0",
      childVersion: "1.0.0",
      trial: false,
    });
    const client = yield* make({ process: host, currentVersion: "1.0.0" });
    const requested = yield* Effect.forkChild(
      client.requestUpdate({ fromVersion: "1.0.0", targetVersion: "1.1.0" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    host.emit({
      type: "update-accepted",
      update: {
        id: "launcher-id",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
        requestedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    expect((yield* Fiber.join(requested)).id).toBe("launcher-id");
  }),
);

it.effect("rejects contradictory trial context instead of leaving activation closed", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: 1,
      activeVersion: "1.0.0",
      childVersion: "1.1.0",
      trial: true,
    });
    const error = yield* make({ process: host, currentVersion: "1.1.0" }).pipe(Effect.flip);
    expect(error.reason).toBe("The service launcher supplied invalid startup context.");
  }),
);
