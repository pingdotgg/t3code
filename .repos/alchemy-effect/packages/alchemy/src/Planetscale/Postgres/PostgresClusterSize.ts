import * as planetscale from "@distilled.cloud/planetscale";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { pollUntil, waitForBranchReady } from "../Util.ts";

/**
 * Published PlanetScale Metal SKUs for Postgres (AWS).
 *
 * Short display names (`"M-10"`, `"M_10"`) are **not** valid SKUs. Each
 * Metal SKU encodes CPU series, compute size, provider, architecture, and
 * NVMe storage size.
 *
 * Hyphenated SKUs copied from PlanetScale's pricing docs
 * (`"M1-10-AWS-ARM-D-METAL-10"`) are accepted and normalized to
 * underscores by {@link toPostgresClusterSku}. GCP and custom SKUs are
 * still valid via {@link PostgresClusterSize}'s open-string fallback.
 *
 * @see https://planetscale.com/docs/postgres/pricing
 * @see https://planetscale.com/docs/metal
 */
export type PostgresMetalClusterSize =
  | "M1_10_AWS_ARM_D_METAL_10"
  | "M1_10_AWS_AMD_D_METAL_10"
  | "M1_10_AWS_ARM_D_METAL_25"
  | "M1_10_AWS_AMD_D_METAL_25"
  | "M1_10_AWS_ARM_D_METAL_50"
  | "M1_10_AWS_AMD_D_METAL_50"
  | "M1_10_AWS_ARM_D_METAL_100"
  | "M1_10_AWS_AMD_D_METAL_100"
  | "M1_10_AWS_ARM_D_METAL_200"
  | "M1_10_AWS_AMD_D_METAL_200"
  | "M1_20_AWS_ARM_D_METAL_10"
  | "M1_20_AWS_AMD_D_METAL_10"
  | "M1_20_AWS_ARM_D_METAL_25"
  | "M1_20_AWS_AMD_D_METAL_25"
  | "M1_20_AWS_ARM_D_METAL_50"
  | "M1_20_AWS_AMD_D_METAL_50"
  | "M1_20_AWS_ARM_D_METAL_100"
  | "M1_20_AWS_AMD_D_METAL_100"
  | "M1_20_AWS_ARM_D_METAL_200"
  | "M1_20_AWS_AMD_D_METAL_200"
  | "M1_40_AWS_ARM_D_METAL_10"
  | "M1_40_AWS_AMD_D_METAL_10"
  | "M1_40_AWS_ARM_D_METAL_25"
  | "M1_40_AWS_AMD_D_METAL_25"
  | "M1_40_AWS_ARM_D_METAL_50"
  | "M1_40_AWS_AMD_D_METAL_50"
  | "M1_40_AWS_ARM_D_METAL_100"
  | "M1_40_AWS_AMD_D_METAL_100"
  | "M1_40_AWS_ARM_D_METAL_200"
  | "M1_40_AWS_AMD_D_METAL_200"
  | "M1_40_AWS_ARM_D_METAL_400"
  | "M1_40_AWS_AMD_D_METAL_400"
  | "M1_40_AWS_ARM_D_METAL_800"
  | "M1_40_AWS_AMD_D_METAL_800"
  | "M1_40_AWS_ARM_D_METAL_1200"
  | "M1_40_AWS_AMD_D_METAL_1200"
  | "M1_80_AWS_ARM_D_METAL_100"
  | "M1_80_AWS_AMD_D_METAL_100"
  | "M1_80_AWS_ARM_D_METAL_200"
  | "M1_80_AWS_AMD_D_METAL_200"
  | "M1_80_AWS_ARM_D_METAL_400"
  | "M1_80_AWS_AMD_D_METAL_400"
  | "M1_80_AWS_ARM_D_METAL_800"
  | "M1_80_AWS_AMD_D_METAL_800"
  | "M1_80_AWS_ARM_D_METAL_1200"
  | "M1_80_AWS_AMD_D_METAL_1200"
  | "M1_160_AWS_ARM_D_METAL_100"
  | "M1_160_AWS_AMD_D_METAL_100"
  | "M1_160_AWS_ARM_D_METAL_200"
  | "M1_160_AWS_AMD_D_METAL_200"
  | "M1_160_AWS_ARM_D_METAL_400"
  | "M1_160_AWS_AMD_D_METAL_400"
  | "M1_160_AWS_ARM_D_METAL_800"
  | "M1_160_AWS_AMD_D_METAL_800"
  | "M1_160_AWS_ARM_D_METAL_1200"
  | "M1_160_AWS_AMD_D_METAL_1200"
  | "M8_160_AWS_ARM_D_METAL_118"
  | "M6_160_AWS_INTEL_D_METAL_118"
  | "M7_160_AWS_INTEL_D_METAL_468"
  | "M7_160_AWS_INTEL_D_METAL_1250"
  | "M8_320_AWS_ARM_D_METAL_237"
  | "M6_320_AWS_INTEL_D_METAL_237"
  | "M7_320_AWS_INTEL_D_METAL_937"
  | "M7_320_AWS_INTEL_D_METAL_2500"
  | "M8_640_AWS_ARM_D_METAL_474"
  | "M6_640_AWS_INTEL_D_METAL_474"
  | "M7_640_AWS_INTEL_D_METAL_1875"
  | "M7_640_AWS_INTEL_D_METAL_5000"
  | "M7_960_AWS_INTEL_D_METAL_7500"
  | "M8_1280_AWS_ARM_D_METAL_950"
  | "M6_1280_AWS_INTEL_D_METAL_950"
  | "M7_1280_AWS_INTEL_D_METAL_3750"
  | "M7_1920_AWS_INTEL_D_METAL_15000"
  | "M8_2560_AWS_ARM_D_METAL_1900"
  | "M6_2560_AWS_INTEL_D_METAL_1900"
  | "M7_2560_AWS_INTEL_D_METAL_7500"
  | "M8_3840_AWS_ARM_D_METAL_2850"
  | "M6_3840_AWS_INTEL_D_METAL_2850"
  | "M7_3840_AWS_INTEL_D_METAL_11250"
  | "M7_3840_AWS_INTEL_D_METAL_30000"
  | "M8_5120_AWS_ARM_D_METAL_3800"
  | "M6_5120_AWS_INTEL_D_METAL_3800"
  | "M7_5120_AWS_INTEL_D_METAL_15000"
  | "M7_5760_AWS_INTEL_D_METAL_45000"
  | "M8_7680_AWS_ARM_D_METAL_5700"
  | "M6_7680_AWS_INTEL_D_METAL_5700"
  | "M7_7680_AWS_INTEL_D_METAL_22500"
  | "M7_7680_AWS_INTEL_D_METAL_60000"
  | "M6_10240_AWS_INTEL_D_METAL_7600"
  | "M8_15360_AWS_ARM_D_METAL_11400"
  | "M7_15360_AWS_INTEL_D_METAL_45000"
  | "M7_15360_AWS_INTEL_D_METAL_120000";

