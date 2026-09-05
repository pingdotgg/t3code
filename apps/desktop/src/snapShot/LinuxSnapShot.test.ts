// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files exercise the native portal URI boundary.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  DBusError,
  Message,
  MessageType,
  RequestNameReply,
  Variant,
  type MessageBus,
} from "dbus-next";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { connect, resize, imageSize } = vi.hoisted(() => ({
  connect: vi.fn(),
  resize: vi.fn(() => ({ toPNG: () => Buffer.from("resized") })),
  imageSize: { width: 800, height: 600 },
}));
vi.mock("dbus-next", async (original) => ({
  ...(await original<typeof import("dbus-next")>()),
  sessionBus: connect,
}));
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => imageSize,
      resize,
    }),
  },
}));

import {
  captureLinuxWindow,
  getLinuxCaptureSupport,
  readPortalPng,
  resizeLinuxCapture,
} from "./LinuxSnapShot.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const appId = "com.t3tools.T3Code";
const metadata = {
  title: "Editor",
  appName: "Text Editor",
  appIdentifier: "org.gnome.TextEditor.desktop",
  processId: 42,
  bounds: { x: -100, y: 20, width: 800, height: 600 },
};

class FakeBus extends NodeEvents.EventEmitter {
  calls: Message[] = [];
  portalVersion = 3;
  targets: number | undefined = 8;
  extensionVersion: number | undefined;
  kdeVersion: number | undefined = 5;
  kdeError: Error | undefined;
  status = 0;
  uri = "file:///missing.png";
  registryError: Error | undefined;
  screenshotError: Error | undefined;
  extensionError: Error | undefined;
  activationError: Error | undefined;
  animation: Promise<void> | undefined;
  sendResponse = true;
  differentHandle = false;
  wrongSender = false;
  requestName = vi.fn(async () => RequestNameReply.PRIMARY_OWNER);
  disconnect = vi.fn();
  send = vi.fn();

  signal(path: string, body: unknown[], sender = ":1.2") {
    this.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        sender,
        path,
        interface: "org.freedesktop.portal.Request",
        member: "Response",
        body,
      }),
    );
  }

  async call(message: Message) {
    this.calls.push(message);
    const reply = (body: unknown[]) =>
      new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        destination: ":1.23",
        body,
      });
    switch (message.member) {
      case "Register":
        if (this.registryError) throw this.registryError;
        return reply([]);
      case "GetAll":
        if (message.destination === "org.kde.KWin.ScreenShot2") {
          if (this.kdeError) throw this.kdeError;
          if (this.kdeVersion === undefined)
            throw new DBusError("org.freedesktop.DBus.Error.ServiceUnknown", "Absent");
          return reply([{ Version: new Variant("u", this.kdeVersion) }]);
        }
        if (message.destination === "org.freedesktop.portal.Desktop")
          return reply([
            {
              version: new Variant("u", this.portalVersion),
              ...(this.targets === undefined
                ? {}
                : { AvailableTargets: new Variant("u", this.targets) }),
            },
          ]);
        if (this.extensionVersion === undefined)
          throw new DBusError("org.freedesktop.DBus.Error.ServiceUnknown", "Absent");
        return reply([{ Version: new Variant("u", this.extensionVersion) }]);
      case "GetNameOwner":
        return reply([":1.2"]);
      case "AddMatch":
        return reply([]);
      case "Screenshot": {
        if (this.screenshotError) throw this.screenshotError;
        const options = message.body[1] as Record<string, Variant<unknown>>;
        const handle = `/org/freedesktop/portal/desktop/request/1_23/${this.differentHandle ? "actual" : options.handle_token?.value}`;
        if (this.sendResponse)
          this.signal(
            handle,
            [this.status, { uri: new Variant("s", this.uri) }],
            this.wrongSender ? ":1.99" : ":1.2",
          );
        return reply([handle]);
      }
      case "Capture":
        if (this.extensionError) throw this.extensionError;
        return reply([png, JSON.stringify(metadata)]);
      case "CaptureWithFeedback":
        return reply([png, JSON.stringify(metadata), message.body[1]]);
      case "Activate":
        if (this.activationError) throw this.activationError;
        return reply([]);
      case "Animate":
        await this.animation;
        return reply([]);
      default:
        throw new Error(`Unexpected method ${message.member}`);
    }
  }
}

let bus: FakeBus;
let directory: string;
beforeEach(async () => {
  bus = new FakeBus();
  connect.mockImplementation(() => bus as unknown as MessageBus);
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-portal-test-"));
  bus.uri = NodeURL.pathToFileURL(NodePath.join(directory, "image.png")).href;
  await NodeFSP.writeFile(NodePath.join(directory, "image.png"), png);
  imageSize.width = 800;
  imageSize.height = 600;
  vi.stubEnv("FLATPAK_ID", "");
  vi.stubEnv("SNAP", "");
  vi.stubEnv("NIRI_SOCKET", "");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME");
});

