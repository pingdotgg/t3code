"use client";

import { useState } from "react";

export function Counter() {
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
    <section className="mt-4 flex flex-col gap-2">
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        count: {count}
      </button>
      <button type="button" onClick={loadGreeting}>
        Load greeting
      </button>
      <p role="status">{greeting}</p>
    </section>
  );
}
