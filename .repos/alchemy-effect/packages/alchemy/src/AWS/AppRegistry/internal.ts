/**
 * Derives a deterministic AppRegistry client token from the resource's
 * instance ID so retried creates never double-provision.
 */
export const clientToken = (instanceId: string): string =>
  instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 64) || "alchemy";

/**
 * Drops AWS-managed system tags (`aws:*`, case-insensitive) from an
 * observed tag map. AppRegistry stamps resources with system tags (e.g.
 * `aws:servicecatalog:applicationName`) that customers cannot remove —
 * including them in the diff baseline makes untagResource fail with
 * "Customers cannot remove tag keys starting with aws:".
 */
export const stripAwsSystemTags = (
  tags: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags).filter(
      ([key]) => !key.toLowerCase().startsWith("aws:"),
    ),
  );
