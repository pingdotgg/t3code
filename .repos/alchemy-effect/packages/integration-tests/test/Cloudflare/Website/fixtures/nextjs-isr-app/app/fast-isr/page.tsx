/** @jsxImportSource react */
// Short revalidate window: after it lapses, the next hit serves STALE and
// enqueues a background revalidation through the Durable Object queue
// (`NEXT_CACHE_DO_QUEUE`), which re-renders via `WORKER_SELF_REFERENCE`
// and writes the fresh payload back to KV.
export const revalidate = 2;

export default function FastIsr() {
  return (
    <main>
      <h1>FAST_ISR_FIXTURE_PAGE</h1>
      <p>fast-isr-stamp:{Date.now()}</p>
    </main>
  );
}
