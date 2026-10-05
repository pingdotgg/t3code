// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Populates Cloudflare.Exports (the type of ctx.exports) with loopback
// bindings derived from the main module's exports.
declare namespace Cloudflare {
  interface GlobalProps {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Cloudflare typegen requires `typeof import()` for mainModule
    mainModule: typeof import("./src/worker.ts");
  }
}

// Adds `version` from the experimental `enable_version_api` compat flag.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- generic must match the original declaration for interface merging
interface ExecutionContext<Props = unknown> {
  readonly version?: {
    cohort?: string;
    key?: string;
    override?: string;
  };
}

/**
 * Minimal RPC binding type for the AccountCohortQuerier entrypoint
 * in the account-services worker. Replace with the published type from
 * `@cloudflare/workers-toolbox-types` once available with bundled deps.
 */
export interface AccountCohortQuerierBinding {
  lookupAccountCohort(accountID: string): Promise<
    | { ok: true; result: string | null; meta: { workersVersion: string } }
    | {
        ok: false;
        errors: Array<{ name: string; message: string; code: string }>;
      }
  >;
}