it("uses native KWin only in an unsandboxed KDE session", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("kde");
  vi.stubEnv("FLATPAK_ID", "com.example.App");
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).not.toBe("kde");
});

it("redetects the desktop without using another session's extension or stale Niri socket", async () => {
  bus.portalVersion = 2;
  bus.extensionVersion = 2;
  vi.stubEnv("NIRI_SOCKET", "/previous-session/niri.sock");
  expect(await getLinuxCaptureSupport(appId)).toEqual({
    linuxBackend: "gnome-extension",
    linuxFeedbackAvailable: true,
  });

  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  expect(await getLinuxCaptureSupport(appId)).toEqual({
    linuxBackend: "kde",
    linuxFeedbackAvailable: false,
  });
  bus.kdeVersion = undefined;
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("picker");

  vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME");
  expect(await getLinuxCaptureSupport(appId)).toEqual({
    linuxBackend: "gnome-extension",
    linuxFeedbackAvailable: true,
  });
});

it("uses the standard path when KWin's native capability is missing, but not when denied", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  bus.kdeVersion = undefined;
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("screenshot-portal");
  bus.kdeVersion = 1;
  bus.portalVersion = 2;
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("picker");
  bus.kdeError = new DBusError("org.freedesktop.DBus.Error.AccessDenied", "Denied");
  await expect(getLinuxCaptureSupport(appId)).rejects.toThrow("Denied");
});

it("does not fall through to the picker when KDE needs helper setup", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  await expect(captureLinuxWindow(appId)).rejects.toThrow("KDE capture setup");
  expect(bus.calls.some((call) => call.member === "Screenshot")).toBe(false);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});
it("selects Hyprland without probing a different desktop or falling back on missing setup", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "Hyprland");
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("hyprland");
  await expect(captureLinuxWindow(appId)).rejects.toThrow("Hyprland capture setup");
  expect(bus.calls).toEqual([]);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await NodeFSP.rm(directory, { recursive: true });
});

it.each([
  [2, 8, 1, "gnome-extension"],
  [3, undefined, 1, "gnome-extension"],
  [3, 7, undefined, "picker"],
  [3, 8, 1, "screenshot-portal"],
  [4, 15, undefined, "screenshot-portal"],
  [2, undefined, 2, "gnome-extension"],
  [2, undefined, 99, "picker"],
] as const)(
  "selects capabilities v%s / targets %s / extension %s",
  async (version, targets, extension, expected) => {
    bus.portalVersion = version;
    bus.targets = targets;
    bus.extensionVersion = extension;
    expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe(expected);
    expect(bus.calls[0]?.member).toBe("Register");
    expect(bus.disconnect).toHaveBeenCalledOnce();
  },
);

it.each([1, 2])(
  "reports feedback separately from capture support for extension v%s",
  async (version) => {
    bus.portalVersion = 2;
    bus.extensionVersion = version;
    expect(await getLinuxCaptureSupport(appId)).toEqual({
      linuxBackend: "gnome-extension",
      linuxFeedbackAvailable: version === 2,
    });
  },
);

