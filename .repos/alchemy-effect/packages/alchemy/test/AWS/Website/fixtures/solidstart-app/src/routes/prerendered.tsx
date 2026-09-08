/**
 * Prerendered at build time via the test's
 * `nitro: { prerender: { routes: ["/prerendered"] } }` prop — the page
 * lands in `.output/public` and is served from S3, not the Lambda.
 */
export default function Prerendered() {
  return (
    <main>
      <h1>SOLIDSTART_AWS_PRERENDERED_MARKER</h1>
    </main>
  );
}
