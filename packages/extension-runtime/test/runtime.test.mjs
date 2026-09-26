import * as NodeChildProcess from "node:child_process";
import { readPackage } from "../dist/storage.js";
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createExtensionRuntime } from "../dist/index.js";

const capability = "t3.workspace/read-text";
const context = {
  resource: {
    namespace: "t3.thread",
    id: "thread-a",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
  workspaceRevision: "revision-a",
  client: "web",
};
const grants = { capabilities: [capability], projectIds: ["project-a"] };
const signal = () => new AbortController().signal;
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tools = ["read", "pid", "crash", "oversize", "hang"];
function descriptor(id = "test.reader") {
  return {
    format: 1,
    manifest: { id, version: "1.0.0", apiVersion: 1, surfaces: [] },
    clientEntry: "client.mjs",
    serverEntry: "server.mjs",
    tools: tools.map((name) => ({
      id: id + "/" + name,
      title: name,
      description: "Fixture " + name,
      readOnly: true,
      capabilities: [capability],
      inputSchema: {
        type: "object",
        properties: { relativePath: { type: "string" } },
        required: ["relativePath"],
        additionalProperties: false,
      },
    })),
  };
}
function server(id = "test.reader") {
  return `export default {tools:[
{id:"${id}/read",invoke:async(input,session)=>session.invoke("${capability}",input)},
{id:"${id}/pid",invoke:()=>process.pid},
{id:"${id}/crash",invoke:()=>process.exit(23)},
{id:"${id}/oversize",invoke:()=>"x".repeat(70000)},
{id:"${id}/hang",invoke:async(input,session)=>{await session.invoke("${capability}",input);return new Promise(()=>{});}}
]};`;
}
async function fixture(t, options = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-extension-runtime-"));
  const source = NodePath.join(directory, "source"),
    root = NodePath.join(directory, "state");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(NodePath.join(source, "t3-extension.json"), JSON.stringify(descriptor()));
  await NodeFSP.writeFile(
    NodePath.join(source, "client.mjs"),
    "export default function(){return {fixture:true}}",
  );
  await NodeFSP.writeFile(NodePath.join(source, "server.mjs"), server());
  await NodeFSP.writeFile(NodePath.join(source, "ignored-secret"), "must not copy");
  const settings = {
    rootDir: root,
    environmentId: "env-a",
    services: [
      {
        capability,
        invoke: async (input) => ({ contents: "real fixture π", relativePath: input.relativePath }),
      },
    ],
    authorize: () => true,
    timeoutMs: 3000,
    ...options,
  };
  const runtime = await createExtensionRuntime(settings);
  t.after(async () => {
    await runtime.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  const invoke = (
    name = "read",
    input = { relativePath: "README.md" },
    ctx = context,
    abortSignal = signal(),
    hash,
  ) => runtime.invoke("test.reader/" + name, input, ctx, abortSignal, hash);
  return { directory, source, root, runtime, settings, invoke };
}

NodeTest.test(
  "copies only declared bytes, persists metadata and executes the compiled worker with scoped host context",
  { timeout: 10000 },
  async (t) => {
    let seen;
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke(input, ctx) {
            seen = ctx;
            ctx.resource.id = "mutated service copy";
            return { contents: "real fixture π", relativePath: input.relativePath };
          },
        },
      ],
    });
    const installed = await f.runtime.install(f.source, grants);
    NodeAssert.equal(installed.id, "test.reader");
    NodeAssert.match(installed.contentHash, /^[a-f0-9]{64}$/);
    NodeAssert.deepEqual(
      (await NodeFSP.readdir(NodePath.join(f.root, "packages", installed.contentHash))).sort(),
      ["client.mjs", "server.mjs", "t3-extension.json"],
    );
    NodeAssert.deepEqual(await f.invoke(), {
      contents: "real fixture π",
      relativePath: "README.md",
    });
    NodeAssert.equal(seen.resource.environmentId, "env-a");
    NodeAssert.equal(context.resource.id, "thread-a");
    const delivered = await f.runtime.readClient(installed.id);
    NodeAssert.equal(delivered.contentHash, installed.contentHash);
    NodeAssert.match(delivered.code, /fixture:true/);
    installed.grants.projectIds.push("foreign");
    NodeAssert.deepEqual(f.runtime.list()[0].grants, grants);
    await f.runtime.dispose();
    const reopened = await createExtensionRuntime(f.settings);
    try {
      NodeAssert.deepEqual(reopened.list()[0].grants, grants);
      NodeAssert.equal(
        (await reopened.invoke("test.reader/pid", { relativePath: "a" }, context, signal())) > 0,
        true,
      );
    } finally {
      await reopened.dispose();
    }
    await NodeAssert.rejects(
      createExtensionRuntime({ ...f.settings, environmentId: "env-b" }),
      /records/,
    );
  },
);

