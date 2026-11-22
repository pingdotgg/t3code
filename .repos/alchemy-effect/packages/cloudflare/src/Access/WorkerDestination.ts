/**
 * Account-wide Worker destinations for an Access application. Protecting a
 * *specific* Worker is configured on the Worker itself (the `access` prop
 * on `Cloudflare.Worker`), which enrolls it into an application by adding
 * its `worker`/`preview_worker` destinations.
 */

/**
 * Destination covering the **production** traffic of every Worker on the
 * account — including Workers created later. Hostname-level policies take
 * precedence over Worker-level policies, which take precedence over this
 * account-level policy, so an individual Worker can still be opened up with
 * its own application.
 *
 * ```typescript
 * yield* Cloudflare.Access.Application("ProtectAllWorkers", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.AllWorkers],
 *   policies: [allowTeam],
 * });
 * ```
 */
export const AllWorkers: { type: "all_workers" } = { type: "all_workers" };

/**
 * Destination covering the **version preview URLs** of every Worker on the
 * account — including Workers created later.
 *
 * ```typescript
 * yield* Cloudflare.Access.Application("ProtectAllPreviews", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.AllWorkerPreviews],
 *   policies: [allowTeam],
 * });
 * ```
 */
export const AllWorkerPreviews: { type: "all_preview_workers" } = {
  type: "all_preview_workers",
};
