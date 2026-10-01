import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
const sdk = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const root = NodePath.resolve(sdk, "../..");
const artifact = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-extension-consumer-"));
const consumer = NodePath.join(artifact, "consumer");
NodeFS.cpSync(NodePath.join(sdk, "examples/counter"), consumer, { recursive: true });
function run(command, args, cwd) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true", NODE_OPTIONS: "--max-old-space-size=4096" },
  });
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}: ${result.error ?? ""}`);
}
run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifact], sdk);
const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(consumer, "package.json"), "utf8"));
pkg.dependencies["@t3tools/extension-sdk"] =
  `file:${NodePath.join(artifact, "t3tools-extension-sdk-0.1.0.tgz")}`;
NodeFS.writeFileSync(NodePath.join(consumer, "package.json"), JSON.stringify(pkg, null, 2));
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);

NodeFS.copyFileSync(
  NodePath.join(sdk, "test/packaged-authoring.mjs"),
  NodePath.join(consumer, "packaged-capabilities.mjs"),
);
run(process.execPath, ["packaged-capabilities.mjs"], consumer);

const installedExample = NodePath.join(
  consumer,
  "node_modules/@t3tools/extension-sdk/examples/counter/counter.ts",
);
NodeFS.copyFileSync(installedExample, NodePath.join(consumer, "packaged-counter.ts"));
NodeFS.writeFileSync(
  NodePath.join(consumer, "capabilities.ts"),
  `
import type { ClientHost } from "@t3tools/extension-sdk/environment";
export async function checkPublicAsset(host: ClientHost) {
  if (!host.readAsset) return;
  const loaded = await host.readAsset("assets/value.wasm", new AbortController().signal);
  const bytes: Uint8Array = loaded.bytes;
  void bytes;
  // @ts-expect-error owner, environment and installation hash are selected by the host
  await host.readAsset({ id: "other", path: "assets/value.wasm" }, new AbortController().signal);
}
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import { workspaceFilesApi, terminalSessionsApi, terminalOutputApi, terminalOutputEventsApi } from "@t3tools/extension-sdk/catalogue";
const context = { resource: { namespace: "thirdparty.files", id: "root", environmentId: "env" }, client: "test" };
const api = bindApi(workspaceFilesApi, { async invokeApi() { return { entries: [], nextCursor: null }; } }, context);
const result = await api.invoke("listEntries", { relativePath: "" }, new AbortController().signal);
const kind: "file" | "directory" | undefined = result.entries[0]?.kind;
void kind;
const terminal = bindApi(terminalSessionsApi, { async invokeApi() { return null; } }, context);
const observed = await terminal.invoke("inspect", { terminalId: "term-1" }, new AbortController().signal);
const terminalState: "starting" | "running" | "exited" | "error" | undefined = observed?.status;
void terminalState;
const output = bindApi(terminalOutputApi, { async invokeApi() { return null; } }, context);
const tail = await output.invoke("readSnapshot", { terminalId: "term-1" }, new AbortController().signal);
const retainedBytes: number | undefined = tail?.retainedByteLength;
const omittedPrefix: boolean | undefined = tail?.truncated;
void retainedBytes; void omittedPrefix;
// @ts-expect-error read snapshots do not expose terminal process control
void output.invoke("restart", { terminalId: "term-1" }, new AbortController().signal);
// @ts-expect-error snapshot size/launch paths are host policy
void output.invoke("readSnapshot", { terminalId: "term-1", cwd: "/other", limit: 1000000 }, new AbortController().signal);


import { bindStreamApi, defineStreamApi } from "@t3tools/extension-sdk/capabilities";
const typedStream = defineStreamApi<{ changes: { input: { terminalId: string }; event: { kind: "output"; data: string } } }>({
  id: "thirdparty.files/events", version: "1.0.0", methods: [],
  streams: [{ name: "changes", inputSchema: { type: "object" }, eventSchema: { type: "object" }, requiredGrants: [] }],
});
const streams = bindStreamApi(typedStream, { async *subscribeApi() {
  yield { type: "data", streamId: "test", sequence: 1, value: { kind: "output", data: "text" } };
} }, context);
for await (const frame of streams.subscribe("changes", { terminalId: "term-1" }, new AbortController().signal)) {
  const content: string = frame.value.data;
  const kind: "output" = frame.value.kind;
  void content; void kind;
  // @ts-expect-error private fields are not part of the public event
  void frame.value.pid;
}
const terminalEvents = bindStreamApi(terminalOutputEventsApi, { async *subscribeApi() {} }, context);
for await (const frame of terminalEvents.subscribe("subscribe", { terminalId: "term-1" }, new AbortController().signal)) {
  if (frame.value.kind === "output") {
    const rawOutput: string = frame.value.data;
    const chunk: number = frame.value.chunkIndex;
    void rawOutput; void chunk;
  }
}
// @ts-expect-error terminal launch options are not stream selectors
void terminalEvents.subscribe("subscribe", { terminalId: "term-1", cwd: "/other" }, new AbortController().signal);

// @ts-expect-error stream name is checked
void streams.subscribe("privateEvents", { terminalId: "term-1" }, new AbortController().signal);
// @ts-expect-error stream input is checked
void streams.subscribe("changes", { cwd: "/other" }, new AbortController().signal);
// @ts-expect-error stream bindings never accept caller-selected context or API owner
void streams.subscribe("changes", { terminalId: "term-1" }, new AbortController().signal, { context, id: "other" });

// @ts-expect-error terminal observation does not authorize process control
void terminal.invoke("write", { terminalId: "term-1", data: "exit" }, new AbortController().signal);
// @ts-expect-error native cwd is not a public terminal selector
void terminal.invoke("inspect", { terminalId: "term-1", cwd: "/other" }, new AbortController().signal);
// @ts-expect-error unknown method is rejected by public typed binding
void api.invoke("privateStore", {}, new AbortController().signal);
// @ts-expect-error required public input cannot be omitted
void api.invoke("readText", {}, new AbortController().signal);
`,
);
const configPath = NodePath.join(consumer, "tsconfig.json");
const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
config.include.push("packaged-counter.ts", "capabilities.ts");
NodeFS.writeFileSync(configPath, JSON.stringify(config, null, 2));
run(
  process.env.T3_EXTENSION_TSC ?? NodePath.join(root, "node_modules/.bin/tsc"),
  ["-p", "tsconfig.json"],
  consumer,
);
run(process.execPath, ["--test", "consumer.test.mjs"], consumer);
console.log(`External consumer artifact: ${artifact}`);
