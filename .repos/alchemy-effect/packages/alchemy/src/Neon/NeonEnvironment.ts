import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  NEON_AUTH_PROVIDER_NAME,
  type NeonAuthConfig,
  type NeonResolvedCredentials,
} from "./AuthProvider.ts";

export class NeonEnvironment extends Context.Service<
  NeonEnvironment,
  NeonResolvedCredentials
>()("Neon::NeonEnvironment") {}

export const fromProfile = () =>
  Layer.effect(
    NeonEnvironment,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        NeonAuthConfig,
        NeonResolvedCredentials
      >(NEON_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const config = yield* profile.loadOrConfigure(auth, profileName, { ci });
      return yield* auth.read(profileName, config as NeonAuthConfig);
    }),
  );
