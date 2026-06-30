import type { resolveInitialServerAuthGateState } from "../environments/primary";

export type RouteAuthGateState =
  | Awaited<ReturnType<typeof resolveInitialServerAuthGateState>>
  | { status: "hosted-pairing" }
  | { status: "hosted-static" };

export interface AuthGateRouteContext {
  authGateState: RouteAuthGateState;
}

export interface AuthGateBeforeLoadArgs {
  context: AuthGateRouteContext;
}
