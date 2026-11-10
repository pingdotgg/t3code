import { useState } from "octane";
import "./app.css";

export function App() {
  const [count, setCount] = useState(0);
  const [greeting, setGreeting] = useState("");

  async function loadGreeting() {
    try {
      const response = await fetch("/api/hello?name=browser");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { greeting: string };
      setGreeting(body.greeting);
    } catch {
      setGreeting("Could not load the greeting. Try again.");
    }
  }

  return (
    <main class="mx-auto flex max-w-xl flex-col gap-4 p-8 text-center">
      <h1 class="text-3xl font-bold">Octane on Neon</h1>
      <p>Server-rendered by Octane, deployed by Alchemy.</p>
      <button type="button" onClick={() => setCount(count + 1)}>
        count: {count}
      </button>
      <button type="button" onClick={loadGreeting}>
        Load greeting
      </button>
      <p role="status">{greeting}</p>
    </main>
  );
}
