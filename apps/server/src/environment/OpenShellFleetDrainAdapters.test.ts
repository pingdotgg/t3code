import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type PlatformError } from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { FleetDrainStepError, type DrainSink } from "./OpenShellFleetDrain.ts";
import * as OpenShellFleetDrain from "./OpenShellFleetDrain.ts";
import * as OpenShellFleetDrainAdapters from "./OpenShellFleetDrainAdapters.ts";

type SinkUse<A> = Effect.Effect<
  A,
  FleetDrainStepError | PlatformError,
  FileSystem.FileSystem | Path.Path
>;

const refused = <A>(
  effect: Effect.Effect<A, FleetDrainStepError, never>,
): Effect.Effect<FleetDrainStepError, never, never> =>
  effect.pipe(
    Effect.flip,
    Effect.catch(() => Effect.die(new Error("expected a refusal"))),
  );

const withSink = <A>(use: (sink: DrainSink, stateDir: string) => SinkUse<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectory();
    const sink = yield* OpenShellFleetDrainAdapters.fileDrainSink({ stateDir, fs, path });
    return yield* use(sink, stateDir);
  }).pipe(Effect.provide(NodeServices.layer));

const base64Of = (text: string) => Buffer.from(text, "utf8").toString("base64");

const write = (
  sink: DrainSink,
  overrides: Partial<{
    environmentId: EnvironmentId;
    drainId: string;
    threadId: string;
    body: string;
  }> = {},
) =>
  sink.write({
    environmentId: EnvironmentId.make("environment:worker"),
    drainId: "drain:environment:worker:1",
    threadId: "thread:a",
    body: '{"events":[1]}',
    snapshotSequence: 4,
    ...overrides,
  });

describe("fileDrainSink", () => {
  it.effect("refuses an environment id that climbs out of fleet-drain", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const failure = yield* refused(write(sink, { environmentId: EnvironmentId.make("..") }));
        expect(failure.step).toBe("write");
        const readFailure = yield* refused(
          sink.read({
            environmentId: EnvironmentId.make(".."),
            drainId: "drain:environment:worker:1",
            threadId: "thread:a",
          }),
        );
        expect(readFailure.step).toBe("read");
      }),
    ),
  );

  it.effect("refuses a drain id that climbs out of fleet-drain", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const failure = yield* refused(write(sink, { drainId: ".." }));
        expect(failure.step).toBe("write");
        const readFailure = yield* refused(
          sink.read({
            environmentId: EnvironmentId.make("environment:worker"),
            drainId: "..",
            threadId: "thread:a",
          }),
        );
        expect(readFailure.step).toBe("read");
      }),
    ),
  );

  it.effect("neutralizes separators and stores a currency-checked envelope", () =>
    withSink((sink, stateDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const written = yield* write(sink, {
          environmentId: EnvironmentId.make("env/../../elsewhere"),
        });
        expect(written.bytes).toBeGreaterThan(0);
        // The segment cannot name a directory above fleet-drain.
        expect(yield* fs.exists(path.join(stateDir, "elsewhere"))).toBe(false);
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("env/../../elsewhere"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
        });
        expect(record).toEqual({
          threadId: "thread:a",
          snapshotSequence: 4,
          body: '{"events":[1]}',
        });
      }),
    ),
  );

  it.effect("maps distinct thread ids to distinct files and refuses relative hops", () =>
    withSink((sink, stateDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const drainId = "drain:environment:worker:1";
        const environmentId = EnvironmentId.make("environment:worker");
        const bodies: Record<string, string> = {
          "thread:a": '{"n":1}',
          threada: '{"n":2}',
          "thread/b": '{"n":3}',
          "thread.b": '{"n":4}',
        };
        for (const [threadId, body] of Object.entries(bodies)) {
          yield* sink.write({ environmentId, drainId, threadId, body, snapshotSequence: null });
        }
        // A collision would have overwritten an acked copy with another thread's.
        for (const [threadId, body] of Object.entries(bodies)) {
          const record = yield* sink.read({ environmentId, drainId, threadId });
          expect(record?.body).toBe(body);
        }
        const dir = path.join(
          stateDir,
          "fleet-drain",
          "environment%3Aworker",
          "drain%3Aenvironment%3Aworker%3A1",
        );
        expect(yield* fs.readDirectory(dir)).toHaveLength(4);
        for (const hop of ["..", "."]) {
          const failure = yield* refused(write(sink, { drainId, threadId: hop, body: "{}" }));
          expect(failure.step).toBe("write");
        }
      }),
    ),
  );

  it.effect("answers null for a thread that was never written", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:missing",
        });
        expect(record).toBeNull();
      }),
    ),
  );
});

