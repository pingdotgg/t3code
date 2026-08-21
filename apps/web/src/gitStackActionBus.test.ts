import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { onAddStackStep, requestAddStackStep } from "./gitStackActionBus";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stack action bus", () => {
  it("reports whether a mounted control handled the request", () => {
    vi.stubGlobal("window", new EventTarget());
    const target = { environmentId: EnvironmentId.make("environment-1"), cwd: "/repo" };
    let received: typeof target | null = null;
    const removeListener = onAddStackStep((nextTarget) => {
      received = nextTarget;
      return true;
    });

    expect(requestAddStackStep(target)).toBe(true);
    expect(received).toEqual(target);

    removeListener();
    expect(requestAddStackStep(target)).toBe(false);
  });
});