/**
 * Available PlanetScale PostgreSQL cluster sizes.
 *
 * ## Network-attached storage (NAS)
 *
 * `PS_*` sizes are backed by network-attached storage and can be specified
 * either as the short size (`"PS_10"`) or the API SKU (`"PS_10_AWS_X86"`).
 * Short NAS sizes are expanded to a SKU by {@link toPostgresClusterSku}
 * using the target region and arch.
 *
 * ## Metal
 *
 * [PlanetScale Metal](https://planetscale.com/docs/metal) sizes are backed
 * by locally-attached NVMe. Pass a **full Metal SKU** from
 * {@link PostgresMetalClusterSize} — short `M-*` names are not valid on
 * their own because Metal SKUs also encode CPU series, architecture, and
 * drive size. See [Postgres pricing](https://planetscale.com/docs/postgres/pricing).
 *
 * @see https://planetscale.com/docs/postgres/pricing
 * @see https://planetscale.com/docs/metal
 */
export type PostgresClusterSize =
  | "PS_DEV"
  | "PS_5"
  | "PS_10"
  | "PS_20"
  | "PS_40"
  | "PS_80"
  | "PS_160"
  | "PS_320"
  | "PS_640"
  | "PS_1280"
  | "PS_2560"
  | PostgresMetalClusterSize
  | (string & {});

