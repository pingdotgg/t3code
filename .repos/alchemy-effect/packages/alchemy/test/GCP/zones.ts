import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Region and zone for capacity-bound tests: GKE clusters and node pools,
 * Dataproc clusters, Compute VMs, Workstations, and zonal Filestore.
 *
 * The profile's default region (`us-central1`) is the busiest GCP region;
 * full-suite runs regularly hit "Google Compute Engine does not have enough
 * resources available" stockouts there, which turn minute-long creates into
 * hour-long retries. Keep API-only and regional-control-plane resources on
 * the default region, and pin anything that schedules VMs here.
 */
export const CAPACITY_REGION = "us-west1";

/** Primary zone in {@link CAPACITY_REGION}. */
export const CAPACITY_ZONE = "us-west1-b";

/**
 * Region for the GKE smoke test. Its LoadBalancer needs an external IP, and
 * the project allows 8 in-use external addresses per region; the other GKE,
 * Dataproc and Composer tests use up {@link CAPACITY_REGION}'s during a full
 * run, which leaves the smoke Service without an address.
 */
export const SMOKE_REGION = "us-east1";

/** Second zone in {@link CAPACITY_REGION}, for tests that need two zones. */
export const CAPACITY_ZONE_2 = "us-west1-c";

/**
 * The project allows 3 GKE clusters per location. Every test that creates a
 * cluster holds a slot for its whole body (deploy through destroy), so a
 * full `pnpm test test/GCP` run never exceeds the quota.
 */
const gkeClusterSlots = Semaphore.makeUnsafe(3);

/** Run a cluster-creating test body while holding one GKE cluster slot. */
export const withGkeClusterSlot = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => gkeClusterSlots.withPermits(1)(self);
