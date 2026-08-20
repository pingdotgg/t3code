import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";

export type WorkspaceFileGlbPreviewState =
  | {
      readonly kind: "connection-unavailable";
      readonly connection: EnvironmentConnectionPresentation;
    }
  | { readonly kind: "asset-error"; readonly message: string }
  | { readonly kind: "preparing" }
  | { readonly kind: "ready"; readonly uri: string };

export function workspaceFileGlbPreviewState(input: {
  readonly connection: EnvironmentConnectionPresentation | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly uri: string | null;
}): WorkspaceFileGlbPreviewState {
  if (input.connection !== null && input.connection.phase !== "connected") {
    return { kind: "connection-unavailable", connection: input.connection };
  }
  // The asset URL can be a stale success alongside a failed refresh, so errors outrank a URI.
  if (input.error !== null) {
    return { kind: "asset-error", message: input.error };
  }
  if (input.uri !== null) {
    return { kind: "ready", uri: input.uri };
  }
  if (!input.isPending) {
    return { kind: "asset-error", message: "The app could not prepare this 3D model for preview." };
  }
  return { kind: "preparing" };
}
