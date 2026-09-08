// @effect-diagnostics nodeBuiltinImport:off -- Runs the actual QML geometry library without a desktop.
import * as NodeFSP from "node:fs/promises";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const source = await NodeFSP.readFile(new URL("./feedbackGeometry.js", import.meta.url), "utf8");
const target = {
  pid: 123,
  caption: "Draft",
  minimized: false,
  clientGeometry: { x: -1920, y: 30, width: 1280, height: 900 },
};
const frame = { x: 0.25, y: 0.5, width: 0.2, height: 0.1 };
function destination(windows = [target], relative = frame) {
  return NodeVM.runInNewContext(`${source}\ndestination(windows, 123, "Draft", relative)`, {
    windows,
    relative,
  });
}
it("maps normalized composer coordinates to the exact owning window's client area", () => {
  expect(destination([{ ...target, pid: 999 }, target]).frame).toEqual({
    x: -1600,
    y: 480,
    width: 256,
    height: 90,
  });
});
it("rejects lookalikes, ambiguous or hidden windows", () => {
  for (const windows of [
    [],
    [{ ...target, pid: 999 }],
    [target, target],
    [{ ...target, minimized: true }],
  ]) {
    expect(() => destination(windows)).toThrow();
  }
});
it("rejects invalid or out-of-bounds destinations instead of moving across unrelated windows", () => {
  for (const invalid of [
    { ...frame, x: -0.1 },
    { ...frame, width: 2 },
    { ...frame, height: 0 },
    { ...frame, y: NaN },
  ]) {
    expect(() => destination([target], invalid)).toThrow("Invalid capture destination");
  }
});
