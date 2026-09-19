import { expect, it } from "vite-plus/test";

import { readAccessibleWindowContextWithApp } from "./SnapShotAccessibility.ts";

const bounds = { x: 0, y: 33, width: 1470, height: 857 };
const window = {
  name: "Issues · pingdotgg/t3code - Google Chrome – Profile",
  role: "window",
  bounds,
  children: async () => [],
  tree: async () => ({
    role: "window",
    name: "Issues · pingdotgg/t3code",
    children: [{ role: "link", name: "Issues" }],
  }),
};
const App = {
  byPid: async (pid: number) => ({ children: async () => (pid === 42 ? [window] : []) }),
} as unknown as Parameters<typeof readAccessibleWindowContextWithApp>[0];

const request = {
  active: {
    title: "Issues · pingdotgg/t3code",
    bounds,
    owner: { processId: 42, bundleId: "com.google.Chrome" },
  },
  platform: "darwin" as const,
  sourceTitle: "Issues · pingdotgg/t3code",
  imageSize: { width: 1470, height: 857 },
};

it("includes Chrome accessibility context when macOS adds a profile to its title", async () => {
  const context = await readAccessibleWindowContextWithApp(App, request);
  expect(context?.accessibleText).toContain("Issues");
  expect(context?.accessibility).toBeDefined();
});

it("does not borrow browser accessibility from another process or application", async () => {
  for (const owner of [
    { processId: 43, bundleId: "com.google.Chrome" },
    { processId: 42, bundleId: "com.example.Editor" },
  ]) {
    expect(
      await readAccessibleWindowContextWithApp(App, {
        ...request,
        active: { ...request.active, owner },
      }),
    ).toBeUndefined();
  }
});
