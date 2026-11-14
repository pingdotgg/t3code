/** @jsxImportSource react */
// ISR: prerendered at build time, served from the cache until revalidated.
export const revalidate = 3600;

export default function IsrPage() {
  return (
    <main>
      <h1>NEXTJS_AWS_ISR_MARKER</h1>
      <p id="generated">{`generated:${Date.now()}:`}</p>
    </main>
  );
}
