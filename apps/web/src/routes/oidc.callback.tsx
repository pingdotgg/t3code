import { createFileRoute } from "@tanstack/react-router";

import { OidcCallbackSurface } from "../components/oidc/OidcCallbackSurface";

export const Route = createFileRoute("/oidc/callback")({
  component: OidcCallbackSurface,
});
