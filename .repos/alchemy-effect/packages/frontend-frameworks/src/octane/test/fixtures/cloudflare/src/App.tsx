import { useEffect, useState } from "octane";
import "./style.css";
import { requestGreeting } from "./rpc.tsx";

export function App() {
  const [count, setCount] = useState(0);
  const [greeting, setGreeting] = useState("");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main className="rounded-2xl bg-slate-100">
      <h1>ALCHEMY_OCTANE_WORKER</h1>
      <button
        id="increment"
        data-hydrated={hydrated ? "true" : "false"}
        onClick={() => setCount(count + 1)}
      >
        increment
      </button>
      <p id="count">count:{count}</p>
      <button id="greet" onClick={async () => setGreeting(await requestGreeting("Worker"))}>
        Call server
      </button>
      <p id="greeting">{greeting}</p>
      <a href="/other">Other page</a>
    </main>
  );
}
