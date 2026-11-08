import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseCodexCliVersion, resolveCodexCliPath } from "./codexCli.ts";

describe("parseCodexCliVersion", () => {
  it.each([
    ["codex-cli 0.159.0", "0.159.0"],
    ["codex-cli 0.160.0-alpha.1", "0.160.0-alpha.1"],
    ["codex-cli 0.167.0-alpha.3.2\n", "0.167.0-alpha.3.2"],
    ["0.1.4161006", "0.1.4161006"],
    ["not a version", null],
  ])("parses %s", (output, expected) => {
    expect(parseCodexCliVersion(output)).toBe(expected);
  });
});

describe("resolveCodexCliPath", () => {
  it.effect("finds the CLI bundled with the Windows desktop app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-desktop-" });
      const bin = path.join(root, "OpenAI", "Codex", "bin", "version-hash");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(path.join(bin, "codex.exe"), "codex");
      yield* fs.writeFileString(path.join(bin, "codex-code-mode-host.exe"), "host");

      const resolved = yield* resolveCodexCliPath({
        binaryPath: "codex",
        environment: { PATH: "", LOCALAPPDATA: root },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(resolved).toBe(path.join(bin, "codex.exe"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a desktop directory without code mode host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-desktop-" });
      const bin = path.join(root, "OpenAI", "Codex", "bin", "version-hash");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(path.join(bin, "codex.exe"), "codex");

      const resolved = yield* resolveCodexCliPath({
        binaryPath: "codex",
        environment: { PATH: "", LOCALAPPDATA: root },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(resolved).toBe("codex");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an explicitly configured binary path", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCodexCliPath({
        binaryPath: "C:\\tools\\codex.exe",
        environment: { PATH: "" },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(resolved).toBe("C:\\tools\\codex.exe");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the command unchanged on other platforms", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCodexCliPath({
        binaryPath: "codex",
        environment: { PATH: "" },
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"));

      expect(resolved).toBe("codex");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