/**
 * Converts a {@link PostgresClusterSize} into the SKU string expected by
 * the PlanetScale API.
 *
 * Hyphens are normalized to underscores so SKUs copied from PlanetScale
 * docs (`"PS-10"`, `"M1-10-AWS-ARM-D-METAL-10"`) match the API form.
 *
 * For NAS-backed clusters, the API expects a suffixed name like
 * `PS_<size>_<provider>_<arch>`. Short `PS_*` sizes are expanded using the
 * supplied region and arch.
 *
 * Metal-backed sizes (anything starting with `M`) are passed through after
 * hyphen normalization. The short `M_*` / `M-*` form is not a valid SKU on
 * its own — the API requires the full Metal SKU (e.g.
 * `M1_10_AWS_ARM_D_METAL_10`), which encodes the CPU series, provider,
 * arch, and storage size.
 *
 * Already-suffixed NAS sizes are also passed through unchanged.
 */
export function toPostgresClusterSku(input: {
  size: PostgresClusterSize;
  arch?: "x86" | "arm";
  region?: string;
}): string {
  const size = input.size.replaceAll("-", "_");
  if (!size.startsWith("PS_") || size.match(/(AWS|GCP)/)) return size;
  // Not all AWS regions start with "aws-", but all GCP regions start with "gcp-".
  const provider = input.region?.startsWith("gcp") ? "GCP" : "AWS";
  const arch = (input.arch ?? "x86").toUpperCase();
  return `${size}_${provider}_${arch}`;
}

/**
 * Schedule for polling branch change requests. Postgres cluster resizes
 * routinely take longer than the default 10-minute polling budget, so
 * give change requests a 60-minute budget (720 × 5s).
 */
const changeRequestSchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(720),
]);

/**
 * Polls branch change requests until all visible changes are in a terminal
 * state (`completed` or `canceled`), or — if `changeId` is provided — until
 * that specific change reaches a terminal state.
 */
export const waitForPendingPostgresChanges = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  changeId?: string,
) {
  yield* pollUntil(
    `changes for branch "${branch}"`,
    planetscale.listBranchChangeRequests({
      organization,
      database,
      branch,
      page: 1,
      per_page: 25,
    }),
    (page) => {
      const isTerminal = (state: string) =>
        state === "completed" || state === "canceled";

      if (changeId) {
        const change = page.data.find((change) => change.id === changeId);
        return change ? isTerminal(change.state) : false;
      }

      return page.data.every((change) => isTerminal(change.state));
    },
    changeRequestSchedule,
  );
});

/**
 * Ensures a PostgreSQL production branch has the expected cluster size,
 * queuing the change via the change-request API if it doesn't.
 */
export const ensurePostgresProductionBranchClusterSize = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: PostgresClusterSize,
) {
  // A freshly-forked branch can't accept (or complete) change requests
  // until it has finished provisioning — queueing a resize against it
  // just leaves the change pending until the poll budget runs out.
  const data = yield* waitForBranchReady(organization, database, branch);

  const sku = toPostgresClusterSku({
    size: expectedClusterSize,
    arch: data.cluster_architecture === "aarch64" ? "arm" : "x86",
    region: data.region.slug,
  });

  if (data.cluster_name === sku) {
    return;
  }
  yield* waitForPendingPostgresChanges(organization, database, branch);
  const change = yield* planetscale.updateBranchChangeRequest({
    organization,
    database,
    branch,
    cluster_size: sku,
  });
  yield* waitForPendingPostgresChanges(
    organization,
    database,
    branch,
    change.id,
  );
});
