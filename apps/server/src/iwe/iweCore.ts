// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off extendsNativeError:off - Plain-TypeScript IWE core (CLI subprocesses, files, GitHub downloads); IweService wraps it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  IweBinary,
  IweLink,
  IweNote,
  IweNoteActivity,
  IweNoteSummary,
  IweSetupStep,
  IweThreadState,
  IweToolStatus,
  IweWorkspaceInfo,
  ThreadId,
} from "@t3tools/contracts";

import { downloadResumable, exists, writeJsonAtomic } from "../gameDev/gameDevFiles.ts";
import { IweLanguageServer } from "./iweLanguageServer.ts";

export class IweFailure extends Error {}
const fail = (message: string): never => {
  throw new IweFailure(message);
};

export interface IweHost {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const RELEASES_API = "https://api.github.com/repos/iwe-org/iwe/releases/latest";
const ACTIVITY_LIMIT = 60;

/** The prebuilt release archive for this OS. musl builds also run on NixOS without patching. */
export function iweReleaseAsset(platform: string, arch: string): string | null {
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-musl.tar.gz" : arch === "x64" ? "x86_64-unknown-linux-musl.tar.gz" : null;
  if (platform === "darwin") return "universal-apple-darwin.tar.gz";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc.zip";
  return null;
}

export function iweSetupSteps(platform: string, distroId: string | null): IweSetupStep[] {
  const npm: IweSetupStep = { title: "npm (any OS, including Windows)", commands: ["npm install -g @iwe-org/iwe"], note: "Installs iwe, iwes, and iwec." };
  const cargo: IweSetupStep = { title: "Cargo", commands: ["cargo install iwe iwes iwec"], note: "Builds from source; add ~/.cargo/bin to PATH." };
  const brew: IweSetupStep = { title: "Homebrew", commands: ["brew install iwe-org/iwe/iwe"], note: "Installs iwe, iwes, and iwec." };
  if (platform === "linux" && distroId === "nixos") {
    return [
      { title: "NixOS", commands: ["nix profile add nixpkgs#iwe"], note: "Or add pkgs.iwe to environment.systemPackages. nixpkgs can trail the newest IWE release by a version." },
      npm,
      cargo,
    ];
  }
  if (platform === "win32") return [npm, cargo];
  return [brew, npm, cargo];
}

/** `[workspace] path` and the link settings, read without rewriting the file. */
export function parseIweConfig(text: string): { readonly workspacePath: string; readonly linkFormat: string; readonly refsExtension: string } {
  let section = "";
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const pair = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (pair) values.set(`${section}.${pair[1]}`, pair[2]!);
  }
  return {
    workspacePath: values.get("workspace.path") ?? "",
    linkFormat: values.get("completion.link_format") ?? "markdown",
    refsExtension: values.get("markdown.refs_extension") ?? "",
  };
}

/** The workspace root: `path` itself or the nearest parent with `.iwe/config.toml`. */
export async function findWorkspaceRoot(path: string): Promise<string | null> {
  let current = NodePath.resolve(path);
  for (;;) {
    if (await exists(NodePath.join(current, ".iwe", "config.toml"))) return current;
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function countMarkdown(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await NodeFSP.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  };
  await walk(dir);
  return found;
}

function runWithInput(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  input: string | null,
  timeoutMs = 60_000,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = NodeChildProcess.spawn(command, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? undefined);
  });
}

interface RawSummary {
  readonly key: string;
  readonly title: string;
  readonly content?: string;
  readonly references?: ReadonlyArray<IweLink>;
  readonly includes?: ReadonlyArray<IweLink>;
  readonly referencedBy?: ReadonlyArray<IweLink>;
  readonly includedBy?: ReadonlyArray<IweLink>;
}

const links = (value: ReadonlyArray<IweLink> | undefined): IweLink[] =>
  (value ?? []).map((link) => ({ key: link.key, title: link.title }));

const summaryOf = (raw: RawSummary): IweNoteSummary => ({
  key: raw.key,
  title: raw.title,
  references: links(raw.references),
  includes: links(raw.includes),
  referencedBy: links(raw.referencedBy),
  includedBy: links(raw.includedBy),
});

interface ThreadRecord {
  workspaceRoot: string | null;
  attachments: Array<{ key: string; title: string; depth: number; root: string }>;
  activity: IweNoteActivity[];
}

