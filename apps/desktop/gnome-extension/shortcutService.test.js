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

it.each([name, "com.t3tools.T3Code.Development.SnapShot.Shortcut"])(
  "accepts %s without claiming the capture bus name",
  async (client) => {
    const f = fixture();
    await f.service.bind(":1.23", client, "<Control>w");
    expect(f.grab).toHaveBeenCalledOnce();
  },
);

it.each([
  [":1.99", name],
  [":1.23", "other.app"],
  [":1.23", "com.t3tools.T3Code.SnapShot"],
])("rejects unauthorized callers %s %s", async (sender, client) => {
  const f = fixture();
  await expect(f.service.bind(sender, client, "<Control>w")).rejects.toThrow("Only T3 Code");
  expect(f.grab).not.toHaveBeenCalled();
});

it("reports conflicts and does not install a listener", async () => {
  const f = fixture({ grab: vi.fn(() => 0) });
  await expect(f.service.bind(":1.23", name, "<Control>w")).rejects.toThrow("already used");
  expect(f.watch).not.toHaveBeenCalled();
});

it("replaces the old chord and releases the replacement on disable", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  f.grab.mockReturnValueOnce(43);
  await f.service.bind(":1.23", name, "<Control>r");
  expect(f.ungrab.mock.calls).toEqual([[42]]);
  f.service.activated(42);
  expect(f.activate).not.toHaveBeenCalled();
  f.service.activated(43);
  expect(f.activate).toHaveBeenCalledOnce();
  f.service.disable();
  expect(f.ungrab.mock.calls).toEqual([[42], [43]]);
  expect(f.unwatch).toHaveBeenCalledTimes(2);
  f.service.activated(43);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("does not register after disable during authorization", async () => {
  const authorization = Promise.withResolvers();
  const f = fixture({ getNameOwner: () => authorization.promise });
  const pending = f.service.bind(":1.23", name, "<Control>w");
  f.service.disable();
  authorization.resolve(":1.23");
  await expect(pending).rejects.toThrow("unavailable");
  expect(f.grab).not.toHaveBeenCalled();
});

it("suppresses locked-session activations and resumes on unlock", async () => {
  let available = true;
  const f = fixture({ isAvailable: () => available });
  await f.service.bind(":1.23", name, "<Control>w");
  available = false;
  f.service.activated(42);
  expect(f.activate).not.toHaveBeenCalled();
  await expect(f.service.bind(":1.23", name, "<Control>w")).rejects.toThrow("unavailable");
  available = true;
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("keeps the original shortcut active when its replacement conflicts", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  f.grab.mockReturnValueOnce(0);
  await expect(f.service.bind(":1.23", name, "<Control>r")).rejects.toThrow("already used");
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledWith(":1.23");
  expect(f.ungrab).not.toHaveBeenCalled();
  f.vanish();
  expect(f.ungrab).toHaveBeenCalledWith(42);
});

it("keeps the original shortcut active when watching its replacement fails", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  f.grab.mockReturnValueOnce(43);
  f.watch.mockImplementationOnce(() => {
    throw new Error("Cannot watch sender");
  });
  await expect(f.service.bind(":1.23", name, "<Control>r")).rejects.toThrow("Cannot watch sender");
  expect(f.ungrab.mock.calls).toEqual([[43]]);
  f.service.activated(43);
  expect(f.activate).not.toHaveBeenCalled();
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledWith(":1.23");
  f.vanish();
  expect(f.ungrab.mock.calls).toEqual([[43], [42]]);
});

it("keeps a repeated binding active without grabbing it again", async () => {
  const f = fixture();
  await f.service.bind(":1.23", name, "<Control>w");
  await f.service.bind(":1.23", name, "<Control>w");
  expect(f.grab).toHaveBeenCalledOnce();
  expect(f.ungrab).not.toHaveBeenCalled();
  f.service.activated(42);
  expect(f.activate).toHaveBeenCalledWith(":1.23");
});
