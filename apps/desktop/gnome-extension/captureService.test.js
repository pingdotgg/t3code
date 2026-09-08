import { expect, it } from "vite-plus/test";
import { CaptureService, CLIENT_NAMES, isWaylandSession } from "./captureService.js";

it("supports GNOME 50 without the removed X11 API, rejecting older X11 sessions", () => {
  expect(isWaylandSession({})).toBe(true);
  expect(isWaylandSession({ is_wayland_compositor: () => true })).toBe(true);
  expect(isWaylandSession({ is_wayland_compositor: () => false })).toBe(false);
});

function fixture(overrides = {}) {
  let snapshots = 0;
  const options = {
    getNameOwner: async (name) => (name === CLIENT_NAMES[0] ? ":1.23" : null),
    isAvailable: () => true,
    takeSnapshot: async () => {
      snapshots++;
      return "pixels";
    },
    ...overrides,
  };
  return { service: new CaptureService(options), snapshots: () => snapshots };
}

it("rejects other clients before looking at the active window", async () => {
  const { service, snapshots } = fixture();
  await expect(service.capture(":1.99")).rejects.toThrow("Only T3 Code");
  expect(snapshots()).toBe(0);
  expect(await service.capture(":1.23")).toBe("pixels");
});

it.each(CLIENT_NAMES)("accepts the current owner of %s", async (client) => {
  const { service } = fixture({ getNameOwner: async (name) => (name === client ? ":1.23" : null) });
  expect(await service.capture(":1.23")).toBe("pixels");
});

it("rechecks the name owner on each capture", async () => {
  let owner = ":1.23";
  const { service } = fixture({ getNameOwner: async () => owner });
  expect(await service.capture(owner)).toBe("pixels");
  owner = ":1.24";
  await expect(service.capture(":1.23")).rejects.toThrow("Only T3 Code");
});

it("rejects locked and non-Wayland sessions without taking a screenshot", async () => {
  const { service, snapshots } = fixture({ isAvailable: () => false });
  await expect(service.capture(":1.23")).rejects.toThrow("unavailable");
  expect(snapshots()).toBe(0);
});

it("does not start a screenshot if disabled during authorization", async () => {
  let authorize;
  const { service, snapshots } = fixture({
    getNameOwner: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  const result = service.capture(":1.23");
  service.disable();
  authorize(":1.23");
  await expect(result).rejects.toThrow("unavailable");
  expect(snapshots()).toBe(0);
});

it.each(["lock", "disable"])(
  "does not return pixels after %s during capture",
  async (operation) => {
    let available = true;
    const { service } = fixture({
      isAvailable: () => available,
      takeSnapshot: async () => {
        if (operation === "disable") service.disable();
        else available = false;
        return "private pixels";
      },
    });
    await expect(service.capture(":1.23")).rejects.toThrow("unavailable");
  },
);

it("rejects concurrent requests and clears busy after a failed capture", async () => {
  let finish;
  const started = Promise.withResolvers();
  const { service } = fixture({
    takeSnapshot: () => {
      started.resolve();
      return new Promise((_, reject) => {
        finish = reject;
      });
    },
  });
  const first = service.capture(":1.23");
  await started.promise;
  await expect(service.capture(":1.23")).rejects.toThrow("already in progress");
  finish(new Error("gone"));
  await expect(first).rejects.toThrow("gone");
  await expect(service.capture(":1.99")).rejects.toThrow("Only T3 Code");
});

it("prepares focus/effects only after pixels and identity have been captured", async () => {
  const events = [];
  const snapshot = { png: "pixels", metadata: "captured-window" };
  const { service } = fixture({
    getProcessId: async () => {
      events.push("caller-pid");
      return 42;
    },
    takeSnapshot: async () => {
      events.push("snapshot");
      return snapshot;
    },
    beginFeedback: (sender, pid, captured, options) => {
      expect([sender, pid, captured, options]).toEqual([
        ":1.23",
        42,
        snapshot,
        { flash: true, animate: true },
      ]);
      events.push("feedback");
      return true;
    },
  });
  expect(await service.capture(":1.23", { flash: true, animate: true })).toEqual({
    ...snapshot,
    animationStarted: true,
  });
  expect(events).toEqual(["caller-pid", "snapshot", "feedback"]);
});

it("does not create overlays or activate after the session locks during capture", async () => {
  let available = true;
  let feedback = 0;
  const { service } = fixture({
    getProcessId: async () => 42,
    isAvailable: () => available,
    takeSnapshot: async () => {
      available = false;
      return {};
    },
    beginFeedback: () => {
      feedback++;
    },
  });
  await expect(service.capture(":1.23", { flash: true, animate: true })).rejects.toThrow(
    "unavailable",
  );
  expect(feedback).toBe(0);
});