export class IweCore {
  readonly #host: IweHost;
  readonly #servers = new Map<string, IweLanguageServer>();
  readonly #threads = new Map<string, ThreadRecord>();
  #distroId: string | null = null;

  private constructor(host: IweHost) {
    this.#host = host;
  }

  static async start(host: IweHost): Promise<IweCore> {
    const core = new IweCore(host);
    if (host.platform === "linux") {
      const release = await NodeFSP.readFile("/etc/os-release", "utf8").catch(() => "");
      core.#distroId = /^ID=("?)([^"\n]+)\1$/m.exec(release)?.[2] ?? null;
    }
    const stored = await NodeFSP.readFile(core.#statePath, "utf8").catch(() => null);
    if (stored) {
      const parsed = JSON.parse(stored) as { threads?: Record<string, ThreadRecord> };
      for (const [threadId, record] of Object.entries(parsed.threads ?? {})) core.#threads.set(threadId, record);
    }
    return core;
  }

  get #statePath() {
    return NodePath.join(this.#host.stateDir, "iwe-threads.json");
  }

  #saving: Promise<void> = Promise.resolve();

  /** Saves run one after another, so the file always holds the latest state. */
  #save(): Promise<void> {
    this.#saving = this.#saving
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.#statePath, { version: 1, threads: Object.fromEntries(this.#threads) }));
    return this.#saving;
  }

  stop() {
    for (const server of this.#servers.values()) server.dispose();
    this.#servers.clear();
  }


  readonly #located = new Map<string, { readonly at: number; readonly value: IweBinary | null }>();

  async #locate(name: string): Promise<IweBinary | null> {
    const cached = this.#located.get(name);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = await this.#find(name);
    this.#located.set(name, { at: Date.now(), value });
    return value;
  }

