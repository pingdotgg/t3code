import { describe, expect, it } from "vite-plus/test";

import { beginForegroundHandoff, isForegroundHandoffActive } from "./foreground-handoff";

describe("foreground handoff", () => {
  it("is active only while a handoff is open", () => {
    expect(isForegroundHandoffActive()).toBe(false);
    const end = beginForegroundHandoff();
    expect(isForegroundHandoffActive()).toBe(true);
    end();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("stays active until every overlapping handoff ends", () => {
    const endFirst = beginForegroundHandoff();
    const endSecond = beginForegroundHandoff();
    endFirst();
    expect(isForegroundHandoffActive()).toBe(true);
    endSecond();
    expect(isForegroundHandoffActive()).toBe(false);
  });

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
