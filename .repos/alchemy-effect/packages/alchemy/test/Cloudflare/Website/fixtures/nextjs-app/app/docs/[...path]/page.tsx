/** @jsxImportSource react */
// Catch-all dynamic segment, always rendered on demand in the Worker.
export const dynamic = "force-dynamic";

export default async function Docs({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  return (
    <main>
      <h1>DOCS_CATCHALL_MARKER</h1>
      <p>docs-path:{path.join("/")}</p>
    </main>
  );
}
