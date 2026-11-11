// @effect-diagnostics nodeBuiltinImport:off -- Node filesystem and package installation boundary for trusted host extensions.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";
import {
  ExtensionError,
  ExtensionManifest,
  type ExtensionInfo,
  type ExtensionInvokeInput,
} from "@t3tools/contracts";
import {
  ExtensionProcess,
  ExtensionRequestTimeoutError,
  type ExtensionHostLaunch,
} from "./ExtensionProcess.ts";
import { ExtensionEventLane } from "./ExtensionEventLane.ts";
import { extensionDiagnostic } from "./diagnostic.ts";

const z = NodeModule.createRequire(import.meta.url)("zod") as typeof import("zod");

const decodeActivation = Schema.decodeUnknownSync(
  Schema.Struct({ commands: Schema.Array(Schema.String), tools: Schema.Array(Schema.String) }),
);
const isRequestTimeout = Schema.is(ExtensionRequestTimeoutError);
const decodeManifest = Schema.decodeUnknownSync(ExtensionManifest);
const decodeRegistry = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      manifest: ExtensionManifest,
      source: Schema.String,
      sourceType: Schema.Literals(["local", "npm"]),
      directory: Schema.String,
      enabled: Schema.Boolean,
      settings: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
type Registration = ReturnType<typeof decodeRegistry>[number];
const error = (operation: string, id: string, reason: ExtensionError["reason"], cause?: unknown) =>
  new ExtensionError({
    operation,
    id,
    reason,
    ...(cause === undefined ? {} : { cause, detail: extensionDiagnostic(cause) }),
  });

