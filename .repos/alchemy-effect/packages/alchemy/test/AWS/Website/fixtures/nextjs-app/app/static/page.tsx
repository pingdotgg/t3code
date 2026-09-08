/** @jsxImportSource react */
// Default (static) rendering: prerendered at build time into the ISR cache
// and served by the server function through the S3 incremental cache.
export default function StaticPage() {
  return (
    <main>
      <h1>NEXTJS_AWS_STATIC_MARKER</h1>
    </main>
  );
}
