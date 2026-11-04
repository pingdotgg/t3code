import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const browserTest = createOxlintRuleHarness("t3code/require-disposable-render", {
  filename: "Widget.browser.test.tsx",
});
const unitTest = createOxlintRuleHarness("t3code/require-disposable-render", {
  filename: "widget.test.tsx",
});

const reportsInputInAct = (output: string) =>
  assert.match(output, /Do not wrap real input \(userEvent or a locator's click\/fill\) in act/);

describe("t3code/require-disposable-render", () => {
  browserTest.valid(
    "allows the disposable helper",
    [
      'import { act, render } from "../test/render";',
      'import { useState } from "react";',
      'it("renders", async () => {',
      "  await using screen = await render(null);",
      "  await act(() => screen.rerender(null));",
      '  await userEvent.click(screen.getByRole("button"));',
      "  await act(() => store.setState({ open: true }));",
      "});",
    ].join("\n"),
  );
  browserTest.invalid("rejects react-dom/client", 'import { createRoot } from "react-dom/client";');
  browserTest.invalid("rejects act from react", 'import { act } from "react";');
  browserTest.invalid(
    "rejects a renamed act from react",
    'import { act as reactAct } from "react";',
  );
  browserTest.invalid(
    "rejects setting the act environment",
    "globalThis.IS_REACT_ACT_ENVIRONMENT = true;",
  );
  browserTest.invalid(
    "rejects setting the act environment by computed key",
    'window["IS_REACT_ACT_ENVIRONMENT"] = true;',
  );
  browserTest.invalid(
    "rejects stubbing the act environment",
    'vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);',
  );
  browserTest.invalid(
    "rejects userEvent wrapped in act from react",
    [
      'import { act } from "react";',
      'import { userEvent } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      "  await act(async () => {",
      "    await userEvent.click(document.body);",
      "  });",
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.invalid(
    "rejects userEvent wrapped in the render helper's act",
    [
      'import { act } from "../../test/render";',
      'import { userEvent } from "vite-plus/test/browser";',
      'it("types", async () => {',
      '  await act(() => userEvent.type(document.body, "a"));',
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.invalid(
    "rejects userEvent wrapped in a renamed render helper act",
    [
      'import { act as flush } from "../test/render.tsx";',
      'import { userEvent } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      "  await flush(async () => {",
      "    await userEvent.click(document.body);",
      "  });",
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.invalid(
    "rejects a renamed userEvent wrapped in act",
    [
      'import { act } from "../test/render";',
      'import { userEvent as ue } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      "  await act(() => ue.click(document.body));",
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.invalid(
    "rejects a locator click wrapped in act",
    [
      'import { act } from "../test/render";',
      'import { page } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      '  await act(async () => page.getByRole("button", { name: "Save" }).nth(0).click());',
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.invalid(
    "rejects React.act from a namespace import",
    [
      'import * as React from "react";',
      'it("renders", async () => {',
      "  await React.act(async () => {});",
      "});",
    ].join("\n"),
    (output) => assert.match(output, /import `act` from there/),
  );
  browserTest.invalid(
    "rejects userEvent wrapped in React.act",
    [
      'import * as React from "react";',
      'import { userEvent } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      "  await React.act(() => userEvent.click(document.body));",
      "});",
    ].join("\n"),
    reportsInputInAct,
  );
  browserTest.valid(
    "allows act around a DOM click and userEvent in a function act only defines",
    [
      'import { act } from "../test/render";',
      'import { page, userEvent } from "vite-plus/test/browser";',
      'it("clicks", async () => {',
      '  await act(async () => page.getByRole("button").element().click());',
      "  await act(async () => {",
      "    const later = () => userEvent.click(document.body);",
      "    store.setState({ later });",
      "  });",
      "});",
    ].join("\n"),
  );
  browserTest.invalid(
    "rejects lifecycle hooks through a test runner namespace",
    ['import * as vt from "vitest";', "vt.beforeEach(() => {});"].join("\n"),
  );
  browserTest.invalid(
    "rejects importing lifecycle hooks from the test runner",
    'import { beforeEach, it } from "vite-plus/test";',
  );
  browserTest.invalid("rejects afterEach", "afterEach(async () => {});");
  browserTest.invalid("rejects beforeAll", "beforeAll(() => {});");
  unitTest.valid("allows lifecycle hooks outside browser tests", "beforeEach(() => {});");
  unitTest.valid(
    "allows importing lifecycle hooks outside browser tests",
    'import { afterEach } from "vite-plus/test";',
  );
  unitTest.invalid("still rejects react-dom/client in unit tests", 'import "react-dom/client";');
});
