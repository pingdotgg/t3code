import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { LAB_REMOTE_ENVIRONMENTS } from "./environments";

/** Saves each remote environment, as pairing one would. Its connection opens through labDriver. */
export async function registerLabEnvironments(): Promise<void> {
  const httpBaseUrl = window.location.origin;
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  for (const environment of LAB_REMOTE_ENVIRONMENTS) {
    const result = await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.register,
      new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: environment.id,
          label: environment.label,
          connectionId: environment.id,
        }),
        profile: new BearerConnectionProfile({
          connectionId: environment.id,
          environmentId: environment.id,
          label: environment.label,
          httpBaseUrl,
          wsBaseUrl,
        }),
        credential: new BearerConnectionCredential({ token: "lab" }),
      }),
      { reportFailure: false },
    );
    if (result._tag === "Failure")
      console.warn("Lab environment not registered", environment.id, result.cause);
  }
}
