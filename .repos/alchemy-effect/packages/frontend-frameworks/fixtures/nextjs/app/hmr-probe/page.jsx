import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

// Dedicated page for the hmr-mode dev spec (test/hmr.test.ts): the spec
// temporarily edits the marker below and polls until the dev server serves
// the change, then restores this file. Keep the marker on its own line.
export default function HmrProbe() {
  const { env } = getCloudflareContext();
  return (
    <main>
      <h1 data-testid="hmr-marker">hmr-probe marker:v1</h1>
      <p data-testid="hmr-binding">hmr-binding:{env.TEST_TEXT ?? "missing"}</p>
    </main>
  );
}
