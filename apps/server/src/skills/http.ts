import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { discoverGlobalSkillInventory } from "./SkillInventory.ts";

export const skillsHttpApiLayer = HttpApiBuilder.group(EnvironmentHttpApi, "skills", (handlers) =>
  Effect.succeed(
    handlers.handle(
      "inventory",
      Effect.fn("environment.skills.inventory")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* discoverGlobalSkillInventory();
      }),
    ),
  ),
);
