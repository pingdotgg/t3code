import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { useStableCallback } from "./useStableCallback";

function Probe({ label, handlers }: { label: string; handlers: Array<() => string> }) {
  handlers.push(useStableCallback(() => label));
  return null;
}

describe("useStableCallback", () => {
  it("keeps one identity and calls the latest committed function", async () => {
    const handlers: Array<() => string> = [];
    await using screen = await render(<Probe label="first" handlers={handlers} />);
    await screen.rerender(<Probe label="second" handlers={handlers} />);

    expect(new Set(handlers).size).toBe(1);
    expect(handlers[0]!()).toBe("second");
  });
});
