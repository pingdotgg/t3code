// Pages Router page coexisting with the App Router — server-rendered on
// every request via getServerSideProps.
export function getServerSideProps() {
  return { props: { stamp: "pages-router-ssr" } };
}

export default function Legacy({ stamp }) {
  return (
    <main>
      <h1>PAGES_ROUTER_MARKER</h1>
      <p>legacy-stamp:{stamp}</p>
    </main>
  );
}