it("retains the authenticated connection until the compositor flight has landed", async () => {
  bus.portalVersion = 2;
  bus.extensionVersion = 2;
  const snapshot = await captureLinuxWindow(appId, { flash: false, animate: true });
  const feedback = snapshot!.feedback!;
  expect(snapshot).toMatchObject({ png, window: metadata, feedback: { animationStarted: true } });
  expect(bus.disconnect).not.toHaveBeenCalled();
  await feedback.activate("T3 Code");
  const landed = Promise.withResolvers<void>();
  bus.animation = landed.promise;
  const flight = feedback.animateTo({ x: 0.1, y: 0.8, width: 0.2, height: 0.1 });
  const complete = feedback.complete();
  expect(bus.disconnect).not.toHaveBeenCalled();
  landed.resolve();
  await Promise.all([flight, complete]);
  expect(
    bus.calls
      .filter((call) => ["CaptureWithFeedback", "Activate", "Animate"].includes(call.member))
      .map((call) => call.body),
  ).toEqual([[false, true], ["T3 Code"], [0.1, 0.8, 0.2, 0.1]]);
  expect(bus.disconnect).toHaveBeenCalledOnce();
  feedback.close();
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("keeps capture working with v1 and does not request unavailable effects", async () => {
  bus.portalVersion = 2;
  bus.extensionVersion = 1;
  expect(await captureLinuxWindow(appId, { flash: true, animate: true })).toEqual({
    png,
    window: metadata,
  });
  expect(bus.calls.some((call) => call.member === "CaptureWithFeedback")).toBe(false);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("can activate without animation, and expires a renderer-abandoned capture", async () => {
  vi.useFakeTimers();
  bus.portalVersion = 2;
  bus.extensionVersion = 2;
  const snapshot = await captureLinuxWindow(appId, { flash: false, animate: false });
  expect(snapshot!.feedback!.animationStarted).toBe(false);
  bus.activationError = new Error("No window");
  await expect(snapshot!.feedback!.activate("T3 Code")).rejects.toThrow("No window");
  expect(snapshot!.png).toEqual(png);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "accepts an early Response with a changed request path: %s",
  async (differentHandle) => {
    bus.differentHandle = differentHandle;
    expect(await captureLinuxWindow(appId)).toEqual({ png });
    const screenshot = bus.calls.find((call) => call.member === "Screenshot");
    expect(screenshot?.body[1]).toMatchObject({
      target: { signature: "u", value: 8 },
      interactive: { value: false },
    });
    expect(bus.calls.findIndex((call) => call.member === "AddMatch")).toBeLessThan(
      bus.calls.indexOf(screenshot!),
    );
    expect(bus.listenerCount("message")).toBe(0);
    expect(bus.disconnect).toHaveBeenCalledOnce();
  },
);

it.each([1, 2])(
  "does not try the extension or picker after portal rejection %s",
  async (status) => {
    bus.extensionVersion = 1;
    bus.status = status;
    await expect(captureLinuxWindow(appId)).rejects.toThrow(
      status === 1 ? "cancelled" : "did not allow",
    );
    expect(bus.calls.some((call) => call.member === "Capture")).toBe(false);
    expect(bus.disconnect).toHaveBeenCalledOnce();
  },
);

it("does not downgrade a failed screenshot request", async () => {
  bus.screenshotError = new DBusError("org.freedesktop.DBus.Error.AccessDenied", "Denied");
  await expect(captureLinuxWindow(appId)).rejects.toThrow("Denied");
  expect(bus.send).toHaveBeenCalledWith(expect.objectContaining({ member: "Close" }));
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "times out and closes requests, ignoring forged responses: %s",
  async (wrongSender) => {
    vi.useFakeTimers();
    bus.sendResponse = wrongSender;
    bus.wrongSender = wrongSender;
    const capture = expect(captureLinuxWindow(appId)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_001);
    await capture;
    expect(bus.send).toHaveBeenCalledWith(expect.objectContaining({ member: "Close" }));
    expect(bus.listenerCount("message")).toBe(0);
    expect(bus.disconnect).toHaveBeenCalledOnce();
  },
);

it("uses the GNOME extension and preserves its window identity", async () => {
  bus.portalVersion = 2;
  bus.extensionVersion = 1;
  expect(await captureLinuxWindow(appId)).toEqual({ png, window: metadata });
  expect(bus.requestName).toHaveBeenCalledWith(`${appId}.SnapShot`, expect.any(Number));
  expect(bus.calls.some((call) => call.member === "Screenshot")).toBe(false);
});

it("fails instead of opening a picker after an extension denial", async () => {
  bus.portalVersion = 2;
  bus.extensionVersion = 1;
  bus.extensionError = new Error("Locked session");
  await expect(captureLinuxWindow(appId)).rejects.toThrow("Locked session");
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("allows the picker only when both automatic backends are absent", async () => {
  bus.portalVersion = 2;
  expect(await captureLinuxWindow(appId)).toBeUndefined();
  expect(bus.calls.some((call) => call.member === "Screenshot" || call.member === "Capture")).toBe(
    false,
  );
});

it("tolerates an older portal without Registry, but not registration denial", async () => {
  bus.registryError = new DBusError("org.freedesktop.DBus.Error.UnknownMethod", "Old portal");
  expect((await getLinuxCaptureSupport(appId)).linuxBackend).toBe("screenshot-portal");
  bus.registryError = new DBusError("org.freedesktop.DBus.Error.AccessDenied", "Denied identity");
  await expect(getLinuxCaptureSupport(appId)).rejects.toThrow("Denied identity");
});

it("does not register a host identity from inside a sandbox", async () => {
  vi.stubEnv("FLATPAK_ID", appId);
  await getLinuxCaptureSupport(appId);
  expect(bus.calls.some((call) => call.member === "Register")).toBe(false);
});

it("reads only local PNG files without removing the portal file", async () => {
  expect(await readPortalPng(bus.uri)).toEqual(png);
  expect(await readPortalPng(bus.uri)).toEqual(png);
  await expect(readPortalPng("https://example.com/image.png")).rejects.toThrow();
  await expect(readPortalPng("file://remote/image.png")).rejects.toThrow();
  await NodeFSP.writeFile(NodePath.join(directory, "image.png"), "not a PNG");
  await expect(readPortalPng(bus.uri)).rejects.toThrow("Invalid");
});

it("bounds large images without distorting their aspect ratio", () => {
  imageSize.width = 4000;
  imageSize.height = 2000;
  resizeLinuxCapture(png);
  expect(resize).toHaveBeenLastCalledWith({ width: 2560, height: 1280, quality: "best" });
});
