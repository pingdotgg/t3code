// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";
import { installFakeMise } from "./testUtils/fakeMise.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const claudeUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: CLAUDE,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: null,
});

// Shims, wrappers, and the fake mise are POSIX scripts and symlinks.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

/** A sandbox whose paths contain spaces, as a user's home or data dir may. */
function makeSandbox(prefix = "t3 mise ") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), prefix));
  return { root, dataDir: NodePath.join(root, "mise data") };
}

function writeScript(path: string, content: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  NodeFS.chmodSync(path, 0o755);
}

/**
 * Install `<data>/installs/<dir>/<version>/<bin>`, a script that prints its
 * version, and point mise's `latest` link at it, as an install or upgrade does.
 */
function installTool(dataDir: string, directory: string, version: string, bin: string) {
  const toolDir = NodePath.join(dataDir, "installs", directory);
  writeScript(NodePath.join(toolDir, version, bin), `#!/bin/sh\necho ${version}\n`);
  NodeFS.rmSync(NodePath.join(toolDir, "latest"), { force: true });
  NodeFS.symlinkSync(version, NodePath.join(toolDir, "latest"));
  return {
    toolDir,
    installPath: NodePath.join(toolDir, version),
    latestBin: NodePath.join(toolDir, "latest", bin),
  };
}

function runLauncher(path: string, env: NodeJS.ProcessEnv = {}) {
  return NodeChildProcess.spawnSync(path, [], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).stdout.trim();
}

function miseListing(
  tool: string,
  installPath: string,
  version: string,
  options?: { readonly active?: boolean; readonly requested?: string },
) {
  return {
    [tool]: [
      {
        version,
        install_path: installPath,
        requested_version: options?.requested ?? "latest",
        active: options?.active ?? true,
      },
    ],
  };
}

function miseOutdated(tool: string, latest: string) {
  return { [tool]: { latest } };
}

