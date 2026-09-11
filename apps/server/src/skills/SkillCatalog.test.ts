// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import { make } from "./SkillCatalog.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const runOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect("discovers scoped skills, refreshes project instructions, and bounds file reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const first = NodePath.join(root, "first");
      const second = NodePath.join(root, "second");
      const global = NodePath.join(root, "global");
      yield* Effect.promise(() =>
        Promise.all(
          [first, second, global].map(async (path) => {
            await NodeFSP.mkdir(path);
            await NodeFSP.writeFile(
              NodePath.join(path, "SKILL.md"),
              `---\nname: example\ndescription: Useful instructions.\n---\n\nInstructions for ${path}`,
            );
          }),
        ),
      );
      const invocations: ProcessRunner.ProcessRunInput[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            invocations.push(input);
            const isGlobal = input.args.includes("--global");
            return runOutput(
              JSON.stringify([
                {
                  name: "example",
                  path: isGlobal ? global : input.cwd,
                  scope: isGlobal ? "global" : "project",
                  agents: ["Codex"],
                  source: null,
                  sourceUrl: null,
                  sourceType: null,
                },
              ]),
            );
          }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      expect((yield* catalog.list()).map((s) => s.scope)).toEqual(["global"]);
      expect(Option.isNone(yield* catalog.detail("project", "example"))).toBe(true);
      expect((yield* catalog.list(first)).map((s) => [s.scope, s.description])).toEqual([
        ["project", "Useful instructions."],
        ["global", "Useful instructions."],
      ]);
      yield* catalog.list(second);
      for (const cwd of [first, second]) {
        expect(Option.getOrThrow(yield* catalog.detail("project", "example", cwd)).content).toBe(
          `Instructions for ${cwd}`,
        );
      }
      expect(Option.isNone(yield* catalog.detail("project", "../unknown", first))).toBe(true);
      const filePath = NodePath.join(first, "SKILL.md");
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, "Updated instructions"));
      yield* catalog.list(first);
      expect(Option.getOrThrow(yield* catalog.detail("project", "example", first)).content).toBe(
        "Updated instructions",
      );

      for (const input of invocations) {
        expect(input.command).toBe("npx");
        expect(input.args).toContain("--package=skills@1.5.23");
        expect(input.args).toContain("--ignore-scripts");
        const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
        expect(prefix).not.toBe(input.cwd);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(prefix).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }
      for (const size of [0, 512 * 1024]) {
        yield* Effect.promise(() => NodeFSP.writeFile(filePath, "x".repeat(size)));
        expect(
          Option.getOrThrow(yield* catalog.detail("project", "example", first)).content,
        ).toHaveLength(size);
      }
      const open = NodeFSP.open;
      let closed = false;
      const spy = vi.spyOn(NodeFSP, "open").mockImplementationOnce(async (...args) => {
        const file = await open(...args);
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementation(async () => {
          await close();
          closed = true;
        });
        await NodeFSP.appendFile(filePath, "x");
        return file;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      expect((yield* catalog.detail("project", "example", first).pipe(Effect.flip))._tag).toBe(
        "SkillReadError",
      );
      expect(closed).toBe(true);
    }),
  ),
);

it.effect(
  "shares and bounds discovery, then recovers after refresh, cancellation, and failure",
  () =>
    Effect.gen(function* () {
      let entered = yield* Deferred.make<void>();
      let release = yield* Deferred.make<void>();
      let runs = 0;
      let active = 0;
      let fail = false;
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.gen(function* () {
            runs++;
            active++;
            if (active === 2) yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { ...runOutput("[]"), code: ChildProcessSpawner.ExitCode(fail ? 1 : 0) };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const first = yield* catalog.list("/project-a").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const subscribers = yield* Effect.forEach(Array.from({ length: 20 }), () =>
        catalog.list("/project-a").pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      const busy = yield* catalog.list("/project-b").pipe(Effect.flip);
      expect(busy._tag).toBe("SkillDiscoveryError");
      if (busy._tag === "SkillDiscoveryError") expect(busy.stage).toBe("busy");
      expect(runs).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Effect.forEach(subscribers, Fiber.join);
      expect(runs).toBe(2);
      yield* catalog.list("/project-a");
      expect(runs).toBe(4);
      expect(active).toBe(0);

      entered = yield* Deferred.make<void>();
      release = yield* Deferred.make<void>();
      const abandoned = yield* catalog.list("/project-a").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(abandoned);
      expect(active).toBe(0);
      yield* Deferred.succeed(release, undefined);
      fail = true;
      expect((yield* catalog.list().pipe(Effect.flip))._tag).toBe("SkillDiscoveryError");
      fail = false;
      expect(yield* catalog.list("/project-a")).toEqual([]);
      expect(active).toBe(0);
    }),
);
