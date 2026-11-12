import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExtensionError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess integration fixtures exercise the real unsandboxed host.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ExtensionProcess } from "./ExtensionProcess.ts";
import { ExtensionRegistry } from "./ExtensionRegistry.ts";

const encodeExtensionError = Schema.encodeUnknownSync(Schema.toCodecJson(ExtensionError));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

it.live(
  "persists lifecycle and settings, runs tools in a host process, and contains activation failures",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      yield* Effect.promise(async () => {
        const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-extension-"));
        const source = NodePath.join(directory, "example");
        await NodeFSP.mkdir(source);
        const manifest = {
          id: "test.example",
          name: "Example",
          description: "Test extension",
          version: "1.0.0",
          apiVersion: 1,
          main: "extension.mjs",
          commands: [
            { id: "echo", title: "Echo", description: "Echo input" },
            { id: "crash", title: "Crash", description: "Crash the fixture" },
          ],
          events: ["test.event"],
          tools: [{ id: "host", description: "Read host state", inputSchema: { type: "object" } }],
          panels: [{ id: "main", title: "Example", entry: "panel.html" }],
          settings: {
            greeting: {
              title: "Greeting",
              description: "Greeting text",
              type: "string",
              default: "hello",
            },
          },
        };
        await NodeFSP.writeFile(
          NodePath.join(source, "t3-extension.json"),
          JSON.stringify(manifest),
        );
        await NodeFSP.writeFile(NodePath.join(source, "panel.html"), "<h1>Example</h1>");
        await NodeFSP.writeFile(
          NodePath.join(source, "extension.mjs"),
          `export default {activate(context) {
    let received = 0;
    context.onEvent(async ({data}) => {if (data.hang) await new Promise(() => {}); received++;});
    context.registerCommand('crash', () => {process.exit(13);});
    context.registerCommand('echo', (input) => {if (input?.hang) while (true) {} return {input, greeting: context.settings.greeting, received};});
    context.registerTool('host', async () => ({pid: process.pid, value: await context.callT3('test', {})}));
  }};`,
        );
        const logs: string[] = [];
        const options = {
          platform: platform,
          launch: async () => ({
            command: process.execPath,
            args: [NodeURL.fileURLToPath(new URL("./hostMain.ts", import.meta.url))],
          }),
          hostCall: async () => "host-value",
          changed: () => {},
          event: () => {},
          log: (_id: string, chunk: string) => {
            logs.push(chunk);
          },
        };
        const registry = new ExtensionRegistry(NodePath.join(directory, "extensions"), options);
        let restored: ExtensionRegistry | undefined;
        try {
          await registry.initialize();
          const installed = await registry.install(source, "local");
          expect(installed[0]?.status).toBe("running");
          await expect(registry.install(source, "local")).rejects.toMatchObject({
            reason: "conflict",
          });
          expect(
            await registry.invoke({
              id: manifest.id,
              kind: "command",
              name: "echo",
              input: { text: "works" },
            }),
          ).toEqual({ input: { text: "works" }, greeting: "hello", received: 0 });
          const host = await registry.invoke({
            id: manifest.id,
            kind: "tool",
            name: "host",
            input: {},
          });
          expect(host).toMatchObject({ value: "host-value" });
          expect((host as { pid: number }).pid).not.toBe(process.pid);
          expect(await registry.panel(manifest.id, "main")).toBe("<h1>Example</h1>");
          await expect(
            registry.setSettings(manifest.id, { greeting: false }),
          ).rejects.toMatchObject({
            reason: "invalid-input",
          });
          await registry.setSettings(manifest.id, { greeting: "changed" });
          await registry.setSettings(manifest.id, {});
          expect(
            await registry.invoke({ id: manifest.id, kind: "command", name: "echo", input: null }),
          ).toEqual({ input: null, greeting: "changed", received: 0 });
          await expect(
            registry.invoke({ id: manifest.id, kind: "tool", name: "host", input: null }),
          ).rejects.toMatchObject({ reason: "invalid-input" });
          await registry.publish({ type: "ignored", data: {} });
          await registry.publish({ type: "test.event", data: {} });
          expect(
            await registry.invoke({ id: manifest.id, kind: "command", name: "echo", input: null }),
          ).toMatchObject({ received: 1 });
          {
            const request = ExtensionProcess.prototype.request;
            using eventRequests = vi
              .spyOn(ExtensionProcess.prototype, "request")
              .mockImplementation(function (this: ExtensionProcess, operation, payload, timeout) {
                return request.call(
                  this,
                  operation,
                  payload,
                  operation === "event" ? 100 : timeout,
                );
              });
            await Promise.all([
              registry.publish({ type: "test.event", data: { hang: true } }),
              registry.publish({ type: "test.event", data: {} }),
            ]);
            expect(registry.list()[0]).toMatchObject({
              status: "failed",
              diagnostic: expect.stringContaining("timed out"),
            });
            expect(
              eventRequests.mock.calls.filter(([operation]) => operation === "event"),
            ).toHaveLength(1);
          }
          await registry.manage(manifest.id, "reload");
          {
            const request = ExtensionProcess.prototype.request;
            using _invocations = vi
              .spyOn(ExtensionProcess.prototype, "request")
              .mockImplementation(function (this: ExtensionProcess, operation, payload, timeout) {
                return request.call(
                  this,
                  operation,
                  payload,
                  operation === "invoke" ? 100 : timeout,
                );
              });
            await expect(
              registry.invoke({
                id: manifest.id,
                kind: "command",
                name: "echo",
                input: { hang: true },
              }),
            ).rejects.toMatchObject({ reason: "runtime-failed" });
            expect(registry.list()[0]).toMatchObject({
              status: "failed",
              diagnostic: expect.stringContaining("timed out"),
            });
            await expect(
              registry.invoke({ id: manifest.id, kind: "command", name: "echo", input: null }),
            ).rejects.toMatchObject({ reason: "not-running" });
          }
          await registry.manage(manifest.id, "reload");
          await expect(
            registry.invoke({ id: manifest.id, kind: "command", name: "crash", input: null }),
          ).rejects.toMatchObject({ reason: "runtime-failed" });
          expect(registry.list()[0]?.status).toBe("failed");
          await registry.manage(manifest.id, "reload");
          expect(registry.list()[0]?.status).toBe("running");
          await registry.manage(manifest.id, "disable");
          await expect(
            registry.invoke({ id: manifest.id, kind: "command", name: "echo", input: null }),
          ).rejects.toMatchObject({ reason: "not-running" });
          await registry.close();
          restored = new ExtensionRegistry(NodePath.join(directory, "extensions"), options);
          await restored.initialize();
          expect(restored.list()[0]).toMatchObject({
            enabled: false,
            settings: { greeting: "changed" },
          });
          await restored.manage(manifest.id, "enable");
          expect(restored.list()[0]?.status).toBe("running");
          await NodeFSP.writeFile(
            NodePath.join(source, "extension.mjs"),
            "export default {activate(){throw new Error('fixture-credential=secret-activation-value')}};",
          );
          await restored.manage(manifest.id, "reload");
          expect(restored.list()[0]?.status).toBe("failed");
          expect(JSON.stringify(restored.list())).not.toContain("secret-activation-value");
          expect(logs.join("")).toContain("secret-activation-value");
          await restored.close();
          await NodeFSP.writeFile(
            NodePath.join(source, "t3-extension.json"),
            JSON.stringify({ ...manifest, main: "fixture-credential=secret-load-value.mjs" }),
          );
          restored = new ExtensionRegistry(NodePath.join(directory, "extensions"), options);
          await restored.initialize();
          expect(restored.list()[0]?.status).toBe("failed");
          expect(restored.list()[0]?.diagnostic).toBe(
            "Could not load extension. Check the server logs.",
          );
          expect(JSON.stringify(restored.list())).not.toContain("secret-load-value");
          expect(logs.join("")).toContain("secret-load-value");
          await restored.manage(manifest.id, "uninstall");
          expect(restored.list()).toEqual([]);
          expect(await NodeFSP.readFile(NodePath.join(source, "panel.html"), "utf8")).toContain(
            "Example",
          );
          await NodeFSP.writeFile(
            NodePath.join(source, "t3-extension.json"),
            JSON.stringify({ ...manifest, apiVersion: 99 }),
          );
          const invalid = await restored.install(source, "local").catch((cause: unknown) => cause);
          expect(invalid).toBeInstanceOf(ExtensionError);
          const encoded = encodeExtensionError(invalid);
          expect(encoded).toMatchObject({ reason: "invalid-manifest" });
          expect(encoded).not.toHaveProperty("cause");
          expect(encoded).not.toHaveProperty("detail");
        } finally {
          await restored?.close();
          await registry.close();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      });
    }),
);

