/** @jsxImportSource react */
// A long revalidate window: the test asserts the *prerendered* payload
// serves (the static-assets incremental cache is read-only), not a
// revalidation round-trip.
export const revalidate = 3600;

export default function IsrPage() {
  return (
    <main>
      <h1>NEXTJS_ISR_MARKER</h1>
      <p data-testid="isr-rendered-at">isr-rendered-at:{Date.now()}</p>
    </main>
  );
}
