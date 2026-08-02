import * as NodeOS from "node:os";

import type { ProviderAuthAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAuthenticationCapability, ProviderAuthLaunchSpec } from "./ProviderDriver.ts";

export const PROVIDER_AUTH_COMMAND_ARGS = {
  codex: { signIn: ["login", "--device-auth"], signOut: ["logout"] },
  claude: { signIn: ["auth", "login"], signOut: ["auth", "logout"] },
  cursor: { signIn: ["login"], signOut: ["logout"] },
  grok: { signIn: ["login", "--device-auth"], signOut: ["logout"] },
  opencode: { signIn: ["auth", "login"], signOut: ["auth", "logout"] },
} as const;

export function makeProviderAuthenticationCapability(input: {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signInArgs: ReadonlyArray<string>;
  readonly signOutArgs: ReadonlyArray<string>;
  readonly cwd?: string;
}): ProviderAuthenticationCapability {
  const resolveLaunch = (action: ProviderAuthAction) =>
    Effect.succeed({
      command: input.command,
      args: action === "signIn" ? input.signInArgs : input.signOutArgs,
      cwd: input.cwd ?? NodeOS.homedir(),
      env: input.env,
    } satisfies ProviderAuthLaunchSpec);

  return {
    canSignIn: true,
    canSignOut: true,
    resolveLaunch,
  };
}
