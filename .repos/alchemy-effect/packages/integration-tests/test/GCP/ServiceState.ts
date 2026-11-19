import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as serviceusage from "@distilled.cloud/gcp/serviceusage_v1";
import * as Effect from "effect/Effect";

/**
 * Whether `service` (e.g. `"metastore.googleapis.com"`) is enabled in the
 * testing project. Probes that assert a create is refused while an API is
 * disabled must not run once someone enables it: the create would then
 * provision a real (and often slow, billed) resource.
 */
export const isServiceEnabled = Effect.fn(function* (service: string) {
  const { project } = yield* GcpEnvironment.current;
  const observed = yield* serviceusage.getServices({
    name: `projects/${project}/services/${service}`,
  });
  return observed.state === "ENABLED";
});
