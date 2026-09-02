import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as FileSystem from "effect/FileSystem";

import {
  carryOverClaudeSessionTranscript,
  claudeProjectDirectoryName,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps the cache key with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  describe("session transcript carry-over", () => {
    it.effect("derives the Claude project directory name from the cwd", () =>
      Effect.sync(() => {
        expect(claudeProjectDirectoryName("/Users/me/dev/app")).toBe("-Users-me-dev-app");
        expect(claudeProjectDirectoryName("/home/me/.t3")).toBe("-home-me--t3");
      }),
    );

    it.effect("copies the transcript and its sidecar into the target config dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const fromHomePath = path.join(root, "work");
        const toHomePath = path.join(root, "personal");
        const cwd = "/repo/app";
        const sessionId = "550e8400-e29b-41d4-a716-446655440000";
        const project = claudeProjectDirectoryName(cwd);
        const fromProject = path.join(fromHomePath, "projects", project);
        yield* fileSystem.makeDirectory(path.join(fromProject, sessionId, "subagents"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(fromProject, `${sessionId}.jsonl`), "{}\n");
        yield* fileSystem.writeFileString(
          path.join(fromProject, sessionId, "subagents", "agent-1.jsonl"),
          "{}\n",
        );

        const carriedOver = yield* carryOverClaudeSessionTranscript({
          fromHomePath,
          toHomePath,
          sessionId,
          cwd,
        });

        expect(carriedOver).toBe(true);
        const toProject = path.join(toHomePath, "projects", project);
        expect(yield* fileSystem.readFileString(path.join(toProject, `${sessionId}.jsonl`))).toBe(
          "{}\n",
        );
        expect(
          yield* fileSystem.exists(path.join(toProject, sessionId, "subagents", "agent-1.jsonl")),
        ).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("finds the transcript under another project directory when the cwd moved", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const fromHomePath = path.join(root, "work");
        const toHomePath = path.join(root, "personal");
        const sessionId = "550e8400-e29b-41d4-a716-446655440001";
        const fromProject = path.join(fromHomePath, "projects", "-repo-old");
        yield* fileSystem.makeDirectory(fromProject, { recursive: true });
        yield* fileSystem.writeFileString(path.join(fromProject, `${sessionId}.jsonl`), "{}\n");

        const carriedOver = yield* carryOverClaudeSessionTranscript({
          fromHomePath,
          toHomePath,
          sessionId,
          cwd: "/repo/new",
        });

        expect(carriedOver).toBe(true);
        expect(
          yield* fileSystem.exists(
            path.join(toHomePath, "projects", "-repo-old", `${sessionId}.jsonl`),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("reports a missing transcript without touching the target config dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const toHomePath = path.join(root, "personal");

        const carriedOver = yield* carryOverClaudeSessionTranscript({
          fromHomePath: path.join(root, "missing"),
          toHomePath,
          sessionId: "550e8400-e29b-41d4-a716-446655440002",
          cwd: "/repo/app",
        });

        expect(carriedOver).toBe(false);
        expect(yield* fileSystem.exists(toHomePath)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
