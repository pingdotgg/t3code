/** @jsxImportSource react */
// SSR on every request: proves the Lambda server renders, not a cached page.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>NEXTJS_AWS_PAGE_MARKER</h1>
      <p data-testid="rendered-at">rendered-at:{Date.now()}</p>
    </main>
  );
}
