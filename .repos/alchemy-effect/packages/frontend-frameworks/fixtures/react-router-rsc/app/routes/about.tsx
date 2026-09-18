"use client";

import React from "react";

export function Component() {
  const [count, setCount] = React.useState(0);

  return (
    <main>
      <h1>About</h1>
      <p>This is the about page, rendered as a client component.</p>
      <button className="counter" onClick={() => setCount((c) => c + 1)}>
        Count is {count}
      </button>
    </main>
  );
}
