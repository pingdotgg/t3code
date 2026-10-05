"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div className="mt-4">
      <p data-testid="count">Count: {count}</p>
      <button
        className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50"
        data-testid="increment"
        type="button"
        onClick={() => setCount((c) => c + 1)}
      >
        Increment
      </button>
    </div>
  );
}
