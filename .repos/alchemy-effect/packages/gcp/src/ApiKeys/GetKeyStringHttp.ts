import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { GetKeyString } from "./GetKeyString.ts";
import type { Key } from "./Key.ts";

/**
 * HTTP implementation of {@link GetKeyString}.
 *
 * @layer
 * @provides GCP.ApiKeys.GetKeyString
 */
export const GetKeyStringHttp = Layer.effect(
  GetKeyString,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getKeyStringProjectsLocationsKeys = yield* GCPBindings.withCredentials(
      apikeys.getKeyStringProjectsLocationsKeys,
    );
    return Effect.fn(function* <K extends Key>(key: K) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ApiKeys.GetKeyString(${key})`({
          // API keys have no resource-level IAM.
          iam: [{ role: "roles/serviceusage.apiKeysViewer" }],
        });
      }
      const name = yield* key.name;
      return Effect.fn(`GCP.ApiKeys.GetKeyString(${key.LogicalId})`)(function* () {
        return yield* getKeyStringProjectsLocationsKeys({
          name: yield* name,
        });
      });
    });
  }),
);
