import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  const [greeting, setGreeting] = useState("");

  async function loadGreeting() {
    try {
      const response = await fetch("/example.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { greeting: string };
      setGreeting(body.greeting);
    } catch {
      setGreeting("Could not load the greeting. Try again.");
    }
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-3xl font-bold">Vite on Neon</h1>
      <p>Revision: {import.meta.env.VITE_REVISION ?? "development"}</p>
      <p>A React app built with Vite, without a database or a separate API service.</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        count: {count}
      </button>
      <button type="button" onClick={loadGreeting}>
        Load greeting
      </button>
      <p role="status">{greeting}</p>
    </main>
  );
}
