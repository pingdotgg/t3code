/**
 * Shared internal helpers for the AppIntegrations service.
 * NOT exported from the service barrel.
 */

/**
 * The AppIntegrations wire TagMap is `{ [key: string]: string | undefined }`.
 * Collapse it to a plain `Record<string, string>` so it can be diffed with
 * `diffTags`.
 */
export const definedTags = (tags?: {
  [key: string]: string | undefined;
}): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};
