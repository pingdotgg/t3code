/** @jsxImportSource react */
"use client";

import { useState } from "react";

export function Component() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>About</h1>
      <p>This client route verifies the client environment is still emitted.</p>
      <button onClick={() => setCount((c) => c + 1)}>
        Client counter: {count}
      </button>
    </main>
  );
}
