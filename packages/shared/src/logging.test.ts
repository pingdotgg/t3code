// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "./HostProcess.ts";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
  makeAsyncRotatingFileSink,
} from "./logging.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
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

effectIt.layer(NodeServices.layer)("asynchronous rotating file sink", (it) => {
  it.effect("serializes concurrent appends across rotation and resumes an existing file", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "async.log");
      NodeFS.writeFileSync(`${filePath}.50`, "obsolete");
      const lines = Array.from(
        { length: 100 },
        (_, index) => `${index.toString().padStart(3, "0")}\n`,
      );
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 20 });
      yield* Effect.forEach(lines, (line) => sink.write(line), {
        concurrency: "unbounded",
        discard: true,
      });
      const resumed = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 20 });
      yield* resumed.write("100\n");
      expect(NodeFS.existsSync(`${filePath}.50`)).toBe(false);
      const backups = NodeFS.readdirSync(directory)
        .filter((name) => name.startsWith("async.log."))
        .sort((a, b) => Number(b.slice(10)) - Number(a.slice(10)));
      const contents = [...backups, "async.log"].map((name) =>
        NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
      );
      expect(contents.every((chunk) => Buffer.byteLength(chunk) <= 32)).toBe(true);
      expect(contents.join("")).toBe(lines.join("") + "100\n");
    }),
  );

  it.effect("reports a failed append and recovers its size before the next rotation", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "recovery.log");
      NodeFS.writeFileSync(filePath, "old\n");
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 8, maxFiles: 2 }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (path, bytes, options) =>
            ++attempts === 1
              ? fs.writeFile(directory, bytes, options)
              : fs.writeFile(path, bytes, options),
        }),
      );
      const failed = yield* sink.write("new\n").pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") expect(failed.failure.operation).toBe("write");
      yield* sink.write("new\n");
      yield* sink.write("end\n");
      expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("old\nnew\n");
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("end\n");
    }),
  );
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
