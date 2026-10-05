"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((value) => value + 1)} type="button">
      count: {count}
    </button>
  );
}
