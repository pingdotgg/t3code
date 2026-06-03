import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import { pollUntil } from "../Util.ts";

/**
 * Available PlanetScale PostgreSQL cluster sizes.
 *
 * `PS_*` sizes are backed by network-attached storage (NAS) and can be
 * specified either as the short size (`"PS_10"`) or the API SKU
 * (`"PS_10_AWS_X86"`). Short NAS sizes are expanded to a SKU by
 * {@link toPostgresClusterSku} using the target region and arch.
 *
 * @see https://planetscale.com/docs/postgres/pricing
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
  | (string & {});

/**
 * Converts a {@link PostgresClusterSize} into the SKU string expected by
 * the PlanetScale API.
 *
 * For NAS-backed clusters, the API expects a suffixed name like
 * `PS_<size>_<provider>_<arch>`. Short `PS_*` sizes are expanded using the
 * supplied region and arch.
 *
 * Metal-backed sizes (anything starting with `M`) are passed through
 * unchanged. The short `M_*` form is not a valid SKU on its own — the API
 * requires the full Metal SKU (e.g. `M6_640_AWS_INTEL_D_METAL_474`), which
 * encodes the CPU series, provider, arch, and storage size
 *
 * Already-suffixed NAS sizes are also passed through unchanged.
 */
export function toPostgresClusterSku(input: {
  size: PostgresClusterSize;
  arch?: "x86" | "arm";
  region?: string;
}): string {
  const size = input.size;
  if (!size.startsWith("PS_") || size.match(/(AWS|GCP)/)) return size;
  // Not all AWS regions start with "aws-", but all GCP regions start with "gcp-".
  const provider = input.region?.startsWith("gcp") ? "GCP" : "AWS";
  const arch = (input.arch ?? "x86").toUpperCase();
  return `${size}_${provider}_${arch}`;
}

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
    ops.listBranchChangeRequests({
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
  const data = yield* ops.getBranch({ organization, database, branch });

  const sku = toPostgresClusterSku({
    size: expectedClusterSize,
    arch: data.cluster_architecture === "aarch64" ? "arm" : "x86",
    region: data.region.slug,
  });

  if (data.cluster_name === sku) {
    return;
  }
  yield* waitForPendingPostgresChanges(organization, database, branch);
  const change = yield* ops.updateBranchChangeRequest({
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