describe("fileDrainSink copy", () => {
  it.effect("promotes a previous generation's record with its attachment files", () =>
    withSink((sink, stateDir) =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("environment:worker");
        yield* sink.write({
          environmentId,
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
          body: '{"events":[1]}',
          snapshotSequence: 2,
          attachments: {
            files: [{ name: "attach-1.png", bytes: base64Of("image-bytes") }],
            oversizeSkipped: false,
          },
        });

        const copied = yield* sink.copy({
          environmentId,
          fromDrainId: "drain:environment:worker:1",
          toDrainId: "drain:environment:worker:2",
          threadId: "thread:a",
        });

        expect(copied).toBe(true);
        const record = yield* sink.read({
          environmentId,
          drainId: "drain:environment:worker:2",
          threadId: "thread:a",
        });
        expect(record?.body).toBe('{"events":[1]}');
        expect(record?.snapshotSequence).toBe(2);
        expect(record?.attachments?.[0]?.name).toBe("attach-1.png");

        const missing = yield* sink.copy({
          environmentId,
          fromDrainId: "drain:environment:worker:1",
          toDrainId: "drain:environment:worker:2",
          threadId: "thread:missing",
        });
        expect(missing).toBe(false);

        // A manifest whose bytes are gone must not look like a promoted copy.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(
          stateDir,
          "fleet-drain",
          "environment%3Aworker",
          "drain%3Aenvironment%3Aworker%3A1",
        );
        for (const file of yield* fs.readDirectory(dir)) {
          if (file.endsWith(".bin")) yield* fs.remove(path.join(dir, file));
        }
        const broken = yield* refused(
          sink.copy({
            environmentId,
            fromDrainId: "drain:environment:worker:1",
            toDrainId: "drain:environment:worker:3",
            threadId: "thread:a",
          }),
        );
        expect(broken.step).toBe("write");
      }),
    ),
  );
});

describe("fileDrainSink attachments", () => {
  it.effect("stores attachment files beside the bundle and manifests them", () =>
    withSink((sink, stateDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* sink.write({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
          body: '{"events":[1]}',
          snapshotSequence: 2,
          attachments: {
            files: [{ name: "attach-1.png", bytes: base64Of("image-bytes") }],
            oversizeSkipped: false,
          },
        });
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
        });
        expect(record?.attachments).toHaveLength(1);
        const entry = record?.attachments?.[0];
        expect(entry?.name).toBe("attach-1.png");
        expect(entry?.size).toBe("image-bytes".length);
        expect(entry?.hash).toMatch(/^[0-9a-f]{64}$/);
        // The sibling file holds the exact bytes, keyed by the same hash.
        const dir = path.join(
          stateDir,
          "fleet-drain",
          "environment%3Aworker",
          "drain%3Aenvironment%3Aworker%3A1",
        );
        const stored = yield* fs.readFile(
          path.join(dir, `thread-thread%3Aa-att-${entry?.hash.slice(0, 16)}.bin`),
        );
        expect(new TextDecoder().decode(stored)).toBe("image-bytes");
        expect(record?.attachmentsSkipped).toBeUndefined();
      }),
    ),
  );

  it.effect("records an oversize skip without manifest entries", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        yield* sink.write({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
          body: '{"events":[1]}',
          snapshotSequence: 2,
          attachments: { files: [], oversizeSkipped: true },
        });
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
        });
        expect(record?.attachments).toBeUndefined();
        expect(record?.attachmentsSkipped).toBe(true);
      }),
    ),
  );

  it.effect("a plain bundle still reads back without manifest fields", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        yield* write(sink);
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
        });
        expect(record?.attachments).toBeUndefined();
        expect(record?.attachmentsSkipped).toBeUndefined();
      }),
    ),
  );
});

describe("execDrainGitBundle", () => {
  const execStub = (stdout: string, commands?: Array<ReadonlyArray<string>>, exitCode = 0) => ({
    exec: (_sandboxName: string, command: ReadonlyArray<string>) =>
      Effect.sync(() => {
        commands?.push(command);
        return { exitCode, stdout, stderr: "" };
      }),
  });

  it.effect("bundles only the refs the mirror lacks, without contacting a remote", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const adapter = OpenShellFleetDrainAdapters.execDrainGitBundle({
        ...execStub("Qg==", commands),
      });
      const result = yield* adapter.bundle({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        workspaceRoot: "/work/a",
      });
      expect(result.exitCode).toBe(0);
      const line = commands[0]?.join(" ") ?? "";
      // No push: a worker's origin is a read-only mirror, and a branch that
      // fell behind would reject a push as non-fast-forward anyway. --all
      // would re-export the seeded history, so only what origin lacks travels.
      expect(line).toContain("rev-list --count");
      expect(line).toContain("bundle create");
      expect(line).toContain("--branches");
      expect(line).toContain("HEAD --branches");
      expect(line).toContain("--glob='refs/t3/*'");
      expect(line).toContain("--not --remotes=origin");
      expect(line).not.toContain("--all");
      expect(line).not.toContain("--not --remotes ");
      expect(line).not.toContain("push");
      expect(line).toContain("'/work/a'");
    }),
  );

  it.effect("passes an empty export through for the drain to acknowledge", () =>
    Effect.gen(function* () {
      const adapter = OpenShellFleetDrainAdapters.execDrainGitBundle({
        ...execStub(""),
      });
      const result = yield* adapter.bundle({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        workspaceRoot: "/work/a",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }),
  );

  it.effect("refuses a bundle beyond the size cap before base64 runs", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const adapter = OpenShellFleetDrainAdapters.execDrainGitBundle({
        ...execStub("", commands, 4),
        maxBytes: 8,
      });
      const outcome = yield* adapter
        .bundle({
          environmentId: EnvironmentId.make("environment:worker"),
          sandboxName: "sandbox-1",
          workspaceRoot: "/work/a",
        })
        .pipe(Effect.flip);
      expect(outcome.step).toBe("bundle");
      expect(outcome.message).toContain("size cap");
      const line = commands[0]?.join(" ") ?? "";
      expect(line).toContain("-gt 8");
      expect(line.indexOf("wc -c")).toBeLessThan(line.indexOf("base64"));
    }),
  );
});