  async #find(name: string): Promise<IweBinary | null> {
    const exe = this.#host.platform === "win32" ? `${name}.exe` : name;
    const managed = NodePath.join(this.#host.baseDir, "tools", "iwe", "current", exe);
    if (await exists(managed)) return { path: managed, version: await this.#version(managed), source: "managed" };
    const home = NodeOS.homedir();
    const dirs = [
      ...(this.#host.env.PATH ?? this.#host.env.Path ?? "").split(this.#host.platform === "win32" ? ";" : ":"),
      NodePath.join(home, ".cargo", "bin"),
      NodePath.join(home, ".nix-profile", "bin"),
      "/run/current-system/sw/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(this.#host.env.APPDATA ? [NodePath.join(this.#host.env.APPDATA, "npm")] : []),
    ].filter(Boolean);
    for (const dir of dirs) {
      for (const candidate of this.#host.platform === "win32" ? [exe, `${name}.cmd`] : [exe]) {
        const full = NodePath.join(dir, candidate);
        if (await exists(full)) return { path: full, version: await this.#version(full), source: "path" };
      }
    }
    return null;
  }

  async #version(path: string): Promise<string | null> {
    const result = await runWithInput(path, ["--version"], NodeOS.tmpdir(), null, 10_000);
    return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
  }

  async status(): Promise<IweToolStatus> {
    const [cli, languageServer, mcpServer] = await Promise.all([this.#locate("iwe"), this.#locate("iwes"), this.#locate("iwec")]);
    const asset = iweReleaseAsset(this.#host.platform, this.#host.arch);
    return {
      cli,
      languageServer,
      mcpServer,
      setup: iweSetupSteps(this.#host.platform, this.#distroId),
      managedInstall: asset ? { version: "latest", url: `https://github.com/iwe-org/iwe/releases/latest (iwe-<version>-${asset})`, source: "GitHub releases of iwe-org/iwe" } : null,
    };
  }

  async install(report: (completed: number | null, total: number | null) => void): Promise<IweToolStatus> {
    const asset = iweReleaseAsset(this.#host.platform, this.#host.arch) ?? fail("No prebuilt IWE release for this computer. Use one of the setup commands instead.");
    const release = (await (await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } })).json()) as { tag_name?: string };
    const tag = release.tag_name ?? fail("Could not look up the latest IWE release.");
    const file = `${tag}-${asset}`;
    const base = `https://github.com/iwe-org/iwe/releases/download/${tag}`;
    const sums = await (await fetch(`${base}/${tag}-${asset.replace(/\.(tar\.gz|zip)$/, "")}.sha256`)).text();
    const sha256 = /([0-9a-f]{64})/i.exec(sums)?.[1]?.toLowerCase() ?? null;
    const downloads = NodePath.join(this.#host.baseDir, "downloads");
    const archive = await downloadResumable({ url: `${base}/${file}`, destination: NodePath.join(downloads, file), sha256, onProgress: (progress) => report(progress.completed, progress.total) });
    const target = NodePath.join(this.#host.baseDir, "tools", "iwe", "current");
    await NodeFSP.rm(target, { recursive: true, force: true });
    await NodeFSP.mkdir(target, { recursive: true });
    const unpack = await runWithInput("tar", file.endsWith(".zip") ? ["-xf", archive.path, "-C", target] : ["-xzf", archive.path, "-C", target], target, null, 120_000);
    if (unpack.code !== 0) fail(`Could not unpack ${file}: ${unpack.stderr.slice(-300)}`);
    // Archives may nest the binaries in a folder; flatten them into tools/iwe/current.
    for (const entry of await NodeFSP.readdir(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const inner of await NodeFSP.readdir(NodePath.join(target, entry.name))) {
        await NodeFSP.rename(NodePath.join(target, entry.name, inner), NodePath.join(target, inner)).catch(() => undefined);
      }
    }
    this.#located.clear();
    return this.status();
  }

  async #cli(): Promise<string> {
    const found = await this.#locate("iwe");
    if (found) return found.path;
    const [first] = iweSetupSteps(this.#host.platform, this.#distroId);
    return fail(
      `IWE is not installed on this computer. Install it with \`${first!.commands[0]}\` (${first!.title}), or open Notes (IWE) in a thread and choose Install IWE for Continuum.`,
    );
  }

  async #run(root: string, args: ReadonlyArray<string>, input: string | null = null) {
    const result = await runWithInput(await this.#cli(), args, root, input);
    if (result.code !== 0) fail(`iwe ${args[0]} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
    return result.stdout;
  }


  async workspace(path: string): Promise<IweWorkspaceInfo | null> {
    const root = await findWorkspaceRoot(path);
    if (root === null) return null;
    const config = parseIweConfig(await NodeFSP.readFile(NodePath.join(root, ".iwe", "config.toml"), "utf8"));
    const notesRoot = NodePath.join(root, config.workspacePath);
    // Opening is file-based; without the CLI, count Markdown files instead of asking IWE.
    const keys = (await this.#locate("iwe"))
      ? (await this.#run(root, ["find", "-f", "keys", "--limit", "100000"]).catch(() => "")).split("\n").filter(Boolean)
      : await countMarkdown(notesRoot);
    return {
      root,
      name: NodePath.basename(root),
      notesRoot,
      linkFormat: config.linkFormat,
      refsExtension: config.refsExtension,
      documentCount: keys.length,
    };
  }

  /** Opens an existing workspace, or runs `iwe init` in a new or plain folder. */
  async prepare(path: string, mode: "open" | "new"): Promise<IweWorkspaceInfo> {
    const resolved = NodePath.resolve(path.replace(/^~(?=$|[\\/])/, NodeOS.homedir()));
    if (mode === "open") {
      return (await this.workspace(resolved)) ?? fail(`${resolved} is not an IWE workspace (no .iwe/config.toml). Choose New IWE Workspace to set one up.`);
    }
    if (await exists(NodePath.join(resolved, ".iwe", "config.toml"))) return (await this.workspace(resolved))!;
    await NodeFSP.mkdir(resolved, { recursive: true });
    // Without a terminal, init detects the folder's existing conventions and writes them.
    await this.#run(resolved, ["init", "--auto"]);
    const markdown = (await NodeFSP.readdir(resolved)).filter((name) => name.endsWith(".md"));
    if (markdown.length === 0) {
      await this.#run(resolved, ["new", "Index", "-k", "index", "--content=Start here. Type [ to link another note."]);
    }
    return (await this.workspace(resolved))!;
  }


  async search(root: string, query: string, mode: "fuzzy" | "lexical" | "both", limit: number): Promise<IweNoteSummary[]> {
    const args = ["find", "-f", "json", "--limit", String(Math.min(Math.max(limit, 1), 500))];
    const trimmed = query.trim();
    if (trimmed !== "") {
      if (mode !== "lexical") args.push("--fuzzy", trimmed);
      if (mode !== "fuzzy") args.push("--lexical", trimmed);
    }
    return (JSON.parse((await this.#run(root, args)) || "[]") as RawSummary[]).map(summaryOf);
  }

  async #notePath(root: string, key: string): Promise<string> {
    const config = parseIweConfig(await NodeFSP.readFile(NodePath.join(root, ".iwe", "config.toml"), "utf8"));
    const path = NodePath.resolve(root, config.workspacePath, `${key}.md`);
    if (!path.startsWith(NodePath.resolve(root) + NodePath.sep)) fail("That note is outside the workspace.");
    return path;
  }

  async note(root: string, key: string): Promise<IweNote> {
    const [raw] = JSON.parse((await this.#run(root, ["retrieve", "-k", key, "-f", "json"])) || "[]") as RawSummary[];
    if (!raw) fail(`No note ${key}.`);
    const path = await this.#notePath(root, key);
    const stat = await NodeFSP.stat(path).catch(() => null);
    return { ...summaryOf(raw!), path, content: raw!.content ?? "", modifiedAt: stat ? stat.mtime.toISOString() : null };
  }

  /** The note and its linked notes as Markdown, the way IWE hands context to agents. */
  async context(root: string, keys: ReadonlyArray<string>, depth: number): Promise<string> {
    const args = ["retrieve", ...keys.flatMap((key) => ["-k", key])];
    if (depth > 0) args.push("--expand-references", String(depth), "--expand-includes", String(depth), "--expand-referenced-by", "1");
    return this.#run(root, args);
  }

  async retrieveExpanded(root: string, keys: ReadonlyArray<string>, depths: { readonly references: number; readonly backlinks: number; readonly children: number; readonly parents: number }): Promise<string> {
    const args = ["retrieve", ...keys.flatMap((key) => ["-k", key])];
    const clamp = (value: number) => String(Math.min(Math.max(Math.floor(value), 0), 3));
    if (depths.references > 0) args.push("--expand-references", clamp(depths.references));
    if (depths.backlinks > 0) args.push("--expand-referenced-by", clamp(depths.backlinks));
    if (depths.children > 0) args.push("--expand-includes", clamp(depths.children));
    if (depths.parents > 0) args.push("--expand-included-by", clamp(depths.parents));
    return this.#run(root, args);
  }

  async save(root: string, key: string, content: string): Promise<IweNote> {
    await this.#run(root, ["update", "-k", key, "-c", "-"], content);
    return this.note(root, key);
  }

  async create(root: string, input: { readonly title?: string; readonly key?: string; readonly content: string }): Promise<IweNote> {
    if (input.key) {
      const content = input.content.trimStart().startsWith("#") || input.content.startsWith("---") ? input.content : `# ${input.title ?? input.key}\n\n${input.content}`;
      await this.#run(root, ["create", input.key, "-c", "-"], content);
      return this.note(root, input.key);
    }
    // `--content=` keeps content that starts with "-" from being read as a flag.
    const printed = (await this.#run(root, ["new", input.title ?? fail("A new note needs a title or a key."), `--content=${input.content}`])).trim().split("\n").at(-1)!;
    const config = parseIweConfig(await NodeFSP.readFile(NodePath.join(root, ".iwe", "config.toml"), "utf8"));
    const key = NodePath.relative(NodePath.join(root, config.workspacePath), printed).replace(/\.md$/, "").split(NodePath.sep).join("/");
    return this.note(root, key);
  }

  async rename(root: string, key: string, newKey: string): Promise<{ changedFiles: string[]; key: string }> {
    const output = await this.#run(root, ["rename", key, newKey, "-f", "keys"]);
    return { changedFiles: output.split("\n").filter(Boolean), key: newKey };
  }


  async #server(root: string): Promise<IweLanguageServer> {
    const existing = this.#servers.get(root);
    if (existing && !existing.closed) return existing;
    const iwes = (await this.#locate("iwes"))?.path ?? fail("The iwes language server is not installed; link completion and renames need it. Settings → IWE shows how.");
    const server = new IweLanguageServer(iwes, root, () => {
      if (this.#servers.get(root) === server) this.#servers.delete(root);
    });
    this.#servers.set(root, server);
    return server;
  }

  async complete(root: string, key: string, text: string, line: number, character: number) {
    const server = await this.#server(root);
    return server.complete(await this.#notePath(root, key), text, { line, character });
  }

  async renameLink(root: string, key: string, text: string, line: number, character: number, newName: string) {
    const server = await this.#server(root);
    const path = await this.#notePath(root, key);
    const changedFiles = (await server.rename(path, text, { line, character }, newName)).map((file) => NodePath.relative(root, file).split(NodePath.sep).join("/"));
    // The open note may itself have moved; IWE reports the new file as created.
    const stillThere = await exists(path);
    return { changedFiles, key: stillThere ? key : key };
  }


  #thread(threadId: string): ThreadRecord {
    let record = this.#threads.get(threadId);
    if (!record) {
      record = { workspaceRoot: null, attachments: [], activity: [] };
      this.#threads.set(threadId, record);
    }
    return record;
  }

  threadState(threadId: ThreadId, projectRoot: string | null): Promise<IweThreadState> {
    return this.#stateOf(threadId, projectRoot);
  }

  async #stateOf(threadId: ThreadId, projectRoot: string | null): Promise<IweThreadState> {
    const record = this.#threads.get(threadId);
    return {
      threadId,
      workspaceRoot: record?.workspaceRoot ?? (projectRoot ? await findWorkspaceRoot(projectRoot) : null),
      attachments: (record?.attachments ?? []).map(({ key, title, depth }) => ({ key, title, depth })),
      activity: record?.activity ?? [],
    };
  }

  /** The thread's IWE workspace: chosen for it, or the project's own. */
  async workspaceForThread(threadId: string, projectRoot: string | null): Promise<string | null> {
    return this.#threads.get(threadId)?.workspaceRoot ?? (projectRoot ? await findWorkspaceRoot(projectRoot) : null);
  }

  async select(threadId: ThreadId, root: string | null, projectRoot: string | null) {
    const record = this.#thread(threadId);
    record.workspaceRoot = root === null ? null : ((await findWorkspaceRoot(root)) ?? fail(`${root} is not an IWE workspace.`));
    await this.#save();
    return this.#stateOf(threadId, projectRoot);
  }

  async attach(threadId: ThreadId, root: string, key: string, depth: number, projectRoot: string | null) {
    const note = await this.note(root, key);
    const record = this.#thread(threadId);
    record.workspaceRoot ??= root;
    record.attachments = [...record.attachments.filter((entry) => entry.key !== key), { key, title: note.title, depth, root }];
    this.record(threadId, [{ key, title: note.title }], "attached", "user");
    await this.#save();
    return this.#stateOf(threadId, projectRoot);
  }

  async detach(threadId: ThreadId, key: string, projectRoot: string | null) {
    const record = this.#thread(threadId);
    record.attachments = record.attachments.filter((entry) => entry.key !== key);
    await this.#save();
    return this.#stateOf(threadId, projectRoot);
  }

  record(threadId: string, notes: ReadonlyArray<{ readonly key: string; readonly title: string }>, action: IweNoteActivity["action"], by: "agent" | "user") {
    if (notes.length === 0) return;
    const record = this.#thread(threadId);
    const at = new Date().toISOString();
    record.activity = [...notes.map((note) => ({ key: note.key, title: note.title, action, by, at })), ...record.activity].slice(0, ACTIVITY_LIMIT);
    void this.#save();
  }

  /** Attached notes, with their linked context, for the next turn; they go out once. */
  async contextForTurn(threadId: string, projectRoot: string | null): Promise<string> {
    const record = this.#threads.get(threadId);
    const root = await this.workspaceForThread(threadId, projectRoot);
    const parts: string[] = [];
    if (root !== null) {
      parts.push(`This thread uses the IWE notes workspace at ${root}. Search, read, and write notes with the continuum_iwe_* tools; keep IWE's link style and file layout.`);
    }
    if (record && record.attachments.length > 0) {
      for (const attachment of record.attachments) {
        const context = await this.context(attachment.root, [attachment.key], attachment.depth).catch(() => "");
        if (context !== "") parts.push(`The user attached the IWE note "${attachment.title}" (${attachment.key}) with its linked notes:\n\n${context}`);
      }
      this.record(threadId, record.attachments, "read", "agent");
      record.attachments = [];
      await this.#save();
    }
    return parts.join("\n\n");
  }
}
