// @effect-diagnostics nodeBuiltinImport:off
import { layerPosix as nodePathLayerPosix } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DevinSkillsProbeError,
  decodeDevinSkillRecords,
  discoverDevinSkills,
} from "./DevinSkills.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Posix path semantics keep parser expectations identical on every host. */
const decodeWithPosixPaths = (stdout: string, cwd?: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path.pipe(Effect.provide(nodePathLayerPosix));
    return decodeDevinSkillRecords(stdout, path, cwd);
  });

const makeListSpawner = (
  stdout: string,
  exitCode = 0,
  observed?: { cwds: Array<string | undefined>; commands: Array<string> },
) =>
  ChildProcessSpawner.make((command) => {
    if (observed) {
      observed.cwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      observed.commands.push(command._tag === "StandardCommand" ? command.command : "");
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

describe("decodeDevinSkillRecords", () => {
  it.effect("maps valid records onto provider skills with SKILL.md paths", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          {
            name: "deploy",
            base_dir: "/tmp/skills/deploy",
            description: "Deploy the app.",
            display_name: "Deploy",
            triggers: ["user", "model"],
          },
        ]),
      );

      expect(skills).toEqual([
        {
          name: "deploy",
          description: "Deploy the app.",
          path: "/tmp/skills/deploy/SKILL.md",
          scope: "other",
          enabled: true,
          displayName: "Deploy",
          userInvocable: true,
        },
      ]);
    }),
  );

  it.effect("derives userInvocationOnly when triggers carry user but not model", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "user-only", base_dir: "/tmp/a", triggers: ["user"] },
          { name: "both", base_dir: "/tmp/b", triggers: ["user", "model"] },
          { name: "model-only", base_dir: "/tmp/c", triggers: ["model"] },
        ]),
      );

      const byName = new Map(skills?.map((skill) => [skill.name, skill]));
      expect(byName.get("user-only")?.userInvocationOnly).toBe(true);
      expect(byName.get("user-only")?.userInvocable).toBe(true);
      expect(byName.get("both")?.userInvocationOnly).toBeUndefined();
      expect(byName.get("both")?.userInvocable).toBe(true);
      expect(byName.get("model-only")?.userInvocable).toBeUndefined();
    }),
  );

  it.effect("disables records with errors and keeps warning-only records enabled", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "broken", base_dir: "/tmp/broken", errors: ["bad frontmatter"] },
          { name: "warned", base_dir: "/tmp/warned", warnings: ["deprecated trigger"] },
        ]),
      );

      const byName = new Map(skills?.map((skill) => [skill.name, skill]));
      expect(byName.get("broken")?.enabled).toBe(false);
      expect(byName.get("warned")?.enabled).toBe(true);
    }),
  );

  it.effect("skips malformed records without failing the batch", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "", base_dir: "/tmp/empty-name" },
          { name: "no-dir", base_dir: "" },
          { name: "no-dir", base_dir: "   " },
          "a string, not an object",
          42,
          null,
          { name: "valid", base_dir: "/tmp/valid" },
        ]),
      );

      expect(skills).toEqual([
        {
          name: "valid",
          path: "/tmp/valid/SKILL.md",
          scope: "other",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("classifies project scope from the workspace cwd", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "project-skill", base_dir: "/workspace/.devin/skills/deploy" },
          { name: "elsewhere", base_dir: "/opt/other/skills/deploy" },
        ]),
        "/workspace",
      );

      const byName = new Map(skills?.map((skill) => [skill.name, skill]));
      expect(byName.get("project-skill")?.scope).toBe("project");
      expect(byName.get("elsewhere")?.scope).toBe("other");
    }),
  );

  it.effect("classifies personal scope for Devin user-global roots", () =>
    Effect.gen(function* () {
      // Compute the personal root exactly as the implementation does so the
      // expectation holds on every host path semantics.
      const homeRoot = NodePath.posix.resolve(NodeOS.homedir(), ".devin/skills");
      const skills = yield* decodeWithPosixPaths(
        encodeJson([{ name: "personal", base_dir: `${homeRoot}/notes` }]),
      );

      expect(skills?.[0]?.scope).toBe("personal");
    }),
  );

  it.effect("deduplicates names case-insensitively keeping the first record", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "Deploy", base_dir: "/tmp/one" },
          { name: "deploy", base_dir: "/tmp/two" },
          { name: "DEPLOY", base_dir: "/tmp/three" },
          { name: "zeta", base_dir: "/tmp/zeta" },
        ]),
      );

      expect(skills?.map((skill) => skill.name)).toEqual(["Deploy", "zeta"]);
      expect(skills?.[0]?.path).toBe("/tmp/one/SKILL.md");
    }),
  );

  it.effect("sorts deterministically by name", () =>
    Effect.gen(function* () {
      const skills = yield* decodeWithPosixPaths(
        encodeJson([
          { name: "zulu", base_dir: "/tmp/z" },
          { name: "alpha", base_dir: "/tmp/a" },
          { name: "mike", base_dir: "/tmp/m" },
        ]),
      );

      expect(skills?.map((skill) => skill.name)).toEqual(["alpha", "mike", "zulu"]);
    }),
  );

  it.effect("treats an empty array as a valid empty result", () =>
    Effect.gen(function* () {
      expect(yield* decodeWithPosixPaths("[]")).toEqual([]);
    }),
  );

  it.effect("returns undefined for a non-array payload or undecodable JSON", () =>
    Effect.gen(function* () {
      expect(yield* decodeWithPosixPaths("not json")).toBeUndefined();
      expect(yield* decodeWithPosixPaths('{"skills": []}')).toBeUndefined();
      expect(yield* decodeWithPosixPaths('{"name": "x", "base_dir": "/tmp"}')).toBeUndefined();
      // A record with a non-string name fails the record schema and is skipped.
      expect(yield* decodeWithPosixPaths('[{"name": 42, "base_dir": "/tmp"}]')).toEqual([]);
    }),
  );
});

