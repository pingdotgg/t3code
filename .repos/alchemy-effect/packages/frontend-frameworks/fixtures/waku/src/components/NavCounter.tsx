"use client";

import { useState } from "react";

/**
 * Lives in the (static) layout: client-side state here must survive waku's
 * client navigation, because the router keeps the layout mounted while
 * swapping page content.
 */
export function NavCounter() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="nav-counter" onClick={() => setCount((value) => value + 1)}>
      nav-count: {count}
    </button>
  );
}
