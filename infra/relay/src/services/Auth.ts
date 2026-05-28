import * as Context from "effect/Context";

export interface ClientPrincipalShape {
  readonly userId: string;
}

export class ClientPrincipal extends Context.Service<ClientPrincipal, ClientPrincipalShape>()(
  "ClientPrincipal",
) {}

export interface EnvironmentPrincipalShape {
  readonly environmentId: string;
  readonly credentialId: string;
}

export class EnvironmentPrincipal extends Context.Service<
  EnvironmentPrincipal,
  EnvironmentPrincipalShape
>()("EnvironmentPrincipal") {}
