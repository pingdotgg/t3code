/** @jsxImportSource react */
import { Suspense } from "react";

export const dynamic = "force-dynamic";

async function Slow() {
  // Long enough that the shell flushes first, short enough to keep the
  // suite fast.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return <p>STREAMING_RESOLVED_MARKER</p>;
}

// Streaming SSR: the initial HTML shell carries the Suspense fallback and
// the resolved content arrives later in the same (chunked) response.
export default function Streaming() {
  return (
    <main>
      <h1>STREAMING_PAGE_MARKER</h1>
      <Suspense fallback={<p>STREAMING_SUSPENSE_MARKER</p>}>
        <Slow />
      </Suspense>
    </main>
  );
}