it.layer(NodeServices.layer)("mise provider ownership", (it) => {
  it.effect.each([
    {
      name: "double-quoted alias",
      execLine: 'exec mise x "claude" -- "claude" "$@"',
      tool: "claude",
    },
    {
      name: "single-quoted npm backend",
      execLine: "exec mise x 'npm:@anthropic-ai/claude-code' -- 'claude' \"$@\"",
      tool: "npm:@anthropic-ai/claude-code",
    },
    {
      name: "bare words through mise exec",
      execLine: 'exec mise exec claude -- claude "$@"',
      tool: "claude",
    },
    {
      name: "a moving request that matches mise's config",
      execLine: 'exec mise x "claude@latest" -- "claude" "$@"',
      tool: "claude",
      which: "which --tool claude@latest claude",
    },
  ])(
    "upgrades the tool an Omarchy wrapper runs: $name",
    ({ execLine, tool, which = "which claude" }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "mise bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing(tool, claude.installPath, "2.1.0"),
          outdated: miseOutdated(tool, "2.1.5"),
        });
        const wrapperDir = NodePath.join(root, ".local", "bin");
        writeScript(
          NodePath.join(wrapperDir, "claude"),
          [
            "#!/bin/bash",
            // The bug in #9225 read the first mise command anywhere in the file.
            '# exec mise x "other-tool" -- "other-tool" "$@"',
            "export MISE_MINIMUM_RELEASE_AGE=0",
            'mise use -g --quiet "other-tool" || exit 1',
            execLine,
            "",
          ].join("\n"),
        );
        const env = {
          PATH: [wrapperDir, NodePath.dirname(fake.misePath)].join(NodePath.delimiter),
          HOME: root,
          MISE_DATA_DIR: dataDir,
        };

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env,
        });

        // The wrapper's own export reaches mise exactly as it would at launch.
        const launcherEnv = { ...env, MISE_MINIMUM_RELEASE_AGE: "0" };
        expect(capabilities.update).toEqual({
          command: `'${fake.misePath}' upgrade --no-prune ${tool}`,
          executable: fake.misePath,
          args: ["upgrade", "--no-prune", tool],
          lockKey: "mise",
          env: launcherEnv,
        });
        expect(capabilities.latestVersion).toBe("2.1.5");
        expect(fake.calls()).toEqual([
          { dataDir, args: which },
          { dataDir, args: "ls --installed --json" },
          { dataDir, args: `outdated --json ${tool}` },
        ]);

        // The runner spawns the action over the server's environment.
        const update = capabilities.update!;
        const result = NodeChildProcess.spawnSync(update.executable, update.args, {
          env: { ...process.env, ...update.env },
        });
        expect(result.status).toBe(0);
        expect(fake.calls().at(-1)).toEqual({ dataDir, args: `upgrade --no-prune ${tool}` });
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "follows the patched Omarchy wrapper: conditional setup, then an unconditional exec of a shim",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        // Not on PATH: only the shim's link can lead resolution to this mise.
        const fake = installFakeMise(NodePath.join(root, "opt", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: {},
        });
        NodeFS.mkdirSync(NodePath.join(dataDir, "shims"), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, NodePath.join(dataDir, "shims", "claude"));
        const binaryPath = NodePath.join(root, ".local", "bin", "claude");
        writeScript(
          binaryPath,
          [
            "#!/bin/bash",
            'shim="$HOME/mise data/shims/claude"',
            "if [[ ! -x $shim ]]; then",
            "  export MISE_MINIMUM_RELEASE_AGE=0",
            '  flock "$HOME/.config/mise/.wrapper.lock" mise use -g "claude" >/dev/null || exit 1',
            "  [[ -x $shim ]] || mise reshim >/dev/null 2>&1",
            "fi",
            'exec "$shim" "$@"',
            "",
          ].join("\n"),
        );
        const env = { PATH: "", HOME: root };

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath,
          env,
        });

        expect(capabilities.update).toMatchObject({
          executable: fake.misePath,
          args: ["upgrade", "--no-prune", "claude"],
        });
        // The release-age export only runs on first install, so it is not carried.
        expect(capabilities.update?.env).toEqual(env);
        // Up to date within its request: the installed version is the target.
        expect(capabilities.latestVersion).toBe("2.1.0");
      }),
  );

  it.effect.skipIf(windowsHost)(
    "never credits a wrapper with an exec it skips, the review's conditional launcher",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: {},
        });
        const shim = NodePath.join(dataDir, "shims", "claude");
        NodeFS.mkdirSync(NodePath.dirname(shim), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, shim);
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(
          wrapper,
          `#!/bin/sh\nif false; then\n  exec '${shim}' "$@"\nfi\nprintf unrelated\n`,
        );

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: "" },
        });

        expect(runLauncher(wrapper)).toBe("unrelated");
        expect(capabilities.update).toBeNull();
        expect(fake.calls()).toEqual([]);
      }),
  );

  it.effect.each([
    {
      name: "only a commented-out line mentions mise",
      script: '#!/bin/sh\n# exec mise x "claude" -- "claude" "$@"\nexec /bin/sh "$@"\n',
    },
    {
      name: "the exec sits inside a branch",
      script: '#!/bin/sh\nif [ -n "$X" ]; then exec mise x claude -- claude "$@"; fi\n',
    },
    {
      name: "a branch may launch something else and exit first",
      script:
        '#!/bin/sh\nif [ -n "$X" ]; then\n  other "$@"\n  exit\nfi\nexec mise x claude -- claude "$@"\n',
    },
    {
      name: "an unconditional exit comes first",
      script: '#!/bin/sh\nexit 0\nexec mise x claude -- claude "$@"\n',
    },
    {
      name: "the exec'd variable is only assigned on some runs",
      script:
        '#!/bin/sh\nshim=/usr/bin/true\nif [ -n "$X" ]; then\n  shim="$HOME/shims/claude"\nfi\nexec "$shim" "$@"\n',
    },
    {
      name: "mise runs a script rather than the tool's own binary",
      script: '#!/bin/sh\nexec mise x node -- node "$HOME/cli.js" "$@"\n',
    },
    {
      name: "the exec line uses shell features",
      script: '#!/bin/sh\nexec mise x "$(pick-tool)" -- claude "$@"\n',
    },
    {
      name: "the launcher sources another file",
      script: '#!/bin/sh\n. "$HOME/env"\nexec mise x claude -- claude "$@"\n',
    },
  ])(
    "never runs mise when $name",
    ({ script }) =>
      Effect.gen(function* () {
        const { root } = makeSandbox();
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {});
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, script);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath), HOME: root },
        });

        expect(capabilities.update).toBeNull();
        expect(fake.calls()).toEqual([]);
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "probes and upgrades the data root a wrapper selects, not the server's",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const wrapperRoot = NodePath.join(root, "wrapper root");
        const claude = installTool(wrapperRoot, "claude", "2.1.0", "bin/claude");
        // Only the PATH the wrapper sets leads to this mise.
        const fake = installFakeMise(NodePath.join(root, "wrapper bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: miseOutdated("claude", "2.1.5"),
        });
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(
          wrapper,
          [
            "#!/bin/sh",
            'MISE_DATA_DIR="$HOME/wrapper root"',
            "export MISE_DATA_DIR",
            'export PATH="$HOME/wrapper bin:$PATH"',
            'exec mise x claude -- claude "$@"',
            "",
          ].join("\n"),
        );

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: "/usr/bin:/bin", HOME: root, MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update).toMatchObject({
          executable: fake.misePath,
          args: ["upgrade", "--no-prune", "claude"],
          env: { MISE_DATA_DIR: wrapperRoot },
        });
        expect(fake.calls().map((call) => call.dataDir)).toEqual([
          wrapperRoot,
          wrapperRoot,
          wrapperRoot,
        ]);
      }),
  );

  it.effect.each([
    {
      name: "changes the data root on only some runs",
      setup: 'if [ -n "$X" ]; then\n  export MISE_DATA_DIR=/elsewhere\nfi',
    },
    { name: "changes directory", setup: 'cd "$HOME/project"' },
    { name: "sets the data root from a command", setup: "export MISE_DATA_DIR=$(pick-root)" },
    { name: "sets the config root to an unknown value", setup: 'export MISE_CONFIG_DIR="$NOPE"' },
  ])(
    "stays manual-only without probing when the wrapper $name",
    ({ setup }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: {},
        });
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, `#!/bin/sh\n${setup}\nexec mise x claude -- claude "$@"\n`);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath), HOME: root, MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update).toBeNull();
        expect(fake.calls()).toEqual([]);
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "upgrades a wrapper's explicit @latest without touching the config's pin",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const pinned = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const explicit = installTool(dataDir, "claude", "2.1.5", "bin/claude");
        // mise lists the explicit selection's install as inactive: the config selects 2.1.0.
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: explicit.latestBin },
          ls: {
            claude: [
              {
                version: "2.1.0",
                install_path: pinned.installPath,
                requested_version: "2.1.0",
                active: true,
              },
              { version: "2.1.5", install_path: explicit.installPath, active: false },
            ],
          },
          outdated: miseOutdated("claude", "2.2.0"),
        });
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, '#!/bin/sh\nexec mise x "claude@latest" -- "claude" "$@"\n');

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath), MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update?.args).toEqual(["upgrade", "--no-prune", "claude@latest"]);
        expect(capabilities.latestVersion).toBe("2.2.0");
        expect(fake.calls().map((call) => call.args)).toEqual([
          "which --tool claude@latest claude",
          "ls --installed --json",
          "outdated --json claude@latest",
        ]);
      }),
  );

  it.effect.each([
    { name: "a fixed version in the wrapper", spec: "claude@2.0.0", requested: "latest" },
    { name: "a request mise's config does not make", spec: "claude@2", requested: "latest" },
    { name: "a different tool", spec: "npm:other", requested: "latest" },
  ])(
    "stays manual-only when the wrapper runs $name",
    ({ spec, requested }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: claude.latestBin },
          ls: miseListing("claude", claude.installPath, "2.1.0", { requested }),
          outdated: {},
        });
        const wrapper = NodePath.join(root, "wrapper", "claude");
        writeScript(wrapper, `#!/bin/sh\nexec mise x "${spec}" -- "claude" "$@"\n`);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: wrapper,
          env: { PATH: NodePath.dirname(fake.misePath) },
        });

        expect(capabilities.update).toBeNull();
      }),
    { skip: windowsHost },
  );

  it.effect.each([
    { name: "a link to mise's latest", link: "latest", target: "2.1.5", follows: true },
    { name: "a range link the upgrade stays in", link: "2.1", target: "2.1.5", follows: true },
    { name: "a range link the upgrade leaves", link: "2.1", target: "2.2.0", follows: false },
    { name: "a link straight into a version", link: "2.1.0", target: "2.1.5", follows: false },
  ])(
    "offers an update through $name only when the launch follows it",
    ({ link, target, follows }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        if (link === "2.1") NodeFS.symlinkSync("2.1.0", NodePath.join(claude.toolDir, "2.1"));
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ls: miseListing("claude", claude.installPath, "2.1.0"),
          outdated: miseOutdated("claude", target),
        });
        const launchers = {
          link: NodePath.join(root, "links", "claude"),
          wrapper: NodePath.join(root, "wrapper", "claude"),
        };
        NodeFS.mkdirSync(NodePath.dirname(launchers.link));
        NodeFS.symlinkSync(NodePath.join(claude.toolDir, link, "bin", "claude"), launchers.link);
        writeScript(launchers.wrapper, `#!/bin/sh\nexec '${launchers.link}' "$@"\n`);
        const env = { PATH: NodePath.dirname(fake.misePath), MISE_DATA_DIR: dataDir };

        for (const launcher of Object.values(launchers)) {
          const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
            binaryPath: launcher,
            env,
          });
          expect(capabilities.update?.args ?? null).toEqual(
            follows ? ["upgrade", "--no-prune", "claude"] : null,
          );
        }

        // What mise does on upgrade: install the target, move `latest` and the range link.
        installTool(dataDir, "claude", target, "bin/claude");
        if (link === "2.1" && target.startsWith("2.1.")) {
          NodeFS.rmSync(NodePath.join(claude.toolDir, "2.1"));
          NodeFS.symlinkSync(target, NodePath.join(claude.toolDir, "2.1"));
        }
        for (const launcher of Object.values(launchers)) {
          expect(runLauncher(launcher)).toBe(follows ? target : "2.1.0");
        }
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "treats an exact pin as current instead of advertising an unreachable update",
    () =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const tool = "npm:@anthropic-ai/claude-code";
        const claude = installTool(
          dataDir,
          "npm-anthropic-ai-claude-code",
          "2.1.0",
          "lib/node_modules/@anthropic-ai/claude-code/cli.js",
        );
        // `mise outdated` omits a tool pinned to its installed version.
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ls: miseListing(tool, claude.installPath, "2.1.0", { requested: "2.1.0" }),
          outdated: {},
        });
        const binaryPath = NodePath.join(root, "links", "claude");
        NodeFS.mkdirSync(NodePath.dirname(binaryPath));
        NodeFS.symlinkSync(claude.latestBin, binaryPath);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath,
          env: { PATH: NodePath.dirname(fake.misePath), MISE_DATA_DIR: dataDir },
        });

        expect(capabilities.update?.args).toEqual(["upgrade", "--no-prune", tool]);
        expect(
          createProviderVersionAdvisory({
            driver: CLAUDE,
            currentVersion: "2.1.0",
            latestVersion: capabilities.latestVersion ?? null,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({ status: "current", canUpdate: true, canInstallVersion: false });
      }),
  );

  it.effect.each([
    { name: "no mise is on PATH", mise: "missing" },
    { name: "`mise ls` fails", mise: "failing" },
    { name: "`mise ls` prints invalid JSON", mise: "invalid" },
  ] as const)(
    "keeps a mise npm backend in a custom data root from npm when $name",
    ({ mise }) =>
      Effect.gen(function* () {
        const { root } = makeSandbox("t3 tools ");
        const dataDir = NodePath.join(root, "custom-tools");
        const claude = installTool(
          dataDir,
          "npm-anthropic-ai-claude-code",
          "1.0.0",
          "lib/node_modules/@anthropic-ai/claude-code/cli.js",
        );
        const fake = installFakeMise(
          NodePath.join(root, "bin", "mise"),
          mise === "invalid" ? { ls: "not json" } : {},
        );

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: claude.latestBin,
          env: {
            PATH: mise === "missing" ? "" : NodePath.dirname(fake.misePath),
            MISE_DATA_DIR: dataDir,
          },
        });

        expect(capabilities.update).toBeNull();
      }),
    { skip: windowsHost },
  );

  it.effect.each([
    { name: "through a shim, as mise reports it", via: "shim" },
    { name: "directly, when mise cannot list its installs", via: "path" },
  ] as const)(
    "keeps npm updates for a global under mise's Node $name",
    ({ via }) =>
      Effect.gen(function* () {
        const { root } = makeSandbox("t3 tools ");
        const dataDir = NodePath.join(root, "custom-tools");
        const node = NodePath.join(dataDir, "installs", "node", "24.0.0");
        const entry = NodePath.join(
          node,
          "lib",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js",
        );
        writeScript(entry, "#!/bin/sh\n");
        NodeFS.mkdirSync(NodePath.join(node, "bin"));
        NodeFS.symlinkSync(entry, NodePath.join(node, "bin", "claude"));
        const fake = installFakeMise(
          NodePath.join(root, "bin", "mise"),
          via === "shim"
            ? {
                which: { claude: NodePath.join(node, "bin", "claude") },
                ls: miseListing("node", node, "24.0.0"),
              }
            : {},
        );
        const shimDir = NodePath.join(dataDir, "shims");
        NodeFS.mkdirSync(shimDir, { recursive: true });
        NodeFS.symlinkSync(fake.misePath, NodePath.join(shimDir, "claude"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env: {
            PATH:
              via === "shim"
                ? shimDir
                : [NodePath.join(node, "bin"), NodePath.dirname(fake.misePath)].join(
                    NodePath.delimiter,
                  ),
            MISE_DATA_DIR: dataDir,
          },
        });

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", node, "@anthropic-ai/claude-code@latest"]),
        });
      }),
    { skip: windowsHost },
  );

  it.effect.each(
    (["standard", "custom"] as const).flatMap((root) =>
      (
        [
          {
            name: "an alias for mise's Node",
            tool: "node-lts",
            backend: "core:node",
            owner: "npm",
          },
          {
            name: "an alias for an npm backend",
            tool: "claude",
            backend: "npm:@anthropic-ai/claude-code",
            owner: "mise",
          },
          {
            name: "an alias whose backend mise cannot report",
            tool: "node-lts",
            backend: null,
            owner: "manual",
          },
        ] as const
      ).map((fixture) => ({ ...fixture, root })),
    ),
  )(
    "decides a node_modules binary under $name in the $root data root by mise's backend",
    ({ tool, owner, backend, root: rootKind }) =>
      Effect.gen(function* () {
        // The standard root's `/mise/installs/` path is the one the npm guard watches.
        const { root } = makeSandbox("t3 tools ");
        const dataDir =
          rootKind === "standard"
            ? NodePath.join(root, ".local", "share", "mise")
            : NodePath.join(root, "custom-tools");
        const install = NodePath.join(dataDir, "installs", tool, "24.0.0");
        const entry = NodePath.join(
          install,
          "lib",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js",
        );
        writeScript(entry, "#!/bin/sh\n");
        NodeFS.mkdirSync(NodePath.join(install, "bin"));
        NodeFS.symlinkSync(entry, NodePath.join(install, "bin", "claude"));
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          which: { claude: NodePath.join(install, "bin", "claude") },
          ls: miseListing(tool, install, "24.0.0"),
          // Node's own latest must never be advertised as the provider's.
          outdated: miseOutdated(tool, "24.1.0"),
          ...(backend === null ? {} : { backends: { [tool]: backend } }),
        });
        const shimDir = NodePath.join(dataDir, "shims");
        NodeFS.mkdirSync(shimDir, { recursive: true });
        NodeFS.symlinkSync(fake.misePath, NodePath.join(shimDir, "claude"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env: {
            PATH: shimDir,
            HOME: root,
            ...(rootKind === "custom" ? { MISE_DATA_DIR: dataDir } : {}),
          },
        });

        expect(fake.calls().map((call) => call.args)).toContain(`tool --backend ${tool}`);
        if (owner === "npm") {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining(["--prefix", install, "@anthropic-ai/claude-code@latest"]),
          });
        } else if (owner === "mise") {
          expect(capabilities.update?.args).toEqual(["upgrade", "--no-prune", tool]);
          expect(capabilities.latestVersion).toBe("24.1.0");
        } else {
          expect(capabilities.update).toBeNull();
        }
      }),
    { skip: windowsHost },
  );

  it.effect.each([
    {
      name: "a version directory `mise activate` put on PATH",
      launch: "version-directory",
      active: true,
    },
    { name: "a version mise's config does not select", launch: "latest-link", active: false },
  ] as const)(
    "stays manual-only for $name",
    ({ launch, active }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ls: miseListing("claude", claude.installPath, "2.1.0", { active }),
          outdated: miseOutdated("claude", "2.1.5"),
        });
        const binDir =
          launch === "version-directory"
            ? NodePath.join(claude.installPath, "bin")
            : NodePath.dirname(claude.latestBin);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: "claude",
          env: { PATH: [binDir, NodePath.dirname(fake.misePath)].join(NodePath.delimiter) },
        });

        expect(capabilities.update).toBeNull();
        expect(fake.calls().map((call) => call.args)).toEqual(["ls --installed --json"]);
      }),
    { skip: windowsHost },
  );

  it.effect.each([
    { name: "mise has no tool for the shim", which: false, ls: {} },
    { name: "`mise ls` prints something unexpected", which: true, ls: "not json" },
    { name: "the bin is outside every install", which: true, ls: {} },
  ])(
    "stays manual-only when $name",
    ({ which, ls }) =>
      Effect.gen(function* () {
        const { root, dataDir } = makeSandbox();
        const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude");
        const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
          ...(which ? { which: { claude: claude.latestBin } } : {}),
          ls,
        });
        const shim = NodePath.join(dataDir, "shims", "claude");
        NodeFS.mkdirSync(NodePath.dirname(shim), { recursive: true });
        NodeFS.symlinkSync(fake.misePath, shim);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
          binaryPath: shim,
          env: { PATH: "" },
        });

        expect(capabilities.update).toBeNull();
      }),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)("leaves installs mise does not report to other installers", () =>
    Effect.gen(function* () {
      const { root } = makeSandbox();
      // asdf shares mise's `installs/<tool>/<version>` layout.
      const prefix = NodePath.join(root, ".asdf", "installs", "nodejs", "24.0.0");
      const entry = NodePath.join(
        prefix,
        "lib",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      );
      writeScript(entry, "#!/bin/sh\n");
      const fake = installFakeMise(NodePath.join(root, "bin", "mise"), { ls: {} });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
        binaryPath: entry,
        env: { PATH: NodePath.dirname(fake.misePath), HOME: root },
      });

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: expect.arrayContaining(["--prefix", prefix]),
      });
    }),
  );

  it.effect.skipIf(windowsHost)("recognizes a Windows shim beside mise's installs", () =>
    Effect.gen(function* () {
      const { root, dataDir } = makeSandbox();
      const claude = installTool(dataDir, "claude", "2.1.0", "bin/claude.exe");
      const fake = installFakeMise(NodePath.join(root, "bin", "mise"), {
        which: { claude: claude.latestBin },
        ls: miseListing("claude", claude.installPath, "2.1.0"),
        outdated: miseOutdated("claude", "2.1.5"),
      });
      const shim = NodePath.join(dataDir, "shims", "claude.cmd");
      writeScript(shim, "@echo off\r\n");
      const env = { PATH: NodePath.dirname(fake.misePath) };

      const capabilities = yield* resolvePackageManagedProviderMaintenance(
        { provider: CLAUDE, npmPackageName: "@anthropic-ai/claude-code", nativeUpdate: null },
        {
          binaryPath: "claude",
          resolvedCommandPath: shim,
          realCommandPath: shim,
          env,
          platform: "win32",
        },
      );

      expect(capabilities.update).toMatchObject({
        executable: fake.misePath,
        args: ["upgrade", "--no-prune", "claude"],
      });
      expect(capabilities.latestVersion).toBe("2.1.5");
    }),
  );
});
