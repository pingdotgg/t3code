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
        },
        git: { push: () => Effect.succeed({ exitCode: 0, stderr: "" }) },
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