NodeTest.test(
  "default deny, exact environment/project and strict schemas block before host service",
  { timeout: 10000 },
  async (t) => {
    let reads = 0;
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke() {
            reads++;
            return null;
          },
        },
      ],
    });
    await f.runtime.install(f.source);
    await NodeAssert.rejects(f.invoke(), /grants/);
    await f.runtime.remove("test.reader");
    await f.runtime.install(f.source, grants);
    await NodeAssert.rejects(f.invoke("read", { relativePath: "a", extra: true }), /schema/);
    await NodeAssert.rejects(
      f.invoke(
        "read",
        { relativePath: "a" },
        { ...context, resource: { ...context.resource, environmentId: "env-b" } },
      ),
      /grants/,
    );
    await NodeAssert.rejects(
      f.invoke(
        "read",
        { relativePath: "a" },
        { ...context, resource: { ...context.resource, projectId: "project-b" } },
      ),
      /grants/,
    );
    await NodeAssert.rejects(
      f.invoke("read", { relativePath: "a".repeat(70000) }),
      /limit|large|size|bound/i,
    );
    NodeAssert.equal(reads, 0);
  },
);

NodeTest.test(
  "revocation after an actual worker host request rejects its late response",
  { timeout: 10000 },
  async (t) => {
    const started = deferred(),
      finish = deferred();
    let authorized = true;
    const f = await fixture(t, {
      authorize: () => authorized,
      services: [
        {
          capability,
          invoke: async () => {
            started.resolve();
            await finish.promise;
            return "late";
          },
        },
      ],
    });
    await f.runtime.install(f.source, grants);
    const result = f.invoke();
    const rejected = NodeAssert.rejects(result, /denied/);
    await started.promise;
    authorized = false;
    finish.resolve();
    await rejected;
    authorized = true;
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
  },
);

NodeTest.test(
  "disable aborts owned service and pending invocation; enable starts a fresh child",
  { timeout: 10000 },
  async (t) => {
    const started = deferred(),
      finish = deferred(),
      aborted = deferred();
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke: async (_, __, signal) => {
            signal.addEventListener("abort", () => aborted.resolve(), { once: true });
            started.resolve();
            await finish.promise;
            return "late";
          },
        },
      ],
    });
    await f.runtime.install(f.source, grants);
    const firstPid = await f.invoke("pid");
    const pending = f.invoke();
    const rejected = NodeAssert.rejects(pending, /changed/);
    await started.promise;
    await f.runtime.disable("test.reader");
    await rejected;
    await aborted.promise;
    finish.resolve();
    await NodeAssert.rejects(f.invoke("pid"), /disabled/);
    await NodeAssert.rejects(f.runtime.readClient("test.reader"), /disabled/);
    await f.runtime.enable("test.reader");
    NodeAssert.notEqual(await f.invoke("pid"), firstPid);
  },
);

NodeTest.test(
  "external cancellation rejects a real pending child request and preserves its cooperative worker",
  { timeout: 10000 },
  async (t) => {
    const started = deferred(),
      finish = deferred();
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke: async () => {
            started.resolve();
            await finish.promise;
            return "late";
          },
        },
      ],
    });
    await f.runtime.install(f.source, grants);
    const firstPid = await f.invoke("pid");
    const controller = new AbortController();
    const result = f.invoke("read", { relativePath: "a" }, context, controller.signal);
    const rejected = NodeAssert.rejects(result, /cancelled/);
    await started.promise;
    controller.abort();
    await rejected;
    finish.resolve();
    NodeAssert.equal(await f.invoke("pid"), firstPid);
  },
);

