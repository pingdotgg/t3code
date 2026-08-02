import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeProviderAuthenticationCapability,
  PROVIDER_AUTH_COMMAND_ARGS,
} from "./providerAuthentication.ts";

describe("provider authentication", () => {
  it("keeps each provider's official login and logout commands fixed", () => {
    expect(PROVIDER_AUTH_COMMAND_ARGS).toEqual({
      codex: { signIn: ["login", "--device-auth"], signOut: ["logout"] },
      claude: { signIn: ["auth", "login"], signOut: ["auth", "logout"] },
      cursor: { signIn: ["login"], signOut: ["logout"] },
      grok: { signIn: ["login", "--device-auth"], signOut: ["logout"] },
      opencode: { signIn: ["auth", "login"], signOut: ["auth", "logout"] },
    });
  });

  it.effect("selects only the server-defined command arguments", () =>
    Effect.gen(function* () {
      const authentication = makeProviderAuthenticationCapability({
        command: "provider-cli",
        env: { PATH: "/bin" },
        signInArgs: ["login", "--device-auth"],
        signOutArgs: ["logout"],
        cwd: "/auth-home",
      });

      expect(yield* authentication.resolveLaunch("signIn")).toEqual({
        command: "provider-cli",
        args: ["login", "--device-auth"],
        env: { PATH: "/bin" },
        cwd: "/auth-home",
      });
      expect(yield* authentication.resolveLaunch("signOut")).toMatchObject({
        args: ["logout"],
      });
    }),
  );
});
