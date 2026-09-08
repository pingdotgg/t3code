import { CLIENT_MARKER } from "./client-marker.ts";
import type * as ClientMarker from "./client-marker.ts";

const marker = document.querySelector<HTMLParagraphElement>("#client-marker")!;
const render = (value: string) => {
  marker.textContent = value;
};
render(CLIENT_MARKER);

// The counter is the HMR state witness: a HOT update to ./client-marker.ts
// leaves this module (and `count`) alive, while a full page reload resets
// the counter to 0 — the client HMR spec asserts the count survives.
const button = document.querySelector<HTMLButtonElement>("#counter")!;
let count = 0;
const setCount = (next: number) => {
  count = next;
  button.textContent = `Count is ${count}`;
};
button.addEventListener("click", () => setCount(count + 1));
setCount(0);

if (import.meta.hot) {
  // Accept updates to the marker module only: vite re-fetches the dep and
  // runs this callback in place — this module is NOT re-executed.
  import.meta.hot.accept("./client-marker.ts", (mod) => {
    if (mod) {
      render((mod as typeof ClientMarker).CLIENT_MARKER);
    }
  });
}
