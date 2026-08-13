import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { currentPreparedConnection, initialConfigOption } from "./session.ts";

class TestConfigError extends Schema.TaggedErrorClass<TestConfigError>()("TestConfigError", {
  message: Schema.String,
}) {}

describe("environment session state", () => {
  it.effect("turns an initial config failure into an empty value", () =>
    Effect.gen(function* () {
      const result = yield* initialConfigOption(
        Effect.fail(new TestConfigError({ message: "temporary failure" })),
      );
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("reads the live prepared connection without mounting its reactive atom", () =>
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Test environment",
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      });
      const prepared: PreparedConnection = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          desired: true,
          network: "online",
          phase: "connected",
          stage: null,
          attempt: 1,
          generation: 1,
          lastFailure: null,
          retryAt: null,
        }),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none()),
        prepared: yield* SubscriptionRef.make(Option.some(prepared)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
        _environmentId,
        effect,
      ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
        _environmentId,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        runStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      const result = yield* currentPreparedConnection(target.environmentId).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      );

      expect(result).toEqual(Option.some(prepared));
    }),
  );
});
