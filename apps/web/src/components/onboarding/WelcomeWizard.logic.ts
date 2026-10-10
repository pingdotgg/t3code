import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";

import { presentSavedCloudEnvironmentConnection } from "../cloud/cloudEnvironmentConnectionPresentation";

export type WizardEnvironmentStatus =
  | { readonly kind: "off"; readonly text: "Off" }
  | { readonly kind: "unsupported"; readonly text: string }
  | { readonly kind: "on"; readonly text: string };

/**
 * Status shown next to a computer in the welcome wizard. A switched-off
 * environment never opens a socket, so it must not read as connecting; the
 * wizard offers to turn it on instead. An unsupported server is kept off by
 * the registry and cannot be turned on, so it shows the reason, not the action.
 */
export function resolveWizardEnvironmentStatus(input: {
  readonly enabled: boolean;
  readonly unsupportedReason?: string | undefined;
  readonly connection: EnvironmentConnectionPresentation;
}): WizardEnvironmentStatus {
  if (input.unsupportedReason !== undefined) {
    return { kind: "unsupported", text: `Not supported: ${input.unsupportedReason}` };
  }
  if (!input.enabled) return { kind: "off", text: "Off" };
  return { kind: "on", text: presentSavedCloudEnvironmentConnection(input.connection).buttonLabel };
}
