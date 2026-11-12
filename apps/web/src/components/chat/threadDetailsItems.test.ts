import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  shouldShowComposerWorkspace,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: true, context: true },
    { legacy: true, items: {}, usage: true, context: true },
    { legacy: true, items: { usage: false }, usage: false, context: true },
    {
      legacy: false,
      items: { usage: true, context: false, retired: false },
      usage: true,
      context: false,
    },
  ])("shows Usage and Context by default and preserves explicit choices: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});

it.each([
  { started: false, embedded: false, items: {}, show: true },
  { started: true, embedded: false, items: {}, show: false },
  { started: true, embedded: true, items: {}, show: true },
  { started: true, embedded: false, items: { branch: false }, show: true },
  { started: true, embedded: false, items: { environment: false }, show: true },
  { started: true, embedded: false, items: { branch: false, environment: false }, show: true },
])("keeps workspace actions reachable: %o", ({ started, embedded, items, show }) => {
  const visibility = resolveThreadDetailsVisibility({
    threadDetailsItems: items,
    threadDetailsUsageEnabled: false,
  });
  expect(shouldShowComposerWorkspace({ isServerThread: started, embedded, visibility })).toBe(show);
});
