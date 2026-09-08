import { beforeEach, expect, it, vi } from "vite-plus/test";

const shell = vi.hoisted(() => ({
  windows: [],
  actors: [],
  timers: new Map(),
  watchers: new Map(),
  mapped: new Map(),
  next: 1,
  animations: true,
  locked: false,
  activate: vi.fn(),
}));
vi.mock("gi://Clutter", () => ({
  default: {
    Actor: class {
      constructor(props) {
        Object.assign(this, props);
        shell.actors.push(this);
      }
      ease(props) {
        this.transition = props;
      }
      destroy() {
        this.destroyed = true;
        this.transition?.onStopped?.();
      }
    },
    AnimationMode: { EASE_OUT_QUAD: 1, EASE_OUT_CUBIC: 2 },
  },
}));
vi.mock("gi://Gio", () => ({
  default: {
    DBus: { session: {} },
    BusNameWatcherFlags: { NONE: 0 },
    bus_watch_name_on_connection: (_bus, name, _flags, _appeared, vanished) => {
      const id = shell.next++;
      shell.watchers.set(id, { name, vanished });
      return id;
    },
    bus_unwatch_name: (id) => shell.watchers.delete(id),
  },
}));
vi.mock("gi://GLib", () => ({
  default: {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    timeout_add: (_priority, _ms, callback) => {
      const id = shell.next++;
      shell.timers.set(id, callback);
      return id;
    },
    source_remove: (id) => shell.timers.delete(id),
  },
}));
vi.mock("gi://Meta", () => ({ default: { WindowType: { NORMAL: 0 } } }));
vi.mock("gi://St", () => ({
  default: { Settings: { get: () => ({ enable_animations: shell.animations }) } },
}));
vi.mock("resource:///org/gnome/shell/ui/main.js", () => ({
  sessionMode: {
    get isLocked() {
      return shell.locked;
    },
    isGreeter: false,
  },
  uiGroup: { add_child: () => {} },
  activateWindow: shell.activate,
}));

import { CaptureFeedback } from "./captureFeedback.js";

beforeEach(() => {
  shell.windows = [];
  shell.actors = [];
  shell.timers.clear();
  shell.watchers.clear();
  shell.mapped.clear();
  shell.activate.mockClear();
  shell.animations = true;
  shell.locked = false;
  Object.assign(globalThis, {
    get_window_actors: () => shell.windows.map((meta_window) => ({ meta_window })),
    get_current_time: () => 123,
    window_manager: {
      connect: (_signal, callback) => {
        const id = shell.next++;
        shell.mapped.set(id, callback);
        return id;
      },
      disconnect: (id) => shell.mapped.delete(id),
    },
  });
});

const bounds = { x: -1200, y: 20, width: 1000, height: 800 };
function begin(animate = true) {
  const feedback = new CaptureFeedback();
  const started = feedback.begin(
    ":1.23",
    42,
    { content: "frozen pixels", bounds, bufferBounds: bounds },
    { flash: false, animate },
  );
  return { feedback, started };
}
function target(pid = 42) {
  return {
    get_pid: () => pid,
    get_title: () => "T3",
    get_window_type: () => 0,
    get_frame_rect: () => bounds,
    frame_rect_to_client_rect: (rect) => rect,
  };
}

it("activates the caller, flies its frozen capture, and retains the landed image until disconnect", async () => {
  const window = target();
  shell.windows = [target(99), window];
  const { feedback, started } = begin();
  expect(started).toBe(true);
  await feedback.activate(":1.23", "T3");
  expect(shell.activate).toHaveBeenCalledWith(window, 123);
  const flight = feedback.animate(":1.23", { x: 0.1, y: 0.8, width: 0.2, height: 0.1 });
  const actor = shell.actors[0];
  expect(actor.content).toBe("frozen pixels");
  expect(actor.transition).toMatchObject({ x: -1100, y: 660, scale_x: 0.2, scale_y: 0.1 });
  actor.transition.onStopped();
  await flight;
  expect(actor.destroyed).not.toBe(true);
  for (const { vanished } of shell.watchers.values()) vanished();
  expect(actor.destroyed).toBe(true);
  expect(shell.watchers.size).toBe(0);
  expect(shell.timers.size).toBe(0);
});

it("waits for T3 to remap and cancels that wait when disabled", async () => {
  const { feedback } = begin();
  const activation = feedback.activate(":1.23", "T3");
  expect(shell.activate).not.toHaveBeenCalled();
  shell.windows = [target()];
  for (const mapped of shell.mapped.values()) mapped();
  await activation;
  expect(shell.activate).toHaveBeenCalledOnce();
  feedback.dispose();
  shell.windows = [];
  const next = begin().feedback;
  const cancelled = next.activate(":1.23", "T3");
  next.dispose();
  await expect(cancelled).rejects.toThrow("No active capture");
  expect(shell.mapped.size).toBe(0);
});

it("does not animate under reduced motion but still activates T3", async () => {
  shell.animations = false;
  shell.windows = [target()];
  const { feedback, started } = begin();
  expect(started).toBe(false);
  expect(shell.actors).toHaveLength(0);
  await feedback.activate(":1.23", "T3");
  expect(shell.activate).toHaveBeenCalledOnce();
  feedback.dispose();
});

it("rejects another sender and locked-session activation", async () => {
  shell.windows = [target()];
  const { feedback } = begin();
  await expect(feedback.activate(":1.99", "T3")).rejects.toThrow("No active capture");
  shell.locked = true;
  await expect(feedback.activate(":1.23", "T3")).rejects.toThrow("No active capture");
  expect(shell.activate).not.toHaveBeenCalled();
  feedback.dispose();
});

it("disposes an abandoned flight and resolves its pending response", async () => {
  shell.windows = [target()];
  const { feedback } = begin();
  await feedback.activate(":1.23", "T3");
  const flight = feedback.animate(":1.23", { x: 0.1, y: 0.8, width: 0.2, height: 0.1 });
  const callbacks = [...shell.timers.values()];
  shell.timers.clear();
  for (const timeout of callbacks) timeout();
  await flight;
  expect(shell.actors.every((actor) => actor.destroyed)).toBe(true);
  expect(shell.watchers.size).toBe(0);
});
