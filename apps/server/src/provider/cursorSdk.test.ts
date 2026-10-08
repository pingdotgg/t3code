// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The probe is a plain Node child; this deadline kills it if it hangs.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const cursorSdkUrl = new URL("./cursorSdk.ts", import.meta.url).href;

// Loads cursorSdk.ts in a fresh process. The send probe uses the real SDK;
// shell guard probes stub it. The worker's own unhandledRejection listener
// would hide the process-exit behavior.
const probeProgram = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const sdkRequire = createRequire(createRequire(${JSON.stringify(cursorSdkUrl)}).resolve("@cursor/sdk"));
const protobufUrl = pathToFileURL(sdkRequire.resolve("@bufbuild/protobuf")).href;
const { proto3, ScalarType } = sdkRequire("@bufbuild/protobuf");
const mode = process.argv[1];
if (mode === "sdk-model-requests") {
  process.on("uncaughtException", error => {
    console.error(error.stack);
    process.exit(1);
  });
}
const dir = mkdtempSync(join(tmpdir(), "cursor-sdk-stub-"));
const stub = join(dir, "stub.cjs");
writeFileSync(
  stub,
  "module.exports = { Agent: {}, AuthenticationError: class {}, createAgentPlatform: () => ({}), Cursor: {}, CursorSdkError: class {}, InMemoryCredentialStore: class {} };",
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cursor/sdk" && mode !== "sdk-model-requests") {
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    if (specifier === "@bufbuild/protobuf") {
      return { url: protobufUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { isCursorShellSpawnFailure, createAgentPlatform } = await import(${JSON.stringify(cursorSdkUrl)});
const missingCwd = join(tmpdir(), "t3-missing-cwd-" + process.pid);

if (mode === "sdk-model-requests") {
  const { JsonlLocalAgentStore } = sdkRequire("@cursor/sdk");
  const store = new JsonlLocalAgentStore(join(dir, "store"));
  const platform = await createAgentPlatform({ localStore: store, workspaceRef: dir });
  // Catalog validation is an external dependency; the SDK's send path and
  // generated RequestedModel constructor stay real. Stop before transport.
  platform.resolveLocalModelSelection = async selection => selection;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  const requests = [];
  const initPartial = proto3.util.initPartial;
  const captured = new Error("model request captured before transport");
  proto3.util.initPartial = function(source, target) {
    initPartial.call(this, source, target);
    if (target.getType().typeName !== "agent.v1.RequestedModel" || !target.modelId) return;
    const decoded = target.getType().fromBinary(target.toBinary());
    requests.push({ model: decoded.modelId, maxMode: decoded.maxMode,
      context: decoded.parameters.find(parameter => parameter.id === "context")?.value });
    throw captured;
  };
  for (const [id, context] of [
    ["grok-4.7", "500k"], ["grok-4.7", "256k"],
    ["claude-opus-5-5", "1m"], ["claude-opus-5-5", "300k"],
  ]) {
    const agent = await platform.createAgent({
      apiKey: "t3-offline-test-key", model: { id, params: [{ id: "context", value: context }] },
      mode: "plan", tools: [], local: { cwd: dir, store, autoReview: false,
        settingSources: [], sandboxOptions: { enabled: false }, enableAgentRetries: false },
    });
    try {
      await agent.send("Reply with exactly: pong");
      throw new Error("SDK did not construct a model request");
    } catch (error) {
      if (error !== captured && error.cause !== captured) throw error;
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
  console.log(JSON.stringify(requests));
  process.exit(0);
}

if (mode === "model-requests") {
  const Parameter = proto3.makeMessageType("agent.v1.ModelParameter", [
    { no: 1, name: "id", kind: "scalar", T: ScalarType.STRING },
    { no: 2, name: "value", kind: "scalar", T: ScalarType.STRING },
  ]);
  const fields = [
    { no: 1, name: "model_id", kind: "scalar", T: ScalarType.STRING },
    { no: 2, name: "max_mode", kind: "scalar", T: ScalarType.BOOL },
    { no: 3, name: "parameters", kind: "message", T: Parameter, repeated: true },
  ];
  const RequestedModel = proto3.makeMessageType("agent.v1.RequestedModel", fields);
  const OtherMessage = proto3.makeMessageType("other.RequestedModel", fields);
  const cases = [
    { modelId: "claude-opus-5-5", context: "1m" },
    { modelId: "grok-4.7", context: "500k" },
    { modelId: "gpt-5.6-sol", context: "1M" },
    { modelId: "claude-opus-5-5", context: "0.5m" },
    { modelId: "claude-opus-5-5", context: "300k" },
    { modelId: "grok-4.7", context: "256k" },
    { modelId: "gpt-5.6-sol", context: "272k" },
    { modelId: "claude-sonnet-4-6", context: "200k" },
    { modelId: "claude-opus-5-5", context: "0.3m" },
    { modelId: "default" },
    { modelId: "custom", context: "unknown" },
    { modelId: "claude-opus-5-5", context: "300k", maxMode: true },
  ];
  const requests = cases.map(({ context, ...selection }) => {
    const source = {
      ...selection,
      parameters: [
        { id: "reasoning_effort", value: "high" },
        ...(context === undefined ? [] : [{ id: "context", value: context }]),
        { id: "fast", value: "true" },
      ],
    };
    const sourceBefore = JSON.stringify(source);
    const request = new RequestedModel(source);
    const decoded = RequestedModel.fromBinary(request.toBinary());
    return {
      maxMode: decoded.maxMode,
      modelId: decoded.modelId,
      parameters: decoded.parameters.map(({ id, value }) => ({ id, value })),
      sourceUnchanged: sourceBefore === JSON.stringify(source),
    };
  });
  const unrelated = new OtherMessage({ parameters: [{ id: "context", value: "1m" }] });
  console.log(JSON.stringify({ requests, unrelatedMaxMode: unrelated.maxMode }));
  process.exit(0);
}

if (mode === "predicate") {
  const cursorShell = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    path: "/bin/zsh",
    spawnargs: ["-c", "dump_zsh_state >&4", "--", "true"],
  });
  const bashShell = Object.assign(new Error("spawn bash ENOENT"), {
    code: "ENOENT",
    syscall: "spawn bash",
    spawnargs: ["-c", "dump_bash_state >&4"],
  });
  const sandboxRestore = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    spawnargs: ["-c", "builtin eval \\"\${__CURSOR_SANDBOX_ENV_RESTORE:-}\\""],
  });
  const gitSpawn = Object.assign(new Error("spawn git ENOENT"), {
    code: "ENOENT",
    syscall: "spawn git",
    path: "git",
    spawnargs: ["status"],
  });
  const plainZsh = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /bin/zsh",
    path: "/bin/zsh",
    spawnargs: ["-lc", "true"],
  });
  console.log(
    JSON.stringify({
      cursorShell: isCursorShellSpawnFailure(cursorShell),
      bashShell: isCursorShellSpawnFailure(bashShell),
      sandboxRestore: isCursorShellSpawnFailure(sandboxRestore),
      gitSpawn: isCursorShellSpawnFailure(gitSpawn),
      plainZsh: isCursorShellSpawnFailure(plainZsh),
      open: isCursorShellSpawnFailure(
        Object.assign(new Error("open failed"), { code: "ENOENT", syscall: "open" }),
      ),
      plain: isCursorShellSpawnFailure(new Error("boom")),
      string: isCursorShellSpawnFailure("spawn ENOENT"),
    }),
  );
  process.exit(0);
}

