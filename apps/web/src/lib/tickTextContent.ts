import { secondTick } from "@t3tools/client-runtime/clock";

/**
 * Ref callback that writes `format(Date.now())` into a node and, while `live`,
 * rewrites it on the shared second tick. Running timers update through the DOM
 * so a ticking label never re-renders the timeline or composer around it.
 */
export function tickTextContent(format: (nowMs: number) => string, live: boolean) {
  return (node: HTMLElement | null) => {
    if (!node) return;
    const write = () => {
      const text = format(Date.now());
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    return live ? secondTick.subscribe(write) : undefined;
  };
}
