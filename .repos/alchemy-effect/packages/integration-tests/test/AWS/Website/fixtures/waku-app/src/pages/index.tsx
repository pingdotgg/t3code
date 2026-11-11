/** @jsxImportSource react */

export default async function HomePage() {
  return (
    <div>
      <div data-testid="page-marker">WAKU_AWS_PAGE_MARKER</div>
    </div>
  );
}

// Dynamic so the Lambda must render it at request time (exercises the RSC
// server bundle on the live Function URL).
export const getConfig = async () => ({ render: "dynamic" }) as const;
