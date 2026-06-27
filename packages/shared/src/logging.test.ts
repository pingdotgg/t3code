// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
} from "./logging.ts";

const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-logging-"));
  tempDirectories.push(directory);
  return directory;
};

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it.each([
    { option: "maxBytes" as const, maxBytes: 0, maxFiles: 1 },
    { option: "maxFiles" as const, maxBytes: 1, maxFiles: 0 },
  ])("reports invalid $option configuration structurally", (input) => {
    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath: "/unused/log.ndjson",
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkConfigurationError);
    expect(thrown).toMatchObject({
      option: input.option,
      received: 0,
      minimum: 1,
    });
    expect((thrown as Error).message).toBe(`${input.option} must be >= 1 (received 0)`);
  });

  it("preserves directory initialization failures", () => {
    const directory = makeTempDirectory();
    const parentFile = NodePath.join(directory, "not-a-directory");
    const filePath = NodePath.join(parentFile, "log.ndjson");
    NodeFS.writeFileSync(parentFile, "occupied");

    const thrown = captureError(() => new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "initialize", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  it("only treats a missing log file as an empty current size", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "a".repeat(300));

    const thrown = captureError(() => new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "read", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "ENAMETOOLONG" });
  });

  it("starts an absent log file at zero bytes", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 100, maxFiles: 1 });

    sink.write("entry");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("entry");
  });

  it("preserves write failures", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(filePath);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = captureError(() => sink.write("entry"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "write", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "EISDIR" });
  });

  it("preserves rotation failures without an artificial write wrapper", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.writeFileSync(filePath, "a");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = captureError(() => sink.write("b"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  it("preserves backup pruning failures", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const overflowBackup = `${filePath}.2`;
    NodeFS.mkdirSync(overflowBackup);
    NodeFS.writeFileSync(NodePath.join(overflowBackup, "entry"), "occupied");

    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath,
          maxBytes: 1,
          maxFiles: 1,
          throwOnError: true,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "prune", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });
});
