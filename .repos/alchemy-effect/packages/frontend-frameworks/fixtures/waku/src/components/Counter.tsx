"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="counter" onClick={() => setCount((value) => value + 1)}>
      count: {count}
    </button>
  );
}
