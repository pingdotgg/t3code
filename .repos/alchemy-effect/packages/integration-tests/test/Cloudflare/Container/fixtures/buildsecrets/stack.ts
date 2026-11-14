import { declareDurableObjectApplication } from "@alchemy.run/cloudflare/Containers/DurableObjectApplication";
import * as Effect from "effect/Effect";
import { BuildSecretsImage } from "./object.ts";
import { BuildSecretsWorker } from "./worker.ts";

export { BuildInputs, type BuildInputSet } from "./inputs.ts";

export const buildSecretsStack = Effect.gen(function* () {
  const worker = yield* BuildSecretsWorker;
  return {
    worker,
    image: yield* BuildSecretsImage.Application,
    application: yield* declareDurableObjectApplication(worker, "BuildSecretsObject"),
  };
});
