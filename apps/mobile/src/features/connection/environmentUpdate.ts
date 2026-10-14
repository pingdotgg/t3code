import type {
  ConnectionCatalogEntry,
  ConnectionOnboarding,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

/** A Connect name belongs to the host; a manual connection alias belongs to this device. */
export function updateConnectionEnvironment<A, B>(
  entry: ConnectionCatalogEntry | undefined,
  environmentId: EnvironmentId,
  updates: { readonly label: string; readonly displayUrl: string },
  commands: {
    readonly updateHost: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly patch: { readonly environmentLabel: string } };
    }) => Promise<A>;
    readonly updateBearer: (input: ConnectionOnboarding.BearerConnectionUpdateInput) => Promise<B>;
  },
): Promise<A | B> {
  return entry?.target._tag === "RelayConnectionTarget"
    ? commands.updateHost({
        environmentId,
        input: { patch: { environmentLabel: updates.label.trim() } },
      })
    : commands.updateBearer({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      });
}