describe("execDrainAttachments", () => {
  const frame = (name: string, bytes: string) => `==T3ATT ${name}\n${bytes}\n`;

  const source = (stdout: string, exitCode = 0) =>
    OpenShellFleetDrainAdapters.execDrainAttachments({
      exec: (sandboxName, command) => {
        expect(sandboxName).toBe("sandbox-1");
        expect(command[0]).toBe("sh");
        return Effect.succeed({ exitCode, stdout, stderr: "" });
      },
    });

  it.effect("parses framed base64 files from exec stdout", () =>
    Effect.gen(function* () {
      const attachments = yield* source(
        `${frame("attach-1.png", base64Of("one"))}${frame("attach-2.bin", base64Of("two"))}`,
      )({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        threadId: "thread:a",
      });
      expect(attachments.oversizeSkipped).toBe(false);
      expect(attachments.files.map((file) => file.name)).toEqual(["attach-1.png", "attach-2.bin"]);
      expect(Buffer.from(attachments.files[0]?.bytes ?? "", "base64").toString()).toBe("one");
    }),
  );

  it.effect("answers empty when the worker holds no attachment directory", () =>
    Effect.gen(function* () {
      const attachments = yield* source("")({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        threadId: "thread:a",
      });
      expect(attachments.files).toEqual([]);
      expect(attachments.oversizeSkipped).toBe(false);
    }),
  );

  it.effect("skips the whole set above the size cap", () =>
    Effect.gen(function* () {
      const big = OpenShellFleetDrainAdapters.execDrainAttachments({
        exec: () =>
          Effect.succeed({ exitCode: 0, stdout: frame("a.bin", base64Of("x")), stderr: "" }),
        maxBytes: 2,
      });
      const attachments = yield* big({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        threadId: "thread:a",
      });
      expect(attachments.files).toEqual([]);
      expect(attachments.oversizeSkipped).toBe(true);
    }),
  );

  it.effect("fails typed when the worker cannot list attachments", () =>
    Effect.gen(function* () {
      const failure = yield* refused(
        source(
          "",
          7,
        )({
          environmentId: EnvironmentId.make("environment:worker"),
          sandboxName: "sandbox-1",
          threadId: "thread:a",
        }),
      );
      expect(failure.step).toBe("attachments");
    }),
  );
});

describe("linkDrainSource", () => {
  it.effect("drains archived threads like live ones", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify(
                request.url.endsWith("/api/orchestration/shell")
                  ? {
                      threads: [{ threadId: "thread:a", status: "idle" }],
                      archivedThreads: [{ threadId: "thread:old", status: "archived" }],
                      projects: [],
                    }
                  : { snapshotSequence: 1, historyCursor: null, hasMoreHistory: false },
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      );
      const written: Array<string> = [];
      const files = new Map<
        string,
        { threadId: string; snapshotSequence: number | null; body: string }
      >();
      const executor = OpenShellFleetDrain.makeDrainExecutor({
        source: OpenShellFleetDrainAdapters.linkDrainSource({
          resolve: () => Effect.succeed({ url: "http://worker.test", token: "t" }),
          http,
        }),
        sink: {
          write: (input) =>
            Effect.sync(() => {
              written.push(input.threadId);
              files.set(input.threadId, {
                threadId: input.threadId,
                snapshotSequence: input.snapshotSequence,
                body: input.body,
              });
              return { bytes: input.body.length };
            }),
          read: ({ threadId }) => Effect.succeed(files.get(threadId) ?? null),
          copy: () => Effect.succeed(false),
        },
        git: { bundle: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
        now: Effect.succeed(0),
      });
      const outcome = yield* executor.drain({
        environmentId: EnvironmentId.make("environment:worker"),
        sandboxName: "sandbox-1",
        drainId: "drain:environment:worker:1",
        snapshotOnly: true,
        deadlineAt: Number.MAX_SAFE_INTEGER,
      });
      // The archived thread is copied and acked, not omitted from the drain.
      expect(outcome.state).toBe("acked");
      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      expect(written.sort()).toEqual(["thread:a", "thread:old"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
