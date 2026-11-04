import { AwsAuth } from "@alchemy.run/aws/AuthProvider";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { Default as DefaultEnvironment } from "@alchemy.run/aws/Environment";
import * as Region from "@alchemy.run/aws/Region";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Layer from "effect/Layer";

/**
 * TEST-ONLY: the live AWS environment chain (profile/SSO credentials,
 * env-var region/endpoint overrides), independent of the run mode.
 *
 * In an `alchemy dev` run the ambient environment IS the emulator — that is
 * the product contract, and nothing in user code should ever need to opt
 * out of it (per-resource live access flows through `Alchemy.remote()` and
 * the binding data-plane routing). The one legitimate exception is test
 * FORENSICS: proving out-of-band that a resource does (or does not) exist
 * on the real cloud. Provide this layer around exactly those probes —
 * symmetric with the `flociContext` fixtures used to probe the emulator.
 */
export const liveContext = Layer.mergeAll(
  Region.fromEnvironment,
  Credentials.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.orDie,
);