const findProbeError = (exit: Exit.Exit<unknown, unknown>): DevinSkillsProbeError | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  return isDevinSkillsProbeError(failReason?.error) ? failReason.error : undefined;
};

const isDevinSkillsProbeError = Schema.is(DevinSkillsProbeError);

describe("discoverDevinSkills", () => {
  it.effect("passes the workspace cwd and configured binary to the command", () =>
    Effect.gen(function* () {
      const observed: { cwds: Array<string | undefined>; commands: Array<string> } = {
        cwds: [],
        commands: [],
      };
      const cwd = NodePath.resolve(process.cwd());
      yield* discoverDevinSkills({ binaryPath: "devin" }, {}, cwd).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeListSpawner("[]", 0, observed),
        ),
        Effect.provide(nodePathLayerPosix),
      );

      expect(observed.cwds).toContain(cwd);
    }),
  );

  it.effect("returns an empty catalog for an authoritative empty array", () =>
    Effect.gen(function* () {
      const skills = yield* discoverDevinSkills({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("[]")),
        Effect.provide(nodePathLayerPosix),
      );
      expect(skills).toEqual([]);
    }),
  );

  it.effect("fails with a typed exit error on nonzero exit", () =>
    Effect.gen(function* () {
      const exit = yield* discoverDevinSkills({ binaryPath: "devin" }, {})
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("", 2)),
          Effect.provide(nodePathLayerPosix),
        )
        .pipe(Effect.exit);
      const error = findProbeError(exit);
      expect(error?.stage).toBe("exit");
      expect(error?.exitCode).toBe(2);
    }),
  );

  it.effect("fails with a typed decode error on invalid JSON", () =>
    Effect.gen(function* () {
      const exit = yield* discoverDevinSkills({ binaryPath: "devin" }, {})
        .pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeListSpawner("not json"),
          ),
          Effect.provide(nodePathLayerPosix),
        )
        .pipe(Effect.exit);
      expect(findProbeError(exit)?.stage).toBe("decode");
    }),
  );

  it.effect("fails with a typed decode error on a non-array payload", () =>
    Effect.gen(function* () {
      const exit = yield* discoverDevinSkills({ binaryPath: "devin" }, {})
        .pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeListSpawner('{"skills": []}'),
          ),
          Effect.provide(nodePathLayerPosix),
        )
        .pipe(Effect.exit);
      expect(findProbeError(exit)?.stage).toBe("decode");
    }),
  );
});
