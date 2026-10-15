// @effect-diagnostics nodeBuiltinImport:off - the allowance is per-process Node state, so each case runs in a real Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

const printAttemptTimeout =
  "process.stdout.write(String(require('node:net').getDefaultAutoSelectFamilyAttemptTimeout()))";

interface ConnectionPolicy {
  /** Per-address connect allowance in the process that applied the policy. */
  readonly server: number;
  /** What a provider CLI spawned with the server's environment gets. */
  readonly spawnedChild: number;
  readonly nodeOptions: string | null;
}

// Starts a Node process the way the CLI does: apply the policy, then report the
// allowance it ends up with and what a child spawned with its env inherits.
// Node 22.16 and 22.17 only import the `.ts` module with type stripping turned
// on. Type stripping and config files may print an ExperimentalWarning on
// stderr, depending on the Node version.
const runServerProcess = (options: {
  readonly nodeOptions?: string;
  readonly execArgv?: ReadonlyArray<string>;
  readonly cwd?: string;
}): ConnectionPolicy => {
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      ...(options.execArgv ?? []),
      "--input-type=module",
      "--eval",
      `import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
const { allowSlowOutboundConnections } = await import(${JSON.stringify(new URL("./outboundConnections.ts", import.meta.url).href)});
allowSlowOutboundConnections();
const spawnedChild = NodeChildProcess.execFileSync(process.execPath, ["--eval", ${JSON.stringify(printAttemptTimeout)}], { env: process.env, encoding: "utf8" });
process.stdout.write(JSON.stringify({
  server: NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(),
  spawnedChild: Number(spawnedChild),
  nodeOptions: process.env.NODE_OPTIONS ?? null,
}));`,
    ],
    {
      encoding: "utf8",
      cwd: options.cwd,
      env: { ...process.env, NODE_OPTIONS: options.nodeOptions },
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.stderr, "");
  assert.equal(child.status, 0);
  return JSON.parse(child.stdout);
};

const nodeDefaultAttemptTimeout = () =>
  Number(
    NodeChildProcess.execFileSync(process.execPath, ["--eval", printAttemptTimeout], {
      env: { ...process.env, NODE_OPTIONS: undefined },
      encoding: "utf8",
    }),
  );

it("gives slow outbound connects at least a second without leaking into spawned CLIs", () => {
  const policy = runServerProcess({});

  assert.isAtLeast(policy.server, 1_000);
  assert.equal(policy.spawnedChild, nodeDefaultAttemptTimeout());
  assert.equal(policy.nodeOptions, null);
});

it("keeps an explicit Node attempt timeout from NODE_OPTIONS", () => {
  const nodeOptions = "--network-family-autoselection-attempt-timeout=300";
  const policy = runServerProcess({ nodeOptions });

  assert.equal(policy.server, 300);
  assert.equal(policy.spawnedChild, 300);
  assert.equal(policy.nodeOptions, nodeOptions);
});

it("keeps an explicit Node attempt timeout from the command line", () => {
  const policy = runServerProcess({
    execArgv: ["--network_family_autoselection_attempt_timeout=300"],
  });

  assert.equal(policy.server, 300);
  assert.equal(policy.spawnedChild, nodeDefaultAttemptTimeout());
});

it.each([
  [
    "a path",
    (dir: string) => {
      const file = NodePath.join(dir, "node.config.json");
      // Node 22.16 garbles the path in the `=` form and exits before running
      // any code; it reads the separate argument correctly.
      return process.versions.node.startsWith("22.16.")
        ? ["--experimental-config-file", file]
        : [`--experimental-config-file=${file}`];
    },
  ],
  ["the default file", () => ["--experimental-default-config-file"]],
] as const)("keeps an explicit Node attempt timeout from a config file given %s", (_, flags) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-outbound-connections-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(dir, "node.config.json"),
      JSON.stringify({ nodeOptions: { "network-family-autoselection-attempt-timeout": 300 } }),
    );
    const policy = runServerProcess({
      execArgv: flags(dir),
      cwd: dir,
    });

    assert.equal(policy.server, 300);
    assert.equal(policy.spawnedChild, nodeDefaultAttemptTimeout());
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