NodeTest.test(
  "deadline includes unresolved authorization and does not start a worker afterwards",
  { timeout: 10000 },
  async (t) => {
    const authorization = deferred();
    let calls = 0;
    const f = await fixture(t, {
      timeoutMs: 100,
      authorize: () => {
        calls++;
        return authorization.promise;
      },
    });
    await f.runtime.install(f.source, grants);
    await NodeAssert.rejects(f.invoke("pid"), /deadline/);
    authorization.resolve(true);
    NodeAssert.equal(calls, 1);
  },
);

NodeTest.test(
  "crashed, unresponsive and invalid-result workers fail boundedly and recover",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { timeoutMs: 800 });
    await f.runtime.install(f.source, grants);
    await NodeAssert.rejects(f.invoke("crash"), /exited/);
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
    await NodeAssert.rejects(f.invoke("oversize"), /limit|large|size|bound/i);
    await NodeAssert.rejects(f.invoke("hang"), /deadline/);
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
  },
);

NodeTest.test(
  "bad schema/syntax update is atomic, explicit valid update invalidates the old hash and process",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const old = await f.runtime.install(f.source, grants);
    const pid = await f.invoke("pid");
    const invalid = descriptor();
    invalid.tools[0].inputSchema.unknownKeyword = true;
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(invalid));
    await NodeAssert.rejects(f.runtime.update(old.id, f.source), /strict|unknown/i);
    NodeAssert.equal(await f.invoke("pid"), pid);
    await NodeFSP.writeFile(
      NodePath.join(f.source, "t3-extension.json"),
      JSON.stringify(descriptor()),
    );
    await NodeFSP.writeFile(NodePath.join(f.source, "server.mjs"), "export default { broken");
    await NodeAssert.rejects(f.runtime.update(old.id, f.source), /syntax/);
    NodeAssert.equal(f.runtime.list()[0].contentHash, old.contentHash);
    NodeAssert.equal(await f.invoke("pid"), pid);
    await NodeFSP.writeFile(NodePath.join(f.source, "server.mjs"), server() + "\n// v2");
    const updated = await f.runtime.update(old.id, f.source);
    NodeAssert.notEqual(updated.contentHash, old.contentHash);
    await NodeAssert.rejects(
      f.invoke("pid", { relativePath: "a" }, context, signal(), old.contentHash),
      /content changed/,
    );
    NodeAssert.notEqual(await f.invoke("pid"), pid);
    NodeAssert.deepEqual(updated.grants, old.grants);
  },
);

NodeTest.test(
  "digest tampering blocks client delivery and tool execution",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const installed = await f.runtime.install(f.source, grants);
    const entry = NodePath.join(f.root, "packages", installed.contentHash, "client.mjs");
    await NodeFSP.chmod(entry, 0o600);
    await NodeFSP.writeFile(entry, "export default null");
    await NodeAssert.rejects(f.runtime.readClient(installed.id), /digest/);
    await NodeAssert.rejects(f.invoke(), /digest/);
  },
);

NodeTest.test(
  "symlinked entries, traversal and external schema refs are rejected without executing code",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await NodeFSP.rename(
      NodePath.join(f.source, "server.mjs"),
      NodePath.join(f.source, "real.mjs"),
    );
    await NodeFSP.symlink("real.mjs", NodePath.join(f.source, "server.mjs"));
    await NodeAssert.rejects(f.runtime.install(f.source, grants), /symlink/);
    await NodeFSP.unlink(NodePath.join(f.source, "server.mjs"));
    await NodeFSP.rename(
      NodePath.join(f.source, "real.mjs"),
      NodePath.join(f.source, "server.mjs"),
    );
    const pkg = descriptor();
    pkg.serverEntry = "../server.mjs";
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await NodeAssert.rejects(f.runtime.install(f.source, grants), /relative/);
    pkg.serverEntry = "server.mjs";
    pkg.tools[0].inputSchema = { $ref: "https://example.invalid/schema" };
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await NodeAssert.rejects(f.runtime.install(f.source, grants), /external/);
    NodeAssert.deepEqual(f.runtime.list(), []);
  },
);

