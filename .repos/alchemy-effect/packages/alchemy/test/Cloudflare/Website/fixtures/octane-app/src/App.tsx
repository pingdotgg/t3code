import { useEffect, useState } from "octane";

export function App() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return (
    <main>
      <h1 data-testid="page-marker">OCTANE_PAGE_MARKER</h1>
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
