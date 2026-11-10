import { useEffect, useState } from "octane";
import "./app.css";

export function App() {
  const [count, setCount] = useState(0);
  const [visits, setVisits] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/visits")
      .then((response) => response.json())
      .then((body: { visits: number | null }) => setVisits(body.visits))
      .catch(() => setVisits(null));
  }, []);
  return (
    <main class="mx-auto flex max-w-xl flex-col gap-4 p-8 text-center">
      <h1 class="text-3xl font-bold tracking-tight">Octane on Cloudflare Workers</h1>
      <p class="text-slate-600">Server-rendered by Octane, deployed by Alchemy.</p>
      <button
        class="mx-auto rounded-lg bg-slate-900 px-4 py-2 font-medium text-white"
        onClick={() => setCount(count + 1)}
      >
        count is {count}
      </button>
      <p class="text-sm text-slate-500">
        {visits === null ? "visit count needs a deployed KV binding" : `visits: ${visits}`}
      </p>
    </main>
  );
}
