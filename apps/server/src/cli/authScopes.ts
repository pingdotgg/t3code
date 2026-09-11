import { AuthGrantScope } from "@t3tools/contracts";
import { Flag } from "effect/unstable/cli";

export const authScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  Flag.choice("scope", AuthGrantScope.literals).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes.length > 0 ? scopes : defaults)]),
  );
