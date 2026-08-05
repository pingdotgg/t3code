import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";

import type { SessionRole } from "./Services/SessionCredentialService.ts";

export const ALL_AUTH_ENVIRONMENT_SCOPES = new Set<AuthEnvironmentScope>(AuthAdministrativeScopes);

export const defaultSessionScopes = (role: SessionRole): ReadonlyArray<AuthEnvironmentScope> =>
  role === "owner" ? AuthAdministrativeScopes : AuthStandardClientScopes;

export const sessionScopeSet = (
  role: SessionRole,
  scopes?: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlySet<AuthEnvironmentScope> => new Set(scopes ?? defaultSessionScopes(role));
