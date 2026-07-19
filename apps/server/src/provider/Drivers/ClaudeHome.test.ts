// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeCodeExecutable,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const nodeServicesIt = it.layer(NodeServices.layer);

nodeServicesIt("ClaudeHome", (it) => {
  it.effect("unwraps Windows npm shims to the package native binary", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const prefix = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-npm-")),
      );
      const shimPath = path.join(prefix, "claude.cmd");
      const nativeBinary = path.join(
        prefix,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(path.dirname(nativeBinary), { recursive: true });
        NodeFS.writeFileSync(shimPath, "@ECHO off\r\n");
        NodeFS.writeFileSync(nativeBinary, "");
      });

      const resolved = yield* resolveClaudeCodeExecutable(shimPath).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      expect(resolved).toBe(nativeBinary);
    }),
  );

  it.effect("keeps an explicit native executable path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const prefix = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-native-")),
      );
      const nativeBinary = path.join(prefix, "claude.exe");
      yield* Effect.sync(() => {
        NodeFS.writeFileSync(nativeBinary, "");
      });

      const resolved = yield* resolveClaudeCodeExecutable(nativeBinary).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      expect(resolved).toBe(nativeBinary);
    }),
  );

  it.effect("does not replace a custom exe when a sibling npm package binary exists", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const prefix = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-custom-")),
      );
      const customBinary = path.join(prefix, "claude.exe");
      const npmNativeBinary = path.join(
        prefix,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(path.dirname(npmNativeBinary), { recursive: true });
        NodeFS.writeFileSync(customBinary, "");
        NodeFS.writeFileSync(npmNativeBinary, "");
      });

      const resolved = yield* resolveClaudeCodeExecutable(customBinary).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      expect(resolved).toBe(customBinary);
    }),
  );

  it.effect("uses the process home when no Claude home override is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved = path.resolve(NodeOS.homedir());

      expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
      expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
    }),
  );

  it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const homePath = "~/.claude-work";
      const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

      expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
      expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
      expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
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

  it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved = path.resolve(NodeOS.homedir());

      expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
        `claude:home:${resolved}`,
      );
    }),
  );
});
