// @effect-diagnostics nodeBuiltinImport:off - real subprocess regression for the agent-facing gh launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { prepareAgentGitHubEnvironment } from "./agentGitHubEnvironment.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const invocation = {
  command: process.execPath,
  entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
};
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

describe("managed GitHub CLI environment", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "intercepts local provider reads before gh, preserving writes, bypass, argv and instance overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const host = yield* ProviderHost.ProviderHost;
        const stateDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-gh-" })
          .pipe(Effect.flatMap(fs.realPath));
        const realDir = path.join(stateDir, "real gh ' $HOME `literal`");
        yield* fs.makeDirectory(realDir);
        const profileDir = path.join(stateDir, ".nvm", "bin");
        yield* fs.makeDirectory(profileDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(profileDir, "profile-tool"),
          "#!/bin/sh\nprintf 'profile tool works\\n'\n",
        );
        yield* fs.chmod(path.join(profileDir, "profile-tool"), 0o755);
        const providerPath = `${realDir}:${profileDir}`;
        const calls = path.join(stateDir, "calls");
        const entry = path.join(realDir, "real.mjs");
        yield* fs.writeFileString(
          entry,
          `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.CALLS, 'called\\n');\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), custom: process.env.CUSTOM }));\nprocess.exitCode = 23;\n`,
        );
        yield* fs.writeFileString(
          path.join(realDir, "gh"),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
        );
        yield* fs.chmod(path.join(realDir, "gh"), 0o755);
        const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Digest.Digest>();
        const prepared = yield* mergeProviderInstanceEnvironment(
          [{ name: "PATH", value: providerPath, sensitive: false }],
          { PATH: "/not-installed", CALLS: calls, CUSTOM: "kept" },
        ).pipe(
          Effect.provideService(ProviderHost.ProviderHost, {
            ...host,
            prepareAgentEnvironment: (environment) =>
              prepareAgentGitHubEnvironment({
                stateDir,
                invocation,
                platform,
                environment,
                enabled: true,
              }).pipe(Effect.provide(services), Effect.orDie),
          }),
        );
        expect(prepared.T3_GH_SHIM_DIR).toBeDefined();
        expect(prepared.PATH?.split(":")[0]).toBe(prepared.T3_GH_SHIM_DIR);
        expect(prepared.PATH).toBe(`${prepared.T3_GH_SHIM_DIR}:${providerPath}`);
        expect(
          (yield* Effect.promise(() => exec("profile-tool", [], { env: prepared }))).stdout,
        ).toBe("profile tool works\n");
        const run = (args: ReadonlyArray<string>, env = prepared) =>
          exec("gh", args, { env, cwd: stateDir });
        yield* Effect.promise(() =>
          expect(run(["pr", "checks", "12"])).rejects.toMatchObject({
            code: 1,
            stdout: "",
            stderr: expect.stringContaining("pull_request_status"),
          }),
        );
        yield* Effect.promise(() =>
          expect(run(["api", "repos/acme/app/pulls/12/reviews"])).rejects.toMatchObject({
            code: 1,
            stdout: "",
            stderr: expect.stringContaining("pull_request_feedback"),
          }),
        );
        expect(yield* fs.exists(calls)).toBe(false);

        const passthrough = [
          {
            args: ["pr", "comment", "12", "--body", "a 'quote' \"and\" $HOME; $(literal)", ""],
            env: prepared,
          },
          { args: ["pr", "checks", "12"], env: { ...prepared, T3_GH_DIRECT: "1" } },
          { args: ["pr", "view", "12", "--json", "files"], env: prepared },
          {
            args: ["api", "repos/acme/app/pulls/12/reviews", "-H", "Accept: custom"],
            env: prepared,
          },
          { args: ["pr", "checks", "12"], env: { ...prepared, GH_REPO: "elsewhere/repo" } },
        ];
        for (const { args, env } of passthrough) {
          yield* Effect.promise(() =>
            expect(run(args, env)).rejects.toMatchObject({
              code: 23,
              stderr: "",
              stdout: JSON.stringify({ args, cwd: stateDir, custom: "kept" }) + "\n",
            }),
          );
        }
        expect((yield* fs.readFileString(calls)).trim().split("\n")).toHaveLength(
          passthrough.length,
        );
        const again = yield* prepareAgentGitHubEnvironment({
          stateDir,
          invocation,
          platform,
          environment: prepared,
          enabled: true,
        });
        expect(again).toEqual(prepared);
        const disabled = yield* prepareAgentGitHubEnvironment({
          stateDir,
          invocation,
          platform,
          environment: prepared,
          enabled: false,
        });
        expect(disabled.PATH).toBe(providerPath);
        expect(disabled.T3_GH_SHIM_DIR).toBeUndefined();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          TestProviderHost.layer().pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );

  it.effect("does not manufacture an installed gh when the provider's PATH has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gh-missing-" });
      const environment = { PATH: stateDir, CUSTOM: "kept" };
      expect(
        yield* prepareAgentGitHubEnvironment({
          stateDir,
          invocation,
          platform,
          environment,
          enabled: true,
        }),
      ).toEqual(environment);
      expect(yield* fs.exists(path.join(stateDir, "github"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each([".EXE", ".CMD"])(
    "keeps Windows Path casing and resolves the original gh%s before adding gh.cmd",
    (extension) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gh-windows-" });
        const realDir = path.join(stateDir, "real");
        yield* fs.makeDirectory(realDir);
        const realCommand = path.join(realDir, `gh${extension}`);
        yield* fs.writeFileString(realCommand, "installed gh fixture");
        const prepared = yield* prepareAgentGitHubEnvironment({
          stateDir,
          invocation: { command: "C:\\T3 Code\\t3.exe", entrypoint: undefined },
          platform: "win32",
          environment: { Path: realDir, PATHEXT: extension + ";.BAT;.CMD", CUSTOM: "kept" },
          enabled: true,
        });
        expect(prepared.PATH).toBeUndefined();
        expect(prepared.Path).toBe(`${prepared.T3_GH_SHIM_DIR};${realDir}`);
        const source = yield* fs.readFileString(path.join(prepared.T3_GH_SHIM_DIR!, "gh.cmd"));
        expect(source).toContain(`"C:\\T3 Code\\t3.exe" "__github-cli" "${realCommand}" %*`);
        expect(source).toContain("DisableDelayedExpansion");
        expect(prepared.CUSTOM).toBe("kept");
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
  );
});
