import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RotatingFileSink } from "@t3tools/shared/logging";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rotating-log-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it("rotates when writes exceed max bytes", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 10,
      maxFiles: 3,
    });

    sink.write("12345");
    sink.write("67890");
    sink.write("abc");

    expect(fs.readFileSync(path.join(dir, "desktop-main.log"), "utf8")).toBe("abc");
    expect(fs.readFileSync(path.join(dir, "desktop-main.log.1"), "utf8")).toBe("1234567890");
  });

  it("retains only maxFiles backups", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "server-child.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 4,
      maxFiles: 2,
    });

    sink.write("aaaa");
    sink.write("bbbb");
    sink.write("cccc");
    sink.write("dddd");

    expect(fs.existsSync(path.join(dir, "server-child.log.1"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.2"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.3"))).toBe(false);
  });

  it("prunes stale backups above maxFiles on startup", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    fs.writeFileSync(path.join(dir, "desktop-main.log.1"), "first");
    fs.writeFileSync(path.join(dir, "desktop-main.log.4"), "stale");

    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 16,
      maxFiles: 2,
    });
    sink.write("hello");

    expect(fs.existsSync(path.join(dir, "desktop-main.log.4"))).toBe(false);
  });
});