it.live("updates managed packages transactionally and removes only their owned installation", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-extension-npm-"));
      let version = "1.0.0";
      let invalid = false;
      let broken = false;
      const registry = new ExtensionRegistry(directory, {
        platform: platform,
        launch: async () => ({
          command: process.execPath,
          args: [NodeURL.fileURLToPath(new URL("./hostMain.ts", import.meta.url))],
        }),
        hostCall: async () => null,
        changed: () => {},
        event: () => {},
        log: () => {},
        installPackage: async (_source, stage) => {
          const destination = NodePath.join(stage, "node_modules", "test-extension");
          await NodeFSP.mkdir(destination, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(destination, "t3-extension.json"),
            JSON.stringify({
              id: invalid ? "wrong.id" : "test.package",
              name: "Package",
              version,
              apiVersion: 1,
              description: "Package test",
              main: "main.mjs",
              commands: [
                {
                  id: "version",
                  title: "Version",
                  description: "Generation",
                  inputSchema: {
                    type: "object",
                    properties: { generation: { const: version } },
                    required: ["generation"],
                  },
                },
              ],
              panels: [{ id: "version", title: "Version", entry: "panel.html" }],
            }),
          );
          await NodeFSP.writeFile(
            NodePath.join(destination, "main.mjs"),
            broken
              ? "export default {activate(){throw new Error('broken update')}};"
              : `export default {activate(context){context.registerCommand('version',()=>${JSON.stringify(version)});}};`,
          );
          await NodeFSP.writeFile(NodePath.join(destination, "panel.html"), version);
        },
      });
      try {
        await registry.initialize();
        await registry.install("test-extension@latest", "npm");
        expect(registry.list()[0]).toMatchObject({
          status: "running",
          manifest: { version: "1.0.0" },
        });
        invalid = true;
        await expect(registry.manage("test.package", "update")).rejects.toMatchObject({
          reason: "invalid-manifest",
        });
        expect(registry.list()[0]).toMatchObject({
          status: "running",
          manifest: { version: "1.0.0" },
        });
        expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toHaveLength(1);
        invalid = false;
        broken = true;
        await expect(registry.manage("test.package", "update")).rejects.toMatchObject({
          reason: "runtime-failed",
        });
        expect(registry.list()[0]).toMatchObject({
          status: "running",
          manifest: { version: "1.0.0" },
        });
        expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toHaveLength(1);
        broken = false;
        version = "1.1.0";
        const previousRuntime = registry.list()[0]?.runtimeId;
        {
          using _failure = vi
            .spyOn(NodeFSP, "rename")
            .mockRejectedValueOnce(new Error("disk failure"));
          await expect(registry.manage("test.package", "update")).rejects.toMatchObject({
            reason: "storage-failed",
          });
          expect(registry.list()[0]).toMatchObject({
            status: "running",
            runtimeId: previousRuntime,
            manifest: { version: "1.0.0" },
          });
          expect(
            await registry.invoke({
              id: "test.package",
              kind: "command",
              name: "version",
              input: { generation: "1.0.0" },
            }),
          ).toBe("1.0.0");
          expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toHaveLength(1);
        }

        const persisting = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        using _persistence = vi
          .spyOn(NodeFSP, "rename")
          .mockImplementationOnce(async (from, to) => {
            persisting.resolve();
            await resume.promise;
            const original =
              await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            return original.rename(from, to);
          });
        const updating = registry.manage("test.package", "update");
        try {
          await persisting.promise;
          const [command, panel] = await Promise.allSettled([
            registry.invoke({
              id: "test.package",
              kind: "command",
              name: "version",
              input: { generation: "1.0.0" },
            }),
            registry.panel("test.package", "version", previousRuntime),
          ]);
          expect({ version: registry.list()[0]?.manifest.version, command, panel }).toMatchObject({
            version: "1.0.0",
            command: { status: "fulfilled", value: "1.0.0" },
            panel: { status: "fulfilled", value: "1.0.0" },
          });
        } finally {
          resume.resolve();
          await updating;
        }
        expect(
          await registry.invoke({
            id: "test.package",
            kind: "command",
            name: "version",
            input: { generation: "1.1.0" },
          }),
        ).toBe("1.1.0");
        await expect(
          registry.panel("test.package", "version", previousRuntime),
        ).rejects.toMatchObject({ reason: "not-running" });
        expect(registry.list()[0]).toMatchObject({
          status: "running",
          manifest: { version: "1.1.0" },
        });
        expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toHaveLength(1);
        await registry.manage("test.package", "uninstall");
        expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toEqual([]);
        await registry.install("test-extension@latest", "npm");
        const previous = registry.list()[0];
        broken = true;
        version = "1.2.0";
        {
          const original =
            await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
          using _rollback = vi
            .spyOn(NodeFSP, "rename")
            .mockImplementationOnce(original.rename)
            .mockRejectedValueOnce(new Error("rollback disk failure"));
          await expect(registry.manage("test.package", "update")).rejects.toMatchObject({
            reason: "storage-failed",
          });
          expect(registry.list()[0]).toMatchObject({
            status: "running",
            manifest: { version: previous?.manifest.version },
          });
          expect(
            await registry.invoke({
              id: "test.package",
              kind: "command",
              name: "version",
              input: { generation: "1.1.0" },
            }),
          ).toBe("1.1.0");
          const persisted = JSON.parse(
            await NodeFSP.readFile(NodePath.join(directory, "registry.json"), "utf8"),
          );
          expect(persisted[0].manifest.version).toBe("1.2.0");
          expect(
            await NodeFSP.readFile(NodePath.join(persisted[0].directory, "main.mjs"), "utf8"),
          ).toContain("broken update");
          expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toHaveLength(2);
        }
      } finally {
        await registry.close();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  }),
);

it.live("cancels an in-progress package installation before waiting for shutdown", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-extension-close-"),
      );
      const started = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const registry = new ExtensionRegistry(directory, {
        platform,
        launch: async () => ({
          command: process.execPath,
          args: [NodeURL.fileURLToPath(new URL("./hostMain.ts", import.meta.url))],
        }),
        hostCall: async () => null,
        changed: () => {},
        event: () => {},
        log: () => {},
        installPackage: async (_source, _directory, signal = new AbortController().signal) => {
          started.resolve(signal);
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("installation cancelled")), {
              once: true,
            });
            void release.promise.then(resolve);
          });
        },
      });
      const installed = registry
        .initialize()
        .then(() => registry.install("test-extension", "npm"))
        .then(
          () => "installed",
          () => "failed",
        );
      try {
        const signal = await started.promise;
        const closing = registry.close();
        expect(signal.aborted).toBe(true);
        await closing;
        expect(await installed).toBe("failed");
        expect(await NodeFSP.readdir(NodePath.join(directory, "packages"))).toEqual([]);
      } finally {
        release.resolve();
        await installed;
        await registry.close();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  }),
);
