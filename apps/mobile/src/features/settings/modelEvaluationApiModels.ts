import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

type ApiJudgeKey = readonly [EnvironmentId, ProviderInstanceId, number];

const apiJudgeModelListAtom = Atom.family((key: string) => {
  const [environmentId, id] = JSON.parse(key) as ApiJudgeKey;
  return Atom.make((get) => {
    const refresh = Option.isSome(get.self());
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        serverEnvironment.listTextGeneratorModels,
        { environmentId, input: { id, ...(refresh ? { refresh: true } : {}) } },
        { reportFailure: false },
      ),
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "Success"
          ? Effect.succeed(result.value.models)
          : Effect.failCause(result.cause),
      ),
    );
  }).pipe(Atom.setIdleTTL(5 * 60_000));
});

export const apiJudgeModelsAtom = Atom.family((key: string) => {
  const requests = (JSON.parse(key) as ReadonlyArray<ApiJudgeKey>).map((api) =>
    apiJudgeModelListAtom(JSON.stringify(api)),
  );
  return Atom.readable(
    (get) => requests.map((request) => get(request)),
    (refresh) => requests.forEach(refresh),
  ).pipe(Atom.withLabel("model-evaluation-api-judges"));
});
