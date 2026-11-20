import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ListTextGeneratorModelsInput,
  type ListTextGeneratorModelsResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, vi } from "vite-plus/test";

type Request = { environmentId: EnvironmentId; input: ListTextGeneratorModelsInput };

const state = vi.hoisted(() => ({
  listModels: (_request: Request): Effect.Effect<ListTextGeneratorModelsResult, string> => {
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
    using h = setup(["offline-api"], () => Effect.fail("offline"));

    expect(yield* Effect.flip(h.read(0))).toBe("offline");
    expect(h.registry.get(h.catalog)[0]?._tag).toBe("Failure");

    state.listModels = ({ input }) =>
      Effect.succeed({
        models: input.refresh ? [{ id: "recovered-model", name: "Recovered model" }] : [],
      });
    h.registry.refresh(h.catalog);

    expect(yield* h.read(0)).toEqual([{ id: "recovered-model", name: "Recovered model" }]);
  }),
);

it.effect("shows each API's models while another discovery request is still pending", () =>
  Effect.gen(function* () {
    const slow = yield* Deferred.make<ListTextGeneratorModelsResult>();
    using h = setup(["slow-api", "ready-api"], ({ input }) =>
      input.id === "slow-api"
        ? Deferred.await(slow)
        : Effect.succeed({ models: [{ id: "ready-model", name: "Ready model" }] }),
    );

    expect(yield* h.read(1)).toEqual([{ id: "ready-model", name: "Ready model" }]);
    expect(h.registry.get(h.catalog)[0]?.waiting).toBe(true);

    yield* Deferred.succeed(slow, { models: [{ id: "slow-model", name: "Slow model" }] });
    expect(yield* h.read(0)).toEqual([{ id: "slow-model", name: "Slow model" }]);
    expect(h.registry.get(h.catalog)[1]?._tag).toBe("Success");
  }),
);
