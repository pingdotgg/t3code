import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Key whose string the host reads (roles/serviceusage.apiKeysViewer). */
export const Maps = GCP.ApiKeys.Key("Maps", {});

/**
 * Effect-native Cloud Run service exercising every API Keys binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class ApiKeysBindingsHost extends GCP.Function<ApiKeysBindingsHost>()(
  "ApiKeysBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getKeyString = yield* GCP.ApiKeys.GetKeyString(Maps);

    return {
      fetch: serveProbes({
        getKeyString: getKeyString(),
      }),
    };
  }).pipe(Effect.provide(GCP.ApiKeys.GetKeyStringHttp)),
) {}
