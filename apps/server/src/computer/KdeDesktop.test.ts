import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { KdeDesktop, desktopLayoutFromKscreen, kdeSessionProblem, layer } from "./KdeDesktop.ts";

const plasma = {
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "KDE",
};

describe("kdeSessionProblem", () => {
  it.each([
    ["a Plasma Wayland session", "linux", plasma, null],
    [
      "a Plasma session that lists several desktops",
      "linux",
      { ...plasma, XDG_CURRENT_DESKTOP: "ubuntu:KDE" },
      null,
    ],
    ["macOS", "darwin", plasma, "not Linux"],
    [
      "SSH with no session bus",
      "linux",
      { ...plasma, DBUS_SESSION_BUS_ADDRESS: "" },
      "started over SSH",
    ],
    ["Plasma on X11", "linux", { ...plasma, WAYLAND_DISPLAY: undefined }, "started over SSH"],
    ["GNOME", "linux", { ...plasma, XDG_CURRENT_DESKTOP: "GNOME" }, "not KDE Plasma"],
  ] as const)("reports %s", (_, platform, env, problem) => {
    const result = kdeSessionProblem(platform, env);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });
});

const output = (x: number, y: number, width: number, height: number, extra = {}) => ({
  name: "DP-1",
  enabled: true,
  pos: { x, y },
  size: { width, height },
  scale: 1,
  rotation: 1,
  ...extra,
});

describe("desktopLayoutFromKscreen", () => {
  it.each([
    [
      "two side-by-side screens",
      [output(0, 0, 2560, 1440), output(2560, 0, 2560, 1440)],
      {
        bounds: { x: 0, y: 0, width: 5120, height: 1440 },
        scale: 1,
        screens: [
          { x: 0, y: 0, width: 2560, height: 1440 },
          { x: 2560, y: 0, width: 2560, height: 1440 },
        ],
      },
    ],
    // libkscreen reports `size` already turned, so a 4K panel turned right at 2x is 2160x3840.
    [
      "a scaled, rotated screen",
      [output(0, 0, 2560, 1440), output(2560, 0, 2160, 3840, { scale: 2, rotation: 8 })],
      {
        bounds: { x: 0, y: 0, width: 3640, height: 1920 },
        scale: 2,
        screens: [
          { x: 0, y: 0, width: 2560, height: 1440 },
          { x: 2560, y: 0, width: 1080, height: 1920 },
        ],
      },
    ],
    [
      "a disabled screen",
      [output(0, 0, 1920, 1080), output(1920, 0, 1920, 1080, { enabled: false, scale: 2 })],
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scale: 1,
        screens: [{ x: 0, y: 0, width: 1920, height: 1080 }],
      },
    ],
    ["no enabled screens", [output(0, 0, 1920, 1080, { enabled: false })], null],
  ] as const)("measures %s", (_, outputs, layout) => {
    const measured = desktopLayoutFromKscreen(JSON.stringify({ outputs, screen: {} }));
    if (layout === null) expect(measured).toBeNull();
    else expect(measured).toMatchObject(layout);
  });

  it("rejects output it cannot read", () => {
    expect(desktopLayoutFromKscreen("kscreen-doctor: no backend")).toBeNull();
  });
});

describe("KdeDesktop.capture", () => {
  const outputs = (left: string, right: string) =>
    JSON.stringify({
      outputs: [
        { ...output(0, 0, 1920, 1080), name: left },
        { ...output(1920, 0, 1920, 1080), name: right },
      ],
    });

  const capture = (layouts: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let reads = 0;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            const stdout = input.command === "kscreen-doctor" ? layouts[reads++]! : "";
            return {
              stdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const services = layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProcessRunner.ProcessRunner, runner),
            FileSystem.layerNoop({
              makeTempDirectoryScoped: () => Effect.succeed("/tmp/t3-computer-test"),
              readFile: () => Effect.succeed(new Uint8Array([1])),
            }),
            Path.layer,
          ),
        ),
      );
      return yield* KdeDesktop.use((desktop) => Effect.exit(desktop.capture)).pipe(
        Effect.provide(services),
      );
    });

  it.effect.each([
    ["a steady layout", outputs("DP-1", "DP-2"), null],
    // The same rectangles either way, so only which output sits where shows the change.
    ["two equal screens that swapped places", outputs("DP-2", "DP-1"), "The screen layout changed"],
  ] as const)("captures across %s, or refuses it", ([, after, refusal]) =>
    Effect.gen(function* () {
      const exit = yield* capture([outputs("DP-1", "DP-2"), after]);
      if (refusal === null) expect(exit._tag).toBe("Success");
      else {
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "ComputerUseUnavailableError",
          reason: expect.stringContaining(refusal),
        });
      }
    }),
  );
});