export class ExtensionRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly processes = new Map<string, ExtensionProcess>();
  private readonly validators = new WeakMap<object, import("zod").ZodType>();
  private readonly eventLanes = new WeakMap<ExtensionProcess, ExtensionEventLane>();
  private readonly states = new Map<
    string,
    Pick<ExtensionInfo, "status" | "diagnostic" | "runtimeId">
  >();
  private mutation: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly lifecycleCancellation = new AbortController();
  private readonly registryPath: string;

  readonly directory: string;
  private readonly options: {
    launch: (signal: AbortSignal) => Promise<ExtensionHostLaunch>;
    platform: NodeJS.Platform;
    installPackage?: (source: string, directory: string, signal: AbortSignal) => Promise<void>;
    hostCall: (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
    changed: (extensions: readonly ExtensionInfo[]) => void;
    event: (id: string, event: unknown) => void;
    log: (id: string, chunk: string) => void;
  };

  constructor(directory: string, options: ExtensionRegistry["options"]) {
    this.directory = directory;
    this.options = options;
    this.registryPath = NodePath.join(directory, "registry.json");
  }

  private exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const next = this.mutation.then(() => {
      if (this.closed) throw error("mutation", "registry", "not-running");
      return operation();
    });
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private changed() {
    this.options.changed(this.list());
  }
  list(): readonly ExtensionInfo[] {
    return [...this.registrations.values()].map(({ directory: _directory, ...entry }) => ({
      ...entry,
      ...(this.states.get(entry.manifest.id) ?? { status: "disabled" as const }),
    }));
  }

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      await NodeFSP.mkdir(this.directory, { recursive: true });
      let raw: string;
      try {
        raw = await NodeFSP.readFile(this.registryPath, "utf8");
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return;
        throw error("load", "registry", "storage-failed", cause);
      }
      let entries: readonly Registration[];
      try {
        entries = decodeRegistry(JSON.parse(raw));
      } catch (cause) {
        throw error("load", "registry", "storage-failed", cause);
      }
      for (const entry of entries) {
        if (this.registrations.has(entry.manifest.id))
          throw error("load", entry.manifest.id, "conflict");
        this.registrations.set(entry.manifest.id, entry);
      }
      for (const entry of entries)
        if (entry.enabled) {
          try {
            const manifest = await this.readManifest(entry.directory);
            if (manifest.id !== entry.manifest.id)
              throw error("load", entry.manifest.id, "invalid-manifest");
            const current = {
              ...entry,
              manifest,
              settings: this.validateSettings(manifest, entry.settings),
            };
            this.registrations.set(manifest.id, current);
            await this.start(current);
          } catch (cause) {
            this.states.set(entry.manifest.id, {
              status: "failed",
              diagnostic: `Could not load extension: ${extensionDiagnostic(cause)}`,
            });
            this.options.log(entry.manifest.id, `Extension load failed: ${String(cause)}\n`);
          }
        }
      this.changed();
    });
  }

  private async persist() {
    const temp = `${this.registryPath}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temp, JSON.stringify([...this.registrations.values()]), {
        mode: 0o600,
      });
      await NodeFSP.rename(temp, this.registryPath);
    } catch (cause) {
      await NodeFSP.rm(temp, { force: true });
      throw error("save", "registry", "storage-failed", cause);
    }
  }

  private async readManifest(directory: string) {
    try {
      const manifest = decodeManifest(
        JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "t3-extension.json"), "utf8")),
      );
      for (const contributions of [
        manifest.commands,
        manifest.tools,
        manifest.panels,
        manifest.statusItems,
        manifest.settingsPages,
      ]) {
        const ids = contributions?.map((entry) => entry.id) ?? [];
        if (new Set(ids).size !== ids.length) throw new Error("Duplicate contribution ids.");
      }
      for (const contribution of [...(manifest.commands ?? []), ...(manifest.tools ?? [])]) {
        if (contribution.inputSchema)
          this.validators.set(contribution, z.fromJSONSchema(contribution.inputSchema));
      }
      for (const setting of Object.values(manifest.settings ?? {})) {
        if (typeof setting.default !== setting.type)
          throw new Error("Setting default does not match its type.");
      }
      for (const page of manifest.settingsPages ?? []) {
        if (page.panelId && !manifest.panels?.some((panel) => panel.id === page.panelId))
          throw new Error("Unknown settings page panel.");
        if (page.settings?.some((key) => !Object.hasOwn(manifest.settings ?? {}, key)))
          throw new Error("Unknown settings page field.");
      }
      for (const item of manifest.statusItems ?? []) {
        if (!manifest.commands?.some((command) => command.id === item.command))
          throw new Error("Unknown status item command.");
      }
      await NodeFSP.access(NodePath.resolve(directory, manifest.main));
      for (const panel of manifest.panels ?? [])
        await NodeFSP.access(NodePath.resolve(directory, panel.entry));
      return manifest;
    } catch (cause) {
      throw error("manifest", directory, "invalid-manifest", cause);
    }
  }

  private async npmPackage(source: string) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+<>=|-]+)?$/.test(source))
      throw error("install", source, "invalid-input");
    const stage = NodePath.join(this.directory, "packages", NodeCrypto.randomUUID());
    await NodeFSP.mkdir(stage, { recursive: true });
    try {
      await NodeFSP.writeFile(
        NodePath.join(stage, "package.json"),
        JSON.stringify({ private: true }),
      );
      if (!this.options.installPackage) throw error("install", source, "install-failed");
      await this.options.installPackage(source, stage, this.lifecycleCancellation.signal);
      const name = source.replace(/@[^@/]+$/, "");
      return { directory: NodePath.join(stage, "node_modules", name), stage };
    } catch (cause) {
      await NodeFSP.rm(stage, { recursive: true, force: true });
      throw error("install", source, "install-failed", cause);
    }
  }

  install(source: string, sourceType: "local" | "npm") {
    return this.exclusive(async () => {
      const installed =
        sourceType === "npm"
          ? await this.npmPackage(source)
          : { directory: await NodeFSP.realpath(source), stage: undefined };
      try {
        const manifest = await this.readManifest(installed.directory);
        if (this.registrations.has(manifest.id)) throw error("install", manifest.id, "conflict");
        const entry: Registration = {
          manifest,
          source: sourceType === "local" ? installed.directory : source,
          sourceType,
          directory: installed.directory,
          enabled: true,
          settings: Object.fromEntries(
            Object.entries(manifest.settings ?? {}).map(([key, setting]) => [key, setting.default]),
          ),
        };
        this.registrations.set(manifest.id, entry);
        try {
          await this.persist();
        } catch (cause) {
          this.registrations.delete(manifest.id);
          throw cause;
        }
        await this.start(entry);
        this.changed();
        return this.list();
      } catch (cause) {
        if (installed.stage) await NodeFSP.rm(installed.stage, { recursive: true, force: true });
        throw cause;
      }
    });
  }

  private async start(entry: Registration) {
    const id = entry.manifest.id;
    this.states.set(id, { status: "starting" });
    this.changed();
    const storagePath = NodePath.join(this.directory, "storage", id);
    let host: ExtensionProcess | undefined;
    try {
      await NodeFSP.mkdir(storagePath, { recursive: true });
      host = new ExtensionProcess({
        cwd: entry.directory,
        launch: await this.options.launch(this.lifecycleCancellation.signal),
        platform: this.options.platform,
        hostCall: this.options.hostCall,
        event: (event) => this.options.event(id, event),
        log: (chunk) => this.options.log(id, chunk),
        failed: () => {
          if (this.processes.get(id) === host) {
            if (host) this.eventLanes.get(host)?.close();
            this.processes.delete(id);
            this.states.set(id, {
              status: "failed",
              diagnostic: "Extension host exited. Reload to restart.",
            });
            this.changed();
          }
        },
      });
      this.processes.set(id, host);
      await host.ready;
      const result = await host.request(
        "activate",
        {
          id,
          entry: NodePath.resolve(entry.directory, entry.manifest.main),
          storagePath,
          settings: entry.settings,
        },
        15_000,
      );
      const registered = decodeActivation(result);
      for (const kind of ["commands", "tools"] as const) {
        const declared = entry.manifest[kind]?.map((item) => item.id) ?? [];
        if (
          declared.length !== registered[kind].length ||
          declared.some((id) => !registered[kind].includes(id))
        )
          throw new Error("Manifest and runtime registrations differ.");
      }
      this.states.set(id, { status: "running", runtimeId: NodeCrypto.randomUUID() });
    } catch (cause) {
      this.options.log(id, `Activation failed: ${String(cause)}\n`);
      await host?.stop();
      this.processes.delete(id);
      this.states.set(id, {
        status: "failed",
        diagnostic: `Activation failed: ${extensionDiagnostic(cause)}`,
      });
    }
    this.changed();
    return this.states.get(id)?.status === "running";
  }

  private get(id: string) {
    const entry = this.registrations.get(id);
    if (!entry) throw error("lookup", id, "not-found");
    return entry;
  }
  private async stop(id: string) {
    const host = this.processes.get(id);
    this.processes.delete(id);
    if (host) {
      this.eventLanes.get(host)?.close();
      await host.stop();
    }
    this.states.set(id, { status: "disabled" });
  }

  private async removePackage(entry: Registration) {
    if (entry.sourceType !== "npm") return;
    const relative = NodePath.relative(NodePath.join(this.directory, "packages"), entry.directory);
    const stage = relative.split(NodePath.sep)[0];
    if (!stage || !/^[0-9a-f-]{36}$/.test(stage)) return;
    await NodeFSP.rm(NodePath.join(this.directory, "packages", stage), {
      recursive: true,
      force: true,
    });
  }

  manage(id: string, action: "enable" | "disable" | "reload" | "update" | "uninstall") {
    return this.exclusive(async () => {
      const previous = this.get(id);
      if (action === "uninstall") {
        this.registrations.delete(id);
        try {
          await this.persist();
        } catch (cause) {
          this.registrations.set(id, previous);
          throw cause;
        }
        await this.stop(id);
        await this.removePackage(previous);
      } else {
        let next = {
          ...previous,
          enabled: action === "enable" ? true : action === "disable" ? false : previous.enabled,
        };
        if (action === "reload" || action === "update") {
          const installed =
            action === "update" && previous.sourceType === "npm"
              ? await this.npmPackage(previous.source)
              : undefined;
          try {
            const directory = installed?.directory ?? previous.directory;
            const manifest = await this.readManifest(directory);
            if (manifest.id !== id) throw error(action, id, "invalid-manifest");
            next = {
              ...next,
              directory,
              manifest,
              settings: this.validateSettings(manifest, previous.settings),
            };
          } catch (cause) {
            if (installed) await NodeFSP.rm(installed.stage, { recursive: true, force: true });
            throw cause;
          }
        }
        this.registrations.set(id, next);
        try {
          await this.persist();
        } catch (cause) {
          this.registrations.set(id, previous);
          if (next.directory !== previous.directory) await this.removePackage(next);
          throw cause;
        }
        await this.stop(id);
        if (next.enabled) {
          const activated = await this.start(next);
          if (!activated && next.directory !== previous.directory) {
            this.registrations.set(id, previous);
            await this.persist();
            if (previous.enabled) await this.start(previous);
            await this.removePackage(next);
            this.changed();
            throw error(action, id, "runtime-failed");
          }
        }
        if (next.directory !== previous.directory) await this.removePackage(previous);
      }
      this.changed();
      return this.list();
    });
  }

  private validateSettings(
    manifest: ExtensionManifest,
    settings: Readonly<Record<string, unknown>>,
  ) {
    const values: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(manifest.settings ?? {})) {
      const value = Object.hasOwn(settings, key) ? settings[key] : definition.default;
      if (
        typeof value !== definition.type ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw error("settings", manifest.id, "invalid-input");
      values[key] = value;
    }
    return values;
  }

  setSettings(id: string, settings: Readonly<Record<string, unknown>>) {
    return this.exclusive(async () => {
      const previous = this.get(id);
      if (Object.keys(settings).some((key) => !(key in (previous.manifest.settings ?? {}))))
        throw error("settings", id, "invalid-input");
      const next = {
        ...previous,
        settings: this.validateSettings(previous.manifest, { ...previous.settings, ...settings }),
      };
      this.registrations.set(id, next);
      try {
        await this.persist();
      } catch (cause) {
        this.registrations.set(id, previous);
        throw cause;
      }
      const host = this.processes.get(id);
      if (host) {
        try {
          await host.request("settings", next.settings);
        } catch {
          await this.stop(id);
          await this.start(next);
        }
      }
      this.changed();
      return this.list();
    });
  }

  async invoke(input: ExtensionInvokeInput) {
    const entry = this.get(input.id);
    const contribution = (
      input.kind === "tool" ? entry.manifest.tools : entry.manifest.commands
    )?.find((item) => item.id === input.name);
    if (!contribution) throw error("invoke", input.id, "not-found");
    if (contribution.inputSchema) {
      const validator =
        this.validators.get(contribution) ?? z.fromJSONSchema(contribution.inputSchema);
      this.validators.set(contribution, validator);
      if (!validator.safeParse(input.input).success)
        throw error("invoke", input.id, "invalid-input");
    }
    const host = this.processes.get(input.id);
    if (!host || this.states.get(input.id)?.status !== "running")
      throw error("invoke", input.id, "not-running");
    try {
      return await host.request("invoke", input);
    } catch (cause) {
      throw error("invoke", input.id, "runtime-failed", cause);
    }
  }

  async panel(id: string, panelId: string, runtimeId?: string) {
    const entry = this.get(id);
    if (this.states.get(id)?.status !== "running") throw error("panel", id, "not-running");
    if (runtimeId && runtimeId !== this.states.get(id)?.runtimeId)
      throw error("panel", id, "not-running");
    const panel = entry.manifest.panels?.find((panel) => panel.id === panelId);
    if (!panel) throw error("panel", id, "not-found");
    return await NodeFSP.readFile(NodePath.resolve(entry.directory, panel.entry), "utf8");
  }

  async publish(event: { type: string; data: unknown }) {
    if (this.closed) return;
    const recipients = [...this.processes.entries()].filter(
      ([id]) =>
        this.states.get(id)?.status === "running" &&
        this.registrations.get(id)?.manifest.events?.includes(event.type),
    );
    if (recipients.length === 0) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    await Promise.all(
      recipients.map(([id, host]) => {
        let lane = this.eventLanes.get(host);
        if (!lane) {
          lane = new ExtensionEventLane({
            maxEvents: 128,
            maxBytes: 2 * 1024 * 1024,
            onError: (cause) => this.options.log(id, `Event handler failed: ${String(cause)}\n`),
            onOverflow: () => {
              this.states.set(id, {
                ...this.states.get(id)!,
                diagnostic:
                  "Event notifications were dropped because this extension could not keep up.",
              });
              this.options.log(
                id,
                "Event delivery backlog exceeded its budget; notifications were dropped.\n",
              );
              this.changed();
            },
          });
          this.eventLanes.set(host, lane);
        }
        return lane.enqueue(bytes, async () => {
          if (this.processes.get(id) !== host) return;
          try {
            await host.request("event", event);
          } catch (cause) {
            if (isRequestTimeout(cause) && this.processes.get(id) === host) {
              this.eventLanes.get(host)?.close();
              this.processes.delete(id);
              this.states.set(id, {
                status: "failed",
                diagnostic: `${cause.message} Reload to restart.`,
              });
              this.changed();
              await host.terminate();
            }
            throw cause;
          }
        });
      }),
    );
  }
  async close() {
    this.closed = true;
    this.lifecycleCancellation.abort();
    await this.mutation;
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }
}