NodeTest.test(
  "valid syntax with wrong executable export is rejected before publication and corrected install succeeds",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await NodeFSP.writeFile(NodePath.join(f.source, "server.mjs"), "export default {}");
    await NodeAssert.rejects(f.runtime.install(f.source, grants), /definitions/);
    NodeAssert.deepEqual(f.runtime.list(), []);
    await NodeFSP.writeFile(NodePath.join(f.source, "server.mjs"), server());
    await f.runtime.install(f.source, grants);
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
  },
);

NodeTest.test(
  "the public bundled workspace reader reads actual fixture bytes through the supervised worker",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke: async (input) => {
            const bytes = await NodeFSP.readFile(NodePath.join(f.directory, input.relativePath));
            return {
              relativePath: input.relativePath,
              contents: bytes.toString("utf8"),
              byteLength: bytes.length,
              truncated: false,
            };
          },
        },
      ],
    });
    const bytes = "Installed public package reads π — fixture only\n";
    await NodeFSP.writeFile(NodePath.join(f.directory, "README.md"), bytes);
    const source = new URL(
      "../../extension-sdk/examples/installable-workspace-reader/",
      import.meta.url,
    );
    const installed = await f.runtime.install(source.pathname, grants);
    NodeAssert.equal(installed.id, "example.installed-reader");
    NodeAssert.deepEqual(
      await f.runtime.invoke(
        "example.installed-reader/read",
        { relativePath: "README.md" },
        context,
        signal(),
        installed.contentHash,
      ),
      {
        relativePath: "README.md",
        contents: bytes,
        byteLength: Buffer.byteLength(bytes),
        truncated: false,
      },
    );
  },
);

NodeTest.test(
  "disabling one installation leaves the other borrowed host process untouched",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.runtime.install(f.source, grants);
    const second = NodePath.join(f.directory, "second");
    await NodeFSP.mkdir(second);
    await NodeFSP.writeFile(
      NodePath.join(second, "t3-extension.json"),
      JSON.stringify(descriptor("test.other")),
    );
    await NodeFSP.writeFile(NodePath.join(second, "server.mjs"), server("test.other"));
    await NodeFSP.writeFile(NodePath.join(second, "client.mjs"), "export default null");
    await f.runtime.install(second, grants);
    const pid = await f.runtime.invoke("test.other/pid", { relativePath: "a" }, context, signal());
    await f.invoke("pid");
    await f.runtime.disable("test.reader");
    NodeAssert.equal(
      await f.runtime.invoke("test.other/pid", { relativePath: "a" }, context, signal()),
      pid,
    );
  },
);

NodeTest.test(
  "pure tools require a project grant even without capability requests",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const pkg = descriptor();
    pkg.tools.forEach((tool) => {
      tool.capabilities = [];
    });
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await f.runtime.install(f.source, { projectIds: ["project-a"] });
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
    await NodeAssert.rejects(
      f.invoke(
        "pid",
        { relativePath: "a" },
        { ...context, resource: { ...context.resource, projectId: "project-b" } },
      ),
      /grants/,
    );
    await NodeAssert.rejects(f.invoke(), /not declared/);
  },
);

NodeTest.test(
  "public near-64 KiB and depth-32 JSON survive every real IPC hop",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { services: [{ capability, invoke: (input) => input }] });
    const pkg = descriptor();
    pkg.tools = [{ ...pkg.tools[0], id: "test.reader/echo", inputSchema: { description: "" } }];
    const padding = 65520 - Buffer.byteLength(JSON.stringify(pkg));
    pkg.tools[0].inputSchema.description = "d".repeat(padding);
    NodeAssert.equal(Buffer.byteLength(JSON.stringify(pkg)), 65520);
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await NodeFSP.writeFile(
      NodePath.join(f.source, "server.mjs"),
      'export default {tools:[{id:"test.reader/echo",invoke:(input,session)=>session.invoke("t3.workspace/read-text",input)}]}',
    );
    await f.runtime.install(f.source, grants);
    const near = "x".repeat(65534);
    NodeAssert.equal(await f.invoke("echo", near), near);
    let deep = null;
    for (let i = 0; i < 32; i++) deep = { value: deep };
    NodeAssert.deepEqual(await f.invoke("echo", deep), deep);
    await NodeAssert.rejects(f.invoke("echo", { value: deep }), /nesting/);
  },
);

