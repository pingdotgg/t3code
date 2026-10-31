import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import {
  EnvironmentRegistry,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environment: undefined as
    | Pick<
        EnvironmentRegistry.EnvironmentRegistry["Service"],
        "entries" | "retryNow" | "setEnabled"
      >
    | undefined,
}));

vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() =>
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          fixture.environment as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
        ),
      ),
    ),
  };
});

import { useRetryEnvironment } from "./useRetryEnvironment";

const environmentId = EnvironmentId.make("retry-environment");

describe("useRetryEnvironment", () => {
  it.effect.each([
    { enabled: false, retries: 0 },
    { enabled: true, retries: 1 },
  ])("Retry now with the environment enabled: $enabled", ({ enabled, retries }) =>
    Effect.gen(function* () {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "Retry",
        httpBaseUrl: "https://retry.test",
        wsBaseUrl: "wss://retry.test",
      });
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[environmentId, { target, profile: Option.none(), enabled }]]));
      let retryCount = 0;
      fixture.environment = {
        entries,
        retryNow: () =>
          Effect.sync(() => {
            retryCount += 1;
          }),
        setEnabled: (id, next) =>
          SubscriptionRef.update(entries, (current) =>
            new Map(current).set(id, { ...current.get(id)!, enabled: next }),
          ),
      };

      const registry = AtomRegistry.make();
      const root = createRoot(document.createElement("div"));
      using _mounted = {
        [Symbol.dispose]() {
          act(() => root.unmount());
          registry.dispose();
        },
      };
      let retryEnvironment!: ReturnType<typeof useRetryEnvironment>;
      function Probe() {
        const value = useRetryEnvironment();
        useLayoutEffect(() => {
          retryEnvironment = value;
        });
        return null;
      }
      yield* Effect.promise(async () => {
        await act(async () =>
          root.render(
            <RegistryContext value={registry}>
              <Probe />
            </RegistryContext>,
          ),
        );
        await act(async () => {
          await retryEnvironment(environmentId);
        });
      });

      const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
      expect({ enabled: entry?.enabled, retries: retryCount }).toEqual({ enabled: true, retries });
    }),
  );
});