if (mode === "cursor-shell") {
  const child = spawn("/bin/zsh", ["-c", "dump_zsh_state >&4", "--", "true"], {
    cwd: missingCwd,
  });
  child.on("error", (error) => {
    Promise.reject(error);
  });
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-spawn") {
  Promise.reject(
    Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
      path: "git",
      spawnargs: ["status"],
    }),
  );
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-rejection") {
  Promise.reject(new Error("boom"));
  setTimeout(() => process.exit(0), 500);
} else if (mode === "spawn-without-listener") {
  spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: missingCwd });
  setTimeout(() => process.exit(0), 500);
} else {
  console.error("Unknown cursor shell spawn guard probe: " + mode);
  process.exit(2);
}
`;

function runProbe(mode: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        probeProgram,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe ${mode} timed out`));
    }, 5_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("isCursorShellSpawnFailure", () => {
  it("matches only Cursor's shell wrapper", async () => {
    const result = await runProbe("predicate");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cursorShell: true,
      bashShell: true,
      sandboxRestore: true,
      gitSpawn: false,
      plainZsh: false,
      open: false,
      plain: false,
      string: false,
    });
  });
});

describe("Cursor long-context requests", () => {
  it("sets Max Mode in real SDK sends for the reported context tiers", async () => {
    const result = await runProbe("sdk-model-requests");
    expect(result.code, result.stderr.slice(-2_000)).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { model: "grok-4.7", context: "500k", maxMode: true },
      { model: "grok-4.7", context: "256k", maxMode: false },
      { model: "claude-opus-5-5", context: "1m", maxMode: true },
      { model: "claude-opus-5-5", context: "300k", maxMode: false },
    ]);
  });

  it("serializes Max Mode for long tiers and preserves standard requests", async () => {
    const result = await runProbe("model-requests");
    expect(result.code).toBe(0);
    const { requests, unrelatedMaxMode } = JSON.parse(result.stdout);
    expect(requests.map((request: { maxMode: boolean }) => request.maxMode)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(requests[0]).toEqual({
      maxMode: true,
      modelId: "claude-opus-5-5",
      parameters: [
        { id: "reasoning_effort", value: "high" },
        { id: "context", value: "1m" },
        { id: "fast", value: "true" },
      ],
      sourceUnchanged: true,
    });
    expect(requests.every((request: { sourceUnchanged: boolean }) => request.sourceUnchanged)).toBe(
      true,
    );
    expect(unrelatedMaxMode).toBe(false);
  });
});

describe("Cursor shell spawn guard", () => {
  it("keeps the process alive when Cursor's shell spawn rejects", async () => {
    const result = await runProbe("cursor-shell");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("The server will keep running.");
    expect(result.stderr).toContain("ENOENT");
  });

  it("still exits when a different spawn failure is unhandled", async () => {
    const result = await runProbe("other-spawn");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("spawn git ENOENT");
    expect(result.stderr).not.toContain("The server will keep running.");
  });

  it("still exits on unrelated unhandled rejections", async () => {
    const result = await runProbe("other-rejection");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("leaves a spawn with no error listener fatal", async () => {
    const result = await runProbe("spawn-without-listener");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unhandled");
    expect(result.stderr).not.toContain("The server will keep running.");
  });
});
