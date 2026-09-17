/** @jsxImportSource react */
// Dynamic segment with generateStaticParams: "alpha" and "beta" prerender
// at build time (SSG); other slugs render on demand (dynamicParams default).
export function generateStaticParams() {
  return [{ slug: "alpha" }, { slug: "beta" }];
}

export default async function Product({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main>
      <h1>PRODUCT_PAGE_MARKER</h1>
      <p>product-slug:{slug}</p>
    </main>
  );
}