NodeTest.test(
  "cancelling one overlapping viewer call preserves the other's result and worker identity",
  { timeout: 10000 },
  async (t) => {
    const starts = { one: deferred(), two: deferred() },
      finishes = { one: deferred(), two: deferred() },
      oneAborted = deferred();
    const f = await fixture(t, {
      services: [
        {
          capability,
          invoke: async (input, _, signal) => {
            const name = input.relativePath;
            if (name === "one")
              signal.addEventListener("abort", () => oneAborted.resolve(), { once: true });
            starts[name].resolve();
            await finishes[name].promise;
            return name;
          },
        },
      ],
    });
    await f.runtime.install(f.source, grants);
    const pid = await f.invoke("pid");
    const controller = new AbortController();
    const first = f.invoke("read", { relativePath: "one" }, context, controller.signal);
    const rejected = NodeAssert.rejects(first, /cancelled/);
    const second = f.invoke("read", { relativePath: "two" });
    await Promise.all([starts.one.promise, starts.two.promise]);
    controller.abort();
    await rejected;
    await oneAborted.promise;
    finishes.two.resolve();
    NodeAssert.equal(await second, "two");
    finishes.one.resolve();
    NodeAssert.equal(await f.invoke("pid"), pid);
  },
);

NodeTest.test(
  "129 retired content revisions are pruned without deleting active content, arbitrary directories or symlinks",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const installed = await f.runtime.install(f.source, grants);
    const store = NodePath.join(f.root, "packages");
    for (let revision = 0; revision < 129; revision++) {
      await NodeFSP.writeFile(
        NodePath.join(f.source, "server.mjs"),
        server() + "\n// retired " + revision,
      );
      const snapshot = await readPackage(f.source);
      const directory = NodePath.join(store, snapshot.contentHash);
      await NodeFSP.mkdir(directory);
      for (const [name, bytes] of snapshot.files)
        await NodeFSP.writeFile(NodePath.join(directory, name), bytes);
    }
    const unrelated = NodePath.join(store, "unrelated");
    await NodeFSP.mkdir(unrelated);
    const outside = NodePath.join(f.directory, "outside");
    await NodeFSP.mkdir(outside);
    const linkName = "a".repeat(64);
    await NodeFSP.symlink(outside, NodePath.join(store, linkName));
    await NodeFSP.writeFile(
      NodePath.join(f.source, "server.mjs"),
      server() + "\n// current update",
    );
    const next = await f.runtime.update(installed.id, f.source);
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
    const hashes = async () =>
      (await NodeFSP.readdir(store, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    NodeAssert.deepEqual(await hashes(), [installed.contentHash, next.contentHash].sort());
    await f.runtime.remove(installed.id);
    NodeAssert.deepEqual(await hashes(), [installed.contentHash, next.contentHash].sort());
    // The next mutation prunes both retired snapshots before storing its selected content.
    await f.runtime.install(f.source, grants);
    NodeAssert.deepEqual(await hashes(), [next.contentHash]);
    NodeAssert.ok((await NodeFSP.lstat(NodePath.join(store, linkName))).isSymbolicLink());
    NodeAssert.ok((await NodeFSP.stat(outside)).isDirectory());
    NodeAssert.ok((await NodeFSP.stat(unrelated)).isDirectory());
  },
);

NodeTest.test(
  "new registry metadata and validators switch together while the real old child drains",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const pkg = descriptor();
    for (const tool of pkg.tools)
      tool.inputSchema.properties.relativePath = { const: "old", type: "string" };
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await f.runtime.install(f.source, grants);
    const oldPid = await f.invoke("pid", { relativePath: "old" });
    const drain = deferred();
    const originalEmit = NodeChildProcess.ChildProcess.prototype.emit;
    let release;
    t.mock.method(NodeChildProcess.ChildProcess.prototype, "emit", function (event, ...args) {
      if (this.pid === oldPid && event === "close") {
        release = () => Reflect.apply(originalEmit, this, [event, ...args]);
        drain.resolve();
        return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    for (const tool of pkg.tools)
      tool.inputSchema.properties.relativePath = { const: "new", type: "string" };
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    const updating = f.runtime.update("test.reader", f.source);
    await drain.promise;
    try {
      NodeAssert.equal(typeof (await f.invoke("pid", { relativePath: "new" })), "number");
      await NodeAssert.rejects(f.invoke("pid", { relativePath: "old" }), /schema/);
    } finally {
      release();
      await updating;
    }
  },
);

NodeTest.test(
  "declared ESM .js entries work below a CommonJS ancestor without changing copied package identity",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await NodeFSP.writeFile(
      NodePath.join(f.directory, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    const pkg = descriptor();
    pkg.clientEntry = "client.js";
    pkg.serverEntry = "server.js";
    await NodeFSP.writeFile(NodePath.join(f.source, "t3-extension.json"), JSON.stringify(pkg));
    await NodeFSP.rename(
      NodePath.join(f.source, "client.mjs"),
      NodePath.join(f.source, "client.js"),
    );
    await NodeFSP.rename(
      NodePath.join(f.source, "server.mjs"),
      NodePath.join(f.source, "server.js"),
    );
    const before = await readPackage(f.source);
    const installed = await f.runtime.install(f.source, grants);
    NodeAssert.equal(installed.contentHash, before.contentHash);
    const delivered = await f.runtime.readClient(installed.id);
    NodeAssert.equal(delivered.code, before.files.get("client.js").toString("utf8"));
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
    NodeAssert.deepEqual(
      (await NodeFSP.readdir(NodePath.join(f.root, "packages", installed.contentHash))).sort(),
      ["client.js", "server.js", "t3-extension.json"],
    );
    await f.runtime.dispose();
    await NodeFSP.unlink(NodePath.join(f.root, "packages", "package.json"));
    const reopened = await createExtensionRuntime(f.settings);
    try {
      NodeAssert.equal(
        typeof (await reopened.invoke("test.reader/pid", { relativePath: "a" }, context, signal())),
        "number",
      );
    } finally {
      await reopened.dispose();
    }
  },
);

NodeTest.test(
  "a conflicting or symlinked module-scope file is rejected without overwrite",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.runtime.install(f.source, grants);
    const metadata = NodePath.join(f.root, "packages", "package.json");
    await NodeFSP.chmod(metadata, 0o600);
    const foreign = '{"type":"commonjs","private":true}\n';
    await NodeFSP.writeFile(metadata, foreign);
    await NodeAssert.rejects(f.invoke(), /module scope/);
    await NodeAssert.rejects(f.runtime.readClient("test.reader"), /module scope/);
    await f.runtime.dispose();
    await NodeAssert.rejects(createExtensionRuntime(f.settings), /module scope/);
    NodeAssert.equal(await NodeFSP.readFile(metadata, "utf8"), foreign);
    await NodeFSP.unlink(metadata);
    const outside = NodePath.join(f.directory, "outside-package.json");
    await NodeFSP.writeFile(outside, '{"type":"module"}\n');
    await NodeFSP.symlink(outside, metadata);
    await NodeAssert.rejects(createExtensionRuntime(f.settings), /symlink/);
    NodeAssert.ok((await NodeFSP.lstat(metadata)).isSymbolicLink());
    NodeAssert.equal(await NodeFSP.readFile(outside, "utf8"), '{"type":"module"}\n');
    NodeAssert.equal(
      (await NodeFSP.readdir(NodePath.dirname(metadata))).some((name) =>
        name.startsWith(".module-"),
      ),
      false,
    );
  },
);

NodeTest.test(
  "V1 worker recovery publishes a catalogue receipt after its failure receipt",
  async (t) => {
    const receipts = [];
    let currentCatalogue = () => null;
    const f = await fixture(t, { onCatalogueChanged: () => receipts.push(currentCatalogue()) });
    currentCatalogue = () => f.runtime.catalogue();
    await f.runtime.install(f.source, grants);
    receipts.length = 0;
    await NodeAssert.rejects(f.invoke("crash"), /exited/);
    NodeAssert.equal(
      receipts.at(-1).pluginResolution.find((item) => item.id === "test.reader").status,
      "unavailable",
    );
    const afterFailure = receipts.length;
    NodeAssert.equal(typeof (await f.invoke("pid")), "number");
    NodeAssert.ok(receipts.length > afterFailure);
    NodeAssert.equal(
      receipts.at(-1).pluginResolution.find((item) => item.id === "test.reader").status,
      "available",
    );
  },
);
