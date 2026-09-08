import { useEffect, useState } from "octane";

// A plain string constant so the marker survives compilation/minification
// verbatim inside the client bundle — the live test fetches the built
// `/assets/*.js` module and asserts the marker is present (the content
// that hydrates in the browser; it never appears in the HTML shell).
const PAGE_MARKER = "OCTANE_SPA_PAGE_MARKER";

export function App() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return (
    <main>
      <h1 data-testid="page-marker">{PAGE_MARKER}</h1>
      <button
        id="increment"
        data-hydrated={hydrated ? "true" : "false"}
        onClick={() => setCount(count + 1)}
      >
        increment
      </button>
      <p id="count">count:{count}</p>
    </main>
  );
}
