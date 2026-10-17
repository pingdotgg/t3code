// @effect-diagnostics nodeBuiltinImport:off - Effect's symlink cannot make the junctions Windows users link these homes with.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:projects:${path.join(resolved, "projects")}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          `claude:projects:${path.join(resolved, "projects")}`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:projects:${path.join(inherited, "projects")}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    const makeClaudeHomes = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" }),
      );
      const home = (name: string) => path.join(root, name);
      const linkDirectory = (target: string, link: string) =>
        Effect.promise(() => NodeFSP.symlink(target, link, "junction"));
      const linkProjects = (name: string, target: string) =>
        fileSystem
          .makeDirectory(home(name))
          .pipe(Effect.andThen(linkDirectory(target, path.join(home(name), "projects"))));

      yield* fileSystem.makeDirectory(path.join(home("shared"), "projects"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(home("separate"), "projects"), { recursive: true });
      yield* fileSystem.makeDirectory(home("fresh"));
      yield* linkProjects("overlay", path.join(home("shared"), "projects"));
      yield* linkProjects("chained", path.join(home("overlay"), "projects"));
      yield* linkProjects("dangling", path.join(home("missing"), "projects"));
      yield* linkDirectory(home("shared"), home("alias"));
      for (const account of ["personal", "work"]) {
        yield* fileSystem.makeDirectory(path.join(home("transcripts"), account), {
          recursive: true,
        });
        yield* linkProjects(account, path.join(home("transcripts"), account));
      }
      return home;
    });
    const keyFor = (homePath: string, environment?: NodeJS.ProcessEnv) =>
      makeClaudeContinuationGroupKey({ homePath }, environment);
    const ownProjectsKey = (homePath: string) =>
      Effect.map(Path.Path, (path) => `claude:projects:${path.join(homePath, "projects")}`);

    it.effect("groups auth-overlay homes with the home their projects link points at", () =>
      Effect.gen(function* () {
        const home = yield* makeClaudeHomes;
        const sharedKey = yield* ownProjectsKey(home("shared"));

        expect(yield* keyFor(home("shared"))).toBe(sharedKey);
        expect(yield* keyFor(home("overlay"))).toBe(sharedKey);
        expect(yield* keyFor(home("chained"))).toBe(sharedKey);
        expect(yield* keyFor(home("alias"))).toBe(sharedKey);
        expect(yield* keyFor("", { CLAUDE_CONFIG_DIR: home("overlay") })).toBe(sharedKey);
        expect(yield* keyFor(home("separate"))).toBe(yield* ownProjectsKey(home("separate")));
      }),
    );

    it.effect("keeps a home without resolvable projects in its own group", () =>
      Effect.gen(function* () {
        const home = yield* makeClaudeHomes;

        expect(yield* keyFor(home("fresh"))).toBe(yield* ownProjectsKey(home("fresh")));
        expect(yield* keyFor(home("dangling"))).toBe(yield* ownProjectsKey(home("dangling")));
        expect(yield* keyFor(home("missing"))).toBe(yield* ownProjectsKey(home("missing")));
      }),
    );

    it.effect("keeps homes whose projects link to sibling directories apart", () =>
      Effect.gen(function* () {
        const home = yield* makeClaudeHomes;

        expect(yield* keyFor(home("personal"))).not.toBe(yield* keyFor(home("work")));
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
