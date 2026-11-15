import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ListTextGeneratorModelsInput,
  type ListTextGeneratorModelsResult,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, vi } from "vite-plus/test";

type ModelListResult = AtomCommandResult<ListTextGeneratorModelsResult, string>;
type Request = { environmentId: EnvironmentId; input: ListTextGeneratorModelsInput };

const state = vi.hoisted(() => ({
  listModels: (_request: Request): Promise<ModelListResult> => {
    throw new Error("model discovery not set up");
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    listTextGeneratorModels: {
      label: "list models",
      run: (_registry: unknown, request: Request) => state.listModels(request),
    },
  },
}));

import { apiJudgeModelsAtom } from "./modelEvaluationApiModels";

function setup(ids: readonly string[], listModels: typeof state.listModels) {
  state.listModels = listModels;
  const registry = AtomRegistry.make();
  const catalog = apiJudgeModelsAtom(
    JSON.stringify(
      ids.map((id) => [EnvironmentId.make("judge-env"), ProviderInstanceId.make(id), 0]),
    ),
  );
  registry.mount(catalog);
  const result = (index: number) => Atom.map(catalog, (results) => results[index]!);
  return {
    registry,
    catalog,
    read: (index: number) =>
      AtomRegistry.getResult(registry, result(index), { suspendOnWaiting: true }),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it.effect("keeps discovery failures visible and can reload unchanged settings after recovery", () =>
  Effect.gen(function* () {
    using h = setup(["offline-api"], async () => AsyncResult.failure(Cause.fail("offline")));

    const failed = yield* Effect.exit(h.read(0));
    expect(failed._tag).toBe("Failure");
    expect(h.registry.get(h.catalog)[0]?._tag).toBe("Failure");

    state.listModels = async ({ input }) =>
      AsyncResult.success({
        models: input.refresh ? [{ id: "recovered-model", name: "Recovered model" }] : [],
      });
    h.registry.refresh(h.catalog);

    expect(yield* h.read(0)).toEqual([{ id: "recovered-model", name: "Recovered model" }]);
  }),
);

it.effect("shows each API's models while another discovery request is still pending", () =>
  Effect.gen(function* () {
    const slow = Promise.withResolvers<ModelListResult>();
    using h = setup(["slow-api", "ready-api"], async ({ input }) =>
      input.id === "slow-api"
        ? slow.promise
        : AsyncResult.success({ models: [{ id: "ready-model", name: "Ready model" }] }),
    );

    expect(yield* h.read(1)).toEqual([{ id: "ready-model", name: "Ready model" }]);
    expect(h.registry.get(h.catalog)[0]?.waiting).toBe(true);

    slow.resolve(AsyncResult.success({ models: [{ id: "slow-model", name: "Slow model" }] }));
    expect(yield* h.read(0)).toEqual([{ id: "slow-model", name: "Slow model" }]);
    expect(h.registry.get(h.catalog)[1]?._tag).toBe("Success");
  }),
);
