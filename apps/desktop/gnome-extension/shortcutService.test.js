import { expect, it, vi } from "vite-plus/test";
import { ShortcutService } from "./shortcutService.js";

const name = "com.t3tools.T3Code.SnapShot.Shortcut";

function fixture(overrides = {}) {
  let vanished;
  const dependencies = {
    getNameOwner: async () => ":1.23",
    grab: vi.fn(() => 42),
    ungrab: vi.fn(),
    watch: vi.fn((_sender, callback) => {
      vanished = callback;
      return 7;
    }),
    unwatch: vi.fn(),
    isAvailable: () => true,
    activate: vi.fn(),
    ...overrides,
  };
  return { service: new ShortcutService(dependencies), ...dependencies, vanish: () => vanished() };
}

it("delivers activations only to the requesting app and releases on disconnect", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  f.service.activated(99);
  expect(f.activate).not.toHaveBeenCalled();
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledWith(":1.23");
  f.vanish();
  expect(f.ungrab).toHaveBeenCalledWith(42);
  expect(f.unwatch).toHaveBeenCalledWith(7);
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledOnce();
});

it.each([
  [":1.99", name],
  [":1.23", "other.app"],
  [":1.23", "com.t3tools.T3Code.SnapShot"],
])("rejects unauthorized caller %s owning %s", async (sender, client) => {
  const f = fixture();
  await expect(f.service.bind(sender, client, "<Control>w")).rejects.toThrow("Only T3 Code");
  expect(f.grab).not.toHaveBeenCalled();
});

it("reports a conflicting chord without registering it", async () => {
  const f = fixture({ grab: vi.fn(() => 0) });
  await expect(f.service.bind(":1.23", name, "<Control>w")).rejects.toThrow("already used");
  expect(f.watch).not.toHaveBeenCalled();
});

it("replaces the previous chord and releases everything on disable", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  f.grab.mockReturnValueOnce(43);
  await f.service.bind(":1.23", name, "<Control>r");
  expect(f.ungrab.mock.calls).toEqual([[42]]);
  f.service.activated(43);
  expect(f.activate).toHaveBeenCalledOnce();
  f.service.disable();
  expect(f.ungrab.mock.calls).toEqual([[42], [43]]);
  f.service.activated(43);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("ignores activations while the session is locked", async () => {
  let available = true;
  const f = fixture({ isAvailable: () => available });
  await f.service.bind(":1.23", name, "<Control>w");
  available = false;
  f.service.activated(42);
  expect(f.activate).not.toHaveBeenCalled();
});
