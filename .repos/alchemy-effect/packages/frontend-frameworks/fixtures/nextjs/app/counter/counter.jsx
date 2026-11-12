"use client";

import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p data-testid="count">count:{count}</p>
      <button type="button" data-testid="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
