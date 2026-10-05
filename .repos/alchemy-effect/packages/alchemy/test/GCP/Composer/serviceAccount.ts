import { GcpEnvironment } from "@/GCP/Environment";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";

/**
 * The test project's default Compute Engine service account
 * (`{projectNumber}-compute@developer.gserviceaccount.com`). Composer
 * rejects new environments without an explicit `nodeConfig.serviceAccount`.
 * Deploy-time only: it needs `GcpEnvironment`.
 */
export const defaultComputeServiceAccount = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const { name } = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  const projectNumber = (name ?? "").split("/").pop();
  return `${projectNumber}-compute@developer.gserviceaccount.com`;
});
