import * as Schema from "effect/Schema";

// Separate module avoids an import cycle between settings and usage-limit contracts.
export const UsageLimitSourceId = Schema.String.pipe(Schema.brand("UsageLimitSourceId"));
export type UsageLimitSourceId = typeof UsageLimitSourceId.Type;

/**
 * Picks the poller and response shape: `cliproxy` reads a CLIProxyAPI hub (one entry per pooled
 * auth file); `aiusage` reads a dashboard that polls vendors for accounts not signed in here.
 */
export const UsageLimitSourceKind = Schema.Literals(["cliproxy", "aiusage", "http"]);
export type UsageLimitSourceKind = typeof UsageLimitSourceKind.Type;
