// A long revalidate window: the tests assert the *prerendered* payload
// serves (same stamp on repeated hits), not a revalidation round-trip —
// the static-assets incremental cache is read-only.
export const revalidate = 3600;

export default function IsrPage() {
  return (
    <main>
      <h1>ISR page</h1>
      <p data-testid="isr-rendered-at">isr-rendered-at:{Date.now()}</p>
    </main>
  );
}
