import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const browserTest = createOxlintRuleHarness("t3code/no-frame-waits-in-browser-tests", {
  filename: "Widget.browser.test.tsx",
});
const unitTest = createOxlintRuleHarness("t3code/no-frame-waits-in-browser-tests", {
  filename: "widget.test.tsx",
});

describe("t3code/no-frame-waits-in-browser-tests", () => {
  browserTest.valid(
    "allows retrying assertions and the full fake timer set",
    [
      'it("debounces", async () => {',
      "  await using screen = await render(null);",
      "  using _timers = fakeTimers();",
      "  vi.advanceTimersByTime(200);",
      '  await expect.element(screen.getByRole("button")).toBeVisible();',
      "  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());",
      "});",
    ].join("\n"),
  );
  browserTest.valid(
    "allows requestAnimationFrame inside mocks",
    [
      'vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {',
      "  callback(0);",
      "  return 0;",
      "});",
      "const frame = vi.fn((callback) => requestAnimationFrame(callback));",
      'vi.stubGlobal("requestAnimationFrame", (callback) => window.requestAnimationFrame(callback));',
      'stubGlobal("requestAnimationFrame", (callback) => requestAnimationFrame(callback));',
    ].join("\n"),
  );
  browserTest.valid(
    "allows timers outside a promise executor and other listeners",
    [
      "const id = setTimeout(() => undefined, 10);",
      'panel.addEventListener("click", () => undefined);',
      "const deferred = new Promise((resolve) => (finish = resolve));",
    ].join("\n"),
  );

  browserTest.invalid(
    "rejects a nextFrame helper",
    "const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));",
  );
  browserTest.invalid(
    "rejects requestAnimationFrame as the executor",
    "await new Promise(requestAnimationFrame);",
  );
  browserTest.invalid(
    "rejects window.requestAnimationFrame",
    "window.requestAnimationFrame(() => undefined);",
  );
  browserTest.valid(
    "allows a pass-through frame executor inside a mock implementation",
    "const paint = vi.fn(() => new Promise(requestAnimationFrame));",
  );
  browserTest.invalid(
    "rejects setTimeout passed straight through as the promise executor",
    "await new Promise(setTimeout);",
  );
  browserTest.invalid(
    "rejects setTimeout inside a promise executor",
    "await new Promise((resolve) => setTimeout(resolve, 50));",
  );
  browserTest.invalid(
    "rejects setInterval inside a promise executor",
    "await new Promise(function (resolve) { window.setInterval(resolve, 50); });",
  );
  browserTest.invalid(
    "rejects transitionend listeners",
    'panel.addEventListener("transitionend", () => resolve(), { once: true });',
  );
  browserTest.invalid(
    "rejects animationend listeners",
    'panel.addEventListener("animationend", () => resolve());',
  );
  browserTest.invalid("rejects vi.useFakeTimers", "vi.useFakeTimers();");
  browserTest.invalid(
    "rejects a partial fakeTimers set",
    'const timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });',
  );
  browserTest.invalid(
    "rejects a partial vi.useFakeTimers set",
    'vi.useFakeTimers({ toFake: ["setTimeout"] });',
  );

  unitTest.valid(
    "ignores files that are not browser tests",
    ["vi.useFakeTimers();", "await new Promise(requestAnimationFrame);"].join("\n"),
  );
});
