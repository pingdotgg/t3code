// Long revalidate window: within it the KV-cached payload serves as-is;
// on-demand revalidation (`revalidatePath` from /api/revalidate) purges
// the entry so the next render produces a fresh stamp — proof the
// incremental cache is WRITABLE (kv-incremental-cache), not the read-only
// static-assets flavor.
export const revalidate = 3600;

export default function Isr() {
  return (
    <main>
      <h1>ISR_FIXTURE_PAGE</h1>
      <p>isr-stamp:{Date.now()}</p>
    </main>
  );
}
