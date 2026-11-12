import { describe, expect, it } from "vite-plus/test";

import { beginForegroundHandoff, isForegroundHandoffActive } from "./foreground-handoff";

describe("foreground handoff", () => {
  it("tolerates an end function called twice", () => {
    const endFirst = beginForegroundHandoff();
    const endSecond = beginForegroundHandoff();
    endFirst();
    endFirst();
    expect(isForegroundHandoffActive()).toBe(true);
    endSecond();
    expect(isForegroundHandoffActive()).toBe(false);
  });
});
