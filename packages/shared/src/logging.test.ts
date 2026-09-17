// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "./hostProcess.ts";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
} from "./logging.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
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

  // An over-long name is the one stat failure that is neither ENOENT nor a
  // permission problem on posix. Windows reports it as ENOENT, so the sink
  // correctly treats it as an absent file and there is nothing to assert.
  it.skipIf(windowsHost)("only treats a missing log file as an empty current size", () => {
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

  it("gzips backups while keeping the active file plain and retention bounded", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 5, maxFiles: 2 });
    for (const line of ["one\n", "two\n", "three", "four"]) sink.write(line);
    await sink.flushCompression();

    expect(NodeFS.readdirSync(directory).sort()).toEqual([
      "log.ndjson",
      "log.ndjson.1.gz",
      "log.ndjson.2.gz",
    ]);
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("four");
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.1.gz`)).toString()).toBe("three");
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.2.gz`)).toString()).toBe("two\n");
  });

  it("handles rotations and eviction while compression is in flight", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 2 });
    sink.write("a");
    sink.write("b");
    // Start the asynchronous stream, then rotate before its completion callback.
    await Promise.resolve();
    for (const line of ["c", "d", "e"]) sink.write(line);
    await sink.flushCompression();
    expect(NodeFS.readdirSync(directory).sort()).toEqual([
      "log.ndjson",
      "log.ndjson.1.gz",
      "log.ndjson.2.gz",
    ]);
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.1.gz`)).toString()).toBe("d");
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.2.gz`)).toString()).toBe("c");
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("e");
  });

  it("compresses legacy backups on restart, preserves their age, and prunes both formats", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.writeFileSync(`${filePath}.1`, "previous");
    NodeFS.utimesSync(`${filePath}.1`, 1000, 1000);
    NodeFS.writeFileSync(`${filePath}.2.gz`, NodeZlib.gzipSync("older"));
    NodeFS.writeFileSync(`${filePath}.3`, "overflow");
    NodeFS.writeFileSync(`${filePath}.4.gz`, NodeZlib.gzipSync("overflow"));
    NodeFS.writeFileSync(`${filePath}.notes`, "unrelated");
    NodeFS.writeFileSync(`${filePath}.gzip-00000000-0000-0000-0000-000000000000.tmp`, "incomplete");
    const sink = new RotatingFileSink({ filePath, maxBytes: 5, maxFiles: 2 });
    await sink.flushCompression();
    expect(NodeFS.statSync(`${filePath}.1.gz`).mtimeMs).toBe(1_000_000);
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.1.gz`)).toString()).toBe(
      "previous",
    );
    sink.write("first");
    sink.write("next");
    await sink.flushCompression();
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.2.gz`)).toString()).toBe(
      "previous",
    );
    expect(NodeFS.readdirSync(directory).sort()).toEqual([
      "log.ndjson",
      "log.ndjson.1.gz",
      "log.ndjson.2.gz",
      "log.ndjson.notes",
    ]);
  });

  it("retains the plain backup when compression cannot publish and retries on rotation", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 2 });
    sink.write("a");
    sink.write("b");
    NodeFS.mkdirSync(`${filePath}.1.gz`);
    await sink.flushCompression();
    expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("a");
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("b");
    expect(NodeFS.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    NodeFS.rmdirSync(`${filePath}.1.gz`);
    sink.write("c");
    await sink.flushCompression();
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${filePath}.2.gz`)).toString()).toBe("a");
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

  it("never reports a rotation failure after successfully appending a chunk", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    sink.write("oversized");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
    const thrown = captureError(() => sink.write("next"));
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
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
