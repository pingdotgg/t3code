import type { PageServerLoad } from "./$types";

/**
 * Exercises the dev/live `platform` beyond literal env values:
 *
 * - `FIXTURE_KV` — a real KV namespace binding. In dev it round-trips
 *   through cloudflare-runtime's platform proxy (workerd hosting the local
 *   namespace); live it is the real (miniflare/workerd) binding.
 * - `FIXTURE_OVERRIDE` — declared both as a Text binding ("proxied-value")
 *   and as a dev `env` literal ("literal-override"); dev must serve the
 *   literal, live the binding value.
 * - `platform.cf` — present in both modes (the proxy serves wrangler's
 *   mock object in dev; workerd provides `request.cf` live).
 */
export const load: PageServerLoad = async ({ platform }) => {
  const kv = platform?.env?.FIXTURE_KV;
  let kvValue = "no-kv-binding";
  if (kv !== undefined) {
    await kv.put("fixture-key", "kv-round-trip");
    kvValue = (await kv.get("fixture-key")) ?? "kv-miss";
  }
  return {
    kvValue,
    override: platform?.env?.FIXTURE_OVERRIDE ?? "no-override",
    colo: typeof platform?.cf?.colo === "string" ? "present" : "absent",
  };
};
