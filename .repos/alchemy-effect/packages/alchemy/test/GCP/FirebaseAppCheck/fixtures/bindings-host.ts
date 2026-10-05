import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { lifecycleAppId } from "../common.ts";

/** Debug token registered on the `GCP_TEST_FIREBASE_APP_ID` app. */
export const Local = GCP.FirebaseAppCheck.AppsDebugToken("Local", {
  app: lifecycleAppId ?? "",
  displayName: "alchemy-exchange",
});

/**
 * Effect-native Cloud Run service exercising every App Check binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class AppCheckBindingsHost extends GCP.Function<AppCheckBindingsHost>()(
  "AppCheckBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(
      yield* Local,
    );

    return {
      fetch: serveProbes({
        exchangeDebugToken: exchange(),
      }),
    };
  }).pipe(Effect.provide(GCP.FirebaseAppCheck.ExchangeDebugTokenHttp)),
) {}
