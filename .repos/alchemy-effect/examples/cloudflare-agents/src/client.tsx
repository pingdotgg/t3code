import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Counter, CounterState } from "./server.ts";
import "./styles.css";

function App() {
  const [state, setState] = useState<CounterState>({ count: 0, reminders: 0 });
  // Connects to the `Counter` agent named "demo" and mirrors its state.
  const agent = useAgent<Counter, CounterState>({
    agent: "counter",
    name: "demo",
    onStateUpdate: setState,
  });
  return (
    <main className="mx-auto max-w-md p-8 font-sans">
      <h1 className="text-3xl font-bold">Agents on Alchemy</h1>
      <p className="mt-4">Count: {state.count}</p>
      <button
        className="mt-2 rounded bg-black px-4 py-2 text-white"
        onClick={() => agent.stub.increment(1)}
      >
        Increment
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
