// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - plain Node on purpose: this runs before and instead of a process spawn.
/**
 * Answers a small set of read-only git metadata commands by reading the
 * repository files directly, without spawning `git`.
 *
 * Background loops ask git the same cheap questions (toplevel, remotes, HEAD,
 * a config value) many times a minute per project. On Windows every spawn costs
 * a launcher, a `conhost.exe` and a slot on the session-wide win32k lock, so the
 * volume stalls the whole desktop. Reading a few small files costs microseconds.
 *
 * Contract: `tryAnswerGitCommand` returns exactly what `git` would have printed,
 * or `null`. `null` means "not sure" and the caller must spawn git. Anything
 * unusual (unknown arguments, `GIT_*` overrides, includes, extensions, bare
 * repositories, reftable, ambiguous names, unreadable files) returns `null`.
 * Never guess here: a wrong answer is worse than a spawn.
 *
 * Whether a directory is a repository git is willing to open at all (ownership
 * and `safe.directory`, format version, filesystem boundaries) is git's call:
 * git is asked once per repository and the verdict is reused for a few minutes.
 * This module only ever reads text and never runs anything a repository configures.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface GitFastPathInput {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The caller's budget for the command; the answer never takes longer than this. */
  readonly timeoutMs?: number | null | undefined;
  /** The caller's output cap. A larger answer is left to git, which truncates or fails as asked. */
  readonly maxOutputBytes?: number | undefined;
}

export interface GitFastPathAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `T3CODE_GIT_FAST_PATH=0` turns the fast path off; every command spawns git again. */
export const isGitFastPathEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.T3CODE_GIT_FAST_PATH !== "0";

const ANSWER_TIMEOUT_MS = 2_000;
// Same default as the process runners that would otherwise spawn git.
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

class Unsure extends Error {}
/** Discovery reached the filesystem root, and git agreed: exit 128 with this stderr. */
class NotARepository extends Error {
  readonly stderr: string;
  constructor(stderr: string) {
    super("not a repository");
    this.stderr = stderr;
  }
}
const unsure = (reason: string): never => {
  throw new Unsure(reason);
};

// GIT_* variables that cannot change discovery, config or ref resolution.
const HARMLESS_GIT_ENV = new Set([
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_OPTIONAL_LOCKS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_LFS_SKIP_SMUDGE",
  "GIT_MERGE_AUTOEDIT",
  "GIT_EXEC_PATH",
  "GIT_INSTALL_ROOT",
]);

function hasGitEnvOverride(env: NodeJS.ProcessEnv | undefined): boolean {
  if (!env) return false;
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") && !HARMLESS_GIT_ENV.has(upper)) return true;
  }
  return false;
}

// Where git finds itself and its system/global config. The cached listing and
// verdicts come from git run with the server's own environment.
const GIT_LOCATION_ENV = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "PATH",
]);

function movesGitOrItsConfig(env: NodeJS.ProcessEnv | undefined): boolean {
  if (!env) return false;
  for (const [key, value] of Object.entries(env)) {
    // Windows environment names ignore case; `process.env` lookups there do too.
    const name = NodePath.sep === "\\" ? key.toUpperCase() : key;
    if (GIT_LOCATION_ENV.has(name) && value !== process.env[key]) return true;
  }
  return false;
}

/**
 * Runs at most `max` of the given tasks at once, the rest in arrival order.
 * Exported for tests.
 */
export function makeTaskLimiter(max: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finishing task hands its slot to the next one, so `running` stays put.
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

// The git processes started here run outside the drivers' process permits. A
// sweep over many repositories asks for one verdict each, all at once.
const withOwnGitProcess = makeTaskLimiter(4);

const toGitPath = (value: string) => (NodePath.sep === "\\" ? value.replaceAll("\\", "/") : value);

async function statOrNull(target: string) {
  try {
    return await NodeFSP.stat(target);
  } catch {
    return null;
  }
}

// git bounds what it reads from a repository too (HEAD, the `.git` file). The
// server opens folders it did not create, so a huge or special file is git's to refuse.
const SMALL_FILE_BYTES = 4 * 1024;
const CONFIG_FILE_BYTES = 1024 * 1024;
const PACKED_REFS_BYTES = 32 * 1024 * 1024;

/** Text of a regular file no larger than `maxBytes`, `null` when it does not exist. */
async function readBoundedFile(file: string, maxBytes: number): Promise<string | null> {
  // One handle for the check and the read: a path checked first and opened later
  // can be swapped for a FIFO or a huge file in between. O_NONBLOCK keeps the
  // open itself from waiting on a FIFO; Windows has neither.
  const handle = await NodeFSP.open(
    file,
    NodeFSP.constants.O_RDONLY | (NodeFSP.constants.O_NONBLOCK ?? 0),
  ).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" || error.code === "ENOTDIR" ? null : unsure("unreadable file"),
  );
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) unsure("not a small regular file");
    // One spare byte shows a file that grew after the size was taken.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) unsure("file grew while it was read");
    const text = buffer.toString("utf8", 0, length);
    // Lossy decoding or a NUL would make the answer differ from git's bytes.
    if (text.includes("\0") || text.includes("\ufffd")) unsure("binary content");
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * git refuses `\\server\share` targets in `.git` files and `commondir`: touching
 * one makes Windows authenticate to that server. Checked before any filesystem call.
 */
function assertLocalPath(target: string): void {
  if (/^[\\/]{2}/.test(target)) unsure("UNC path");
}

// ---------------------------------------------------------------------------
// Config parsing

export interface GitConfigEntry {
  /** Canonical key: lowercase section and variable, subsection as written. */
  readonly key: string;
  readonly value: string;
}

/**
 * Strict parser for git's config file syntax. Throws on anything it does not
 * fully understand, including value-less keys, so the caller falls back to git.
 */
export function parseGitConfig(text: string): ReadonlyArray<GitConfigEntry> {
  const entries: Array<GitConfigEntry> = [];
  let section: string | null = null;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const length = text.length;
  const isSpace = (char: string) => char === " " || char === "\t" || char === "\r";

  while (index < length) {
    const char = text[index]!;
    if (char === "\n" || isSpace(char)) {
      index++;
      continue;
    }
    if (char === "#" || char === ";") {
      while (index < length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "[") {
      const close = text.indexOf("]", index);
      const lineEnd = text.indexOf("\n", index);
      if (close === -1) unsure("config: unterminated section header");
      const header = text.slice(index + 1, close);
      const quoted = /^([A-Za-z0-9.-]+)[ \t]+"((?:[^"\\\n]|\\.)*)"$/.exec(header);
      if (quoted) {
        section = `${quoted[1]!.toLowerCase()}.${quoted[2]!.replace(/\\(.)/g, "$1")}`;
      } else if (/^[A-Za-z0-9.-]+$/.test(header)) {
        section = header.toLowerCase();
      } else {
        unsure("config: unsupported section header");
      }
      if (lineEnd !== -1 && close > lineEnd) unsure("config: section header spans lines");
      index = close + 1;
      continue;
    }

    if (section === null) unsure("config: key before any section");
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(index, index + 256));
    if (!nameMatch) unsure("config: invalid variable name");
    const name = nameMatch![0].toLowerCase();
    index += nameMatch![0].length;
    while (index < length && isSpace(text[index]!)) index++;
    if (text[index] !== "=") unsure("config: value-less key");
    index++;
    while (index < length && isSpace(text[index]!)) index++;

    let value = "";
    let inQuotes = false;
    let pendingSpace = "";
    for (; index < length; index++) {
      const current = text[index]!;
      if (current === "\n") break;
      if (current === "\r" && text[index + 1] === "\n") continue;
      if (!inQuotes && (current === "#" || current === ";")) {
        while (index < length && text[index] !== "\n") index++;
        break;
      }
      if (!inQuotes && (current === " " || current === "\t")) {
        pendingSpace += current;
        continue;
      }
      value += pendingSpace;
      pendingSpace = "";
      if (current === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (current === "\\") {
        let next = text[++index];
        if (next === "\r" && text[index + 1] === "\n") next = text[++index];
        if (next === "\n") continue;
        if (next === "n") value += "\n";
        else if (next === "t") value += "\t";
        else if (next === "b") value += "\b";
        else if (next === "\\" || next === '"') value += next;
        else unsure("config: unsupported escape");
        continue;
      }
      value += current;
    }
    if (inQuotes) unsure("config: unterminated quote");
    entries.push({ key: `${section}.${name}`, value });
  }
  return entries;
}

/** `Section.Sub.Name` -> `section.Sub.name`, the form git prints and compares. */
function canonicalConfigKey(key: string): string | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  if (/[\n\0]/.test(key)) return null;
  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(last + 1).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(section) || !/^[a-z][a-z0-9-]*$/.test(name)) return null;
  return first === last ? `${section}.${name}` : `${section}.${key.slice(first + 1, last)}.${name}`;
}

const lastValue = (entries: ReadonlyArray<GitConfigEntry>, key: string) =>
  entries.findLast((entry) => entry.key === key)?.value;

/** git's boolean: a word, or any non-zero integer (`core.bare = 2` is true). */
const isGitTrue = (value: string | undefined) => {
  const text = value?.trim() ?? "";
  if (/^(true|yes|on)$/i.test(text)) return true;
  return /^[-+]?\d+[kmg]?$/i.test(text) && Number.parseInt(text, 10) !== 0;
};

// ---------------------------------------------------------------------------
// System and global config
//
// Their locations depend on the git installation, so git lists them once and
// the result is reused until one of the files it came from changes.

interface OuterConfig {
  readonly entries: ReadonlyArray<GitConfigEntry>;
  readonly files: ReadonlyArray<string>;
  readonly fingerprint: string;
  readonly loadedAtMs: number;
}

const OUTER_CONFIG_MAX_AGE_MS = 5 * 60_000;
const OUTER_CONFIG_RETRY_MS = 30_000;
let outerConfig: Promise<OuterConfig> | null = null;
let outerConfigFailedAtMs: number | null = null;

function outerConfigCandidates(origins: ReadonlyArray<string>): ReadonlyArray<string> {
  const home = NodeOS.homedir();
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return [
    ...new Set([
      ...origins,
      NodePath.join(home, ".gitconfig"),
      NodePath.join(xdg, "git", "config"),
    ]),
  ];
}

async function fingerprintFiles(files: ReadonlyArray<string>): Promise<string> {
  const stats = await Promise.all(files.map(statOrNull));
  return stats.map((stat) => (stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : "-")).join("|");
}

function listOuterConfig(): Promise<string> {
  return withOwnGitProcess(
    () =>
      new Promise((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          ["config", "--list", "--show-scope", "--show-origin", "-z"],
          { cwd: NodeOS.tmpdir(), windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }),
  );
}

/** Where git looks for an `include.path` value found in `originFile`. */
function includedConfigFile(originFile: string, value: string): string {
  if (value === "~" || value.startsWith("~/"))
    return NodePath.join(NodeOS.homedir(), value.slice(1));
  // `~user/` needs the account database; `%(prefix)/` needs git's install location.
  if (value.startsWith("~") || value.startsWith("%(")) unsure("outer config: include location");
  return NodePath.resolve(NodePath.dirname(originFile), value);
}

async function loadOuterConfig(): Promise<OuterConfig> {
  // Records: scope NUL origin NUL key LF value NUL
  const fields = (await listOuterConfig()).split("\0");
  const entries: Array<GitConfigEntry> = [];
  const origins: Array<string> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index]!;
    const origin = fields[index + 1]!;
    const record = fields[index + 2]!;
    if (scope !== "system" && scope !== "global") continue;
    if (!origin.startsWith("file:")) unsure("outer config: non-file origin");
    const originFile = NodePath.resolve(origin.slice("file:".length));
    origins.push(originFile);
    const separator = record.indexOf("\n");
    if (separator === -1) unsure("outer config: value-less key");
    const entry = { key: record.slice(0, separator), value: record.slice(separator + 1) };
    entries.push(entry);
    // An included file that is missing or empty lists no entries of its own, so
    // it is watched by name: the listing is stale once it gains content.
    if (entry.key === "include.path") origins.push(includedConfigFile(originFile, entry.value));
  }
  const files = outerConfigCandidates(origins);
  return { entries, files, fingerprint: await fingerprintFiles(files), loadedAtMs: Date.now() };
}

/**
 * Also the proof that git runs at all: every answer asks for it first, so a
 * missing or broken git stays as visible as it was when each question spawned it.
 */
async function getOuterConfig(): Promise<ReadonlyArray<GitConfigEntry>> {
  const pending = outerConfig;
  const current = pending ? await pending.catch(() => null) : null;
  if (
    current &&
    Date.now() - current.loadedAtMs < OUTER_CONFIG_MAX_AGE_MS &&
    (await fingerprintFiles(current.files)) === current.fingerprint
  ) {
    return current.entries;
  }
  // Concurrent callers share one listing.
  if (outerConfig === pending) {
    // A listing that failed (no git, a config this reader refuses) fails again;
    // retrying it for every command would add a spawn to each one.
    if (
      outerConfigFailedAtMs !== null &&
      Date.now() - outerConfigFailedAtMs < OUTER_CONFIG_RETRY_MS
    )
      unsure("outer config unavailable");
    const loading = loadOuterConfig();
    loading.then(
      () => (outerConfigFailedAtMs = null),
      () => (outerConfigFailedAtMs = Date.now()),
    );
    outerConfig = loading;
  }
  return (await outerConfig!).entries;
}

/** Test seam: forget the cached system/global config. */
export const resetGitFastPathCaches = () => {
  outerConfig = null;
  outerConfigFailedAtMs = null;
  verdicts.clear();
  packedRefsCache.clear();
  revListMemo.clear();
};

// ---------------------------------------------------------------------------
// Repository discovery

interface Repository {
  /** Real path of the directory that holds `.git`. */
  readonly workTree: string;
  readonly gitDir: string;
  readonly commonDir: string;
  /** `.git` is a directory (main worktree), not a `gitdir:` file. */
  readonly dotGitIsDirectory: boolean;
  readonly localConfig: ReadonlyArray<GitConfigEntry>;
}

const HEAD_CONTENT = /^(?:ref:[ \t]*refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\s*$/;

/**
 * git's `is_git_directory`. A directory whose HEAD is empty or garbage (an
 * interrupted clone) is not a repository to git, which then keeps looking in the
 * parents; callers here decline instead.
 */
async function looksLikeGitDir(dir: string): Promise<boolean> {
  const [head, objects, refs, commondir] = await Promise.all([
    statOrNull(NodePath.join(dir, "HEAD")),
    statOrNull(NodePath.join(dir, "objects")),
    statOrNull(NodePath.join(dir, "refs")),
    statOrNull(NodePath.join(dir, "commondir")),
  ]);
  if (!head?.isFile() || !(commondir?.isFile() || (objects?.isDirectory() && refs?.isDirectory())))
    return false;
  const content = await readBoundedFile(NodePath.join(dir, "HEAD"), SMALL_FILE_BYTES);
  return content !== null && HEAD_CONTENT.test(content);
}

const SUPPORTED_EXTENSIONS = new Set([
  "extensions.noop",
  "extensions.objectformat",
  "extensions.partialclone",
  "extensions.preciousobjects",
  "extensions.worktreeconfig",
]);

async function openRepository(workTree: string, gitDir: string, dotGitIsDirectory: boolean) {
  assertLocalPath(gitDir);
  if (!(await looksLikeGitDir(gitDir))) unsure("not a git directory");
  let commonDir = gitDir;
  const commonDirFile = await readBoundedFile(NodePath.join(gitDir, "commondir"), SMALL_FILE_BYTES);
  if (commonDirFile !== null) {
    const relative = commonDirFile.replace(/\r?\n$/, "");
    if (relative.length === 0 || relative.includes("\n")) unsure("malformed commondir");
    assertLocalPath(relative);
    commonDir = NodePath.resolve(gitDir, relative);
    assertLocalPath(commonDir);
    const [objects, refs] = await Promise.all([
      statOrNull(NodePath.join(commonDir, "objects")),
      statOrNull(NodePath.join(commonDir, "refs")),
    ]);
    if (!objects?.isDirectory() || !refs?.isDirectory()) unsure("common dir is incomplete");
  }

  const sharedConfig = parseGitConfig(
    (await readBoundedFile(NodePath.join(commonDir, "config"), CONFIG_FILE_BYTES)) ??
      unsure("no repository config"),
  );
  // Without a format version git ignores every extension, worktreeConfig included.
  const versionText = lastValue(sharedConfig, "core.repositoryformatversion");
  if (versionText === undefined && sharedConfig.some(({ key }) => key.startsWith("extensions.")))
    unsure("extensions without a format version");
  // extensions.worktreeConfig adds a per-worktree file that outranks the shared one.
  const worktreeConfigFile = isGitTrue(lastValue(sharedConfig, "extensions.worktreeconfig"))
    ? ((await readBoundedFile(NodePath.join(gitDir, "config.worktree"), CONFIG_FILE_BYTES)) ?? "")
    : "";
  const localConfig = [...sharedConfig, ...parseGitConfig(worktreeConfigFile)];
  const version = Number(versionText ?? "0");
  if (version !== 0 && version !== 1) unsure("unknown repository format");
  for (const { key } of localConfig) {
    if (key.startsWith("include.") || key.startsWith("includeif.")) unsure("config includes");
    if (key.startsWith("extensions.") && !SUPPORTED_EXTENSIONS.has(key)) unsure("extension");
  }
  if (isGitTrue(lastValue(localConfig, "core.bare"))) unsure("bare repository");
  if (lastValue(localConfig, "core.worktree") !== undefined) unsure("core.worktree");

  return { workTree, gitDir, commonDir, dotGitIsDirectory, localConfig } satisfies Repository;
}

async function discoverRepository(cwd: string): Promise<{ repo: Repository; realCwd: string }> {
  const realCwd = await NodeFSP.realpath(cwd);
  if (realCwd.startsWith("\\\\")) unsure("UNC path");
  const startStat = await NodeFSP.stat(realCwd);
  // Windows has no device ids worth comparing, and git for Windows does not compare them either.
  const checkBoundaries = NodePath.sep !== "\\";

  for (let dir = realCwd; ;) {
    const dotGit = NodePath.join(dir, ".git");
    const dotGitStat = await statOrNull(dotGit);
    // git walks past a `.git` directory that is not a repository (an empty one, a broken HEAD).
    if (dotGitStat?.isDirectory() && (await looksLikeGitDir(dotGit))) {
      return { repo: await openRepository(dir, dotGit, true), realCwd };
    }
    if (dotGitStat && !dotGitStat.isDirectory()) {
      const pointer = /^gitdir: (.+?)\r?\n?$/.exec(
        (await readBoundedFile(dotGit, SMALL_FILE_BYTES)) ?? "",
      );
      if (!pointer) unsure("malformed .git file");
      assertLocalPath(pointer![1]!);
      return {
        repo: await openRepository(dir, NodePath.resolve(dir, pointer![1]!), false),
        realCwd,
      };
    }
    // Inside a git directory or a bare repository: git has rules this does not replicate.
    if (await looksLikeGitDir(dir)) unsure("inside a git directory");

    const parent = NodePath.dirname(dir);
    if (parent === dir) return notARepository(realCwd);
    // git stops at filesystem boundaries unless told otherwise.
    if (checkBoundaries && (await NodeFSP.stat(parent)).dev !== startStat.dev)
      unsure("filesystem boundary");
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// git's verdict on the repository
//
// Discovery above finds the files. Whether git accepts them (owner and
// `safe.directory`, format version and extensions, filesystem boundaries) has
// too many rules, and too much security history, to mirror here. One spawn per
// repository per few minutes settles it, against hundreds of answered questions.

const VERDICT_MAX_AGE_MS = 5 * 60_000;
const VERDICT_CAPACITY = 256;

interface GitVerdict {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const verdicts = new Map<string, { readonly at: number; readonly verdict: Promise<GitVerdict> }>();

function askGit(args: ReadonlyArray<string>): Promise<GitVerdict> {
  return withOwnGitProcess(
    () =>
      new Promise((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          [...args],
          {
            cwd: NodeOS.tmpdir(),
            env: { ...process.env, LC_ALL: "C" },
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
          },
          (error, stdout, stderr) =>
            error && typeof error.code !== "number"
              ? reject(error)
              : resolve({
                  exitCode: typeof error?.code === "number" ? error.code : 0,
                  stdout,
                  stderr,
                }),
        );
      }),
  );
}

function gitVerdict(args: ReadonlyArray<string>): Promise<GitVerdict> {
  const key = args.join("\0");
  const known = verdicts.get(key);
  if (known && Date.now() - known.at < VERDICT_MAX_AGE_MS) return known.verdict;
  if (verdicts.size >= VERDICT_CAPACITY) verdicts.clear();
  const verdict = askGit(args);
  verdicts.set(key, { at: Date.now(), verdict });
  // A failed spawn is not a verdict.
  verdict.catch(() => verdicts.delete(key));
  return verdict;
}

/** Declines unless git opens the same repository from the same place. */
async function requireGitAgrees(repo: Repository, explicitGitDir: boolean): Promise<void> {
  const verdict = explicitGitDir
    ? await gitVerdict(["--git-dir", repo.gitDir, "rev-parse", "--git-dir"])
    : await gitVerdict(["-C", repo.workTree, "rev-parse", "--show-toplevel"]);
  if (verdict.exitCode !== 0) unsure("git refuses this repository");
  if (!explicitGitDir && verdict.stdout !== `${toGitPath(repo.workTree)}\n`)
    unsure("git opens a different repository");
}

/** Discovery found no repository; answers 128 only with git's own words for it. */
async function notARepository(cwd: string): Promise<never> {
  const verdict = await gitVerdict(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (verdict.exitCode !== 128 || verdict.stdout !== "") unsure("git found a repository");
  throw new NotARepository(verdict.stderr);
}

// ---------------------------------------------------------------------------
// Refs

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i;

/** Accepts only names that are safe to join onto the git directory. */
function isSafeRefName(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.endsWith("/") || ref.endsWith(".")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\//.test(ref)) return false;
  return ref.split("/").every(
    (part) =>
      part.length > 0 &&
      !part.startsWith(".") &&
      !part.endsWith(".lock") &&
      // Legal to git, but Windows maps these onto other files or onto devices.
      !part.endsWith(".") &&
      !WINDOWS_DEVICE_NAME.test(part),
  );
}

const packedRefsCache = new Map<
  string,
  { fingerprint: string; refs: ReadonlyMap<string, string> }
>();

/** Packed ref name -> object id. */
async function readPackedRefs(commonDir: string): Promise<ReadonlyMap<string, string>> {
  const file = NodePath.join(commonDir, "packed-refs");
  const stat = await statOrNull(file);
  if (!stat) return new Map();
  const fingerprint = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const cached = packedRefsCache.get(file);
  if (cached?.fingerprint === fingerprint) return cached.refs;

  const refs = new Map<string, string>();
  const text = (await readBoundedFile(file, PACKED_REFS_BYTES)) ?? "";
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space === -1 || !OBJECT_ID.test(line.slice(0, space))) unsure("malformed packed-refs");
    // git dies on an unsafe name here; these names reach NUL-delimited output.
    const name = line.slice(space + 1);
    if (!isSafeRefName(name)) unsure("unsafe packed ref name");
    refs.set(name, line.slice(0, space));
  }
  // Without an inode a same-size rewrite inside one mtime tick would go unseen.
  if (stat.ino === 0) return refs;
  if (packedRefsCache.size >= 64) packedRefsCache.clear();
  packedRefsCache.set(file, { fingerprint, refs });
  return refs;
}

type RefState = "exists" | "missing";

/** Object id a ref points at, `null` when the ref does not exist. */
async function refObjectId(repo: Repository, ref: string): Promise<string | null> {
  if (!isSafeRefName(ref)) unsure("unsafe ref name");
  // These live in each worktree's own git directory, not in the common one read below.
  if (/^refs\/(?:bisect|worktree|rewritten)\//.test(ref)) unsure("per-worktree ref");
  const looseFile = NodePath.join(repo.commonDir, ...ref.split("/"));
  // A directory here means deeper refs exist (`refs/heads/a` vs `refs/heads/a/b`), not this one.
  const loose = (await statOrNull(looseFile))?.isDirectory()
    ? null
    : await readBoundedFile(looseFile, SMALL_FILE_BYTES);
  if (loose !== null) {
    // Symbolic or damaged loose refs need git's full resolution.
    return OBJECT_ID.test(loose.trim()) ? loose.trim() : unsure("loose ref is not an object id");
  }
  return (await readPackedRefs(repo.commonDir)).get(ref) ?? null;
}

const refState = async (repo: Repository, ref: string): Promise<RefState> =>
  (await refObjectId(repo, ref)) === null ? "missing" : "exists";

type Head =
  | { /** Full ref name HEAD points at. */ readonly ref: string }
  | { /** Detached. */ readonly ref: null; readonly objectId: string };

async function readHead(repo: Repository): Promise<Head> {
  const content = (
    (await readBoundedFile(NodePath.join(repo.gitDir, "HEAD"), SMALL_FILE_BYTES)) ??
    unsure("no HEAD")
  ).trim();
  if (OBJECT_ID.test(content)) return { ref: null, objectId: content };
  const symbolic = /^ref: (refs\/\S+)$/.exec(content);
  if (!symbolic || !isSafeRefName(symbolic[1]!)) unsure("unexpected HEAD");
  return { ref: symbolic![1]! };
}

/** `refs/heads/x` -> `x`, only when no other ref namespace could claim `x`. */
async function shortBranchName(repo: Repository, ref: string): Promise<string> {
  if (!ref.startsWith("refs/heads/")) unsure("HEAD outside refs/heads");
  const short = ref.slice("refs/heads/".length);
  const rivals = [
    `refs/${short}`,
    `refs/tags/${short}`,
    `refs/remotes/${short}`,
    `refs/remotes/${short}/HEAD`,
  ];
  for (const rival of rivals) {
    if (!isSafeRefName(rival)) unsure("unsafe rival ref");
    if (await statOrNull(NodePath.join(repo.commonDir, ...rival.split("/"))))
      unsure("ambiguous short name");
  }
  for (const dir of new Set([repo.gitDir, repo.commonDir])) {
    if (await statOrNull(NodePath.join(dir, ...short.split("/")))) unsure("ambiguous short name");
  }
  const packed = await readPackedRefs(repo.commonDir);
  if (rivals.some((rival) => packed.has(rival))) unsure("ambiguous short name");
  return short;
}

// ---------------------------------------------------------------------------
// Remotes

async function mergedConfig(repo: Repository): Promise<ReadonlyArray<GitConfigEntry>> {
  const outer = await getOuterConfig();
  // Conditional includes depend on the repository; the outer listing cannot show them.
  if (outer.some(({ key }) => key.startsWith("includeif."))) unsure("conditional includes");
  return [...outer, ...repo.localConfig];
}

interface Remote {
  readonly name: string;
  readonly urls: ReadonlyArray<string>;
  readonly pushUrls: ReadonlyArray<string>;
}

async function readRemotes(repo: Repository): Promise<ReadonlyArray<Remote>> {
  const config = await mergedConfig(repo);
  // URL rewriting changes what git prints for every remote.
  if (config.some(({ key }) => key.startsWith("url."))) unsure("url rewriting");
  for (const legacy of ["remotes", "branches"]) {
    const names = await NodeFSP.readdir(NodePath.join(repo.commonDir, legacy)).catch(() => []);
    if (names.length > 0) unsure("legacy remote files");
  }

  const remotes = new Map<string, { urls: Array<string>; pushUrls: Array<string> }>();
  for (const { key, value } of config) {
    const match = /^remote\.(.+)\.([a-z][a-z0-9-]*)$/.exec(key);
    if (!match) continue;
    const [, name, variable] = match as unknown as [string, string, string];
    if (variable === "partialclonefilter" || variable === "vcs") unsure("remote variable");
    const remote = remotes.get(name) ?? { urls: [], pushUrls: [] };
    remotes.set(name, remote);
    if (variable !== "url" && variable !== "pushurl") continue;
    // An empty value resets the list in git; rare enough to leave to git.
    if (value.length === 0) unsure("empty remote url");
    (variable === "url" ? remote.urls : remote.pushUrls).push(value);
  }

  const listed: Array<Remote> = [];
  for (const [name, remote] of remotes) {
    // git lists a remote for any `remote.<name>.*` key; without a url its lines differ.
    if (remote.urls.length === 0) unsure("remote without url");
    listed.push({ name, ...remote });
  }
  const byteOrder = (left: Remote, right: Remote) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name));
  return listed.toSorted(byteOrder);
}

// ---------------------------------------------------------------------------
// Commands

const ok = (stdout: string): GitFastPathAnswer => ({ exitCode: 0, stdout, stderr: "" });
const silentFailure: GitFastPathAnswer = { exitCode: 1, stdout: "", stderr: "" };

/**
 * git translates its messages when the locale asks for it. Error text answered
 * here is English, so it is only given to a caller whose git would speak English.
 */
function gitMessagesMayBeTranslated(env: NodeJS.ProcessEnv | undefined): boolean {
  const merged = { ...process.env, ...env };
  const locale = merged.LC_ALL || merged.LC_MESSAGES || merged.LANG || "";
  if (locale === "" || /^(?:C|POSIX)(?:[.@]|$)/.test(locale)) return false;
  return !(merged.LANGUAGE || locale).split(":").every((name) => /^en(?:[_.@]|$)/.test(name));
}

const sameArgs = (args: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  args.length === expected.length && expected.every((value, index) => args[index] === value);

const REV_PARSE_FORMS: ReadonlyArray<ReadonlyArray<string>> = [
  ["--is-inside-work-tree"],
  ["--show-toplevel"],
  ["--git-common-dir"],
  ["--abbrev-ref", "HEAD"],
  ["--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
];

async function answerRevParse(
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv | undefined,
) {
  // Other forms (`--sq-quote`, `--parseopt`, ...) work outside a repository.
  if (!REV_PARSE_FORMS.some((form) => sameArgs(args, form))) unsure("rev-parse arguments");
  const { repo, realCwd } = await discoverRepository(cwd);
  await requireGitAgrees(repo, false);
  if (sameArgs(args, ["--is-inside-work-tree"])) return ok("true\n");
  if (sameArgs(args, ["--show-toplevel"])) return ok(`${toGitPath(repo.workTree)}\n`);
  if (sameArgs(args, ["--git-common-dir"])) {
    // Below the worktree root git prints a relative path; leave that form to git.
    if (realCwd !== repo.workTree) unsure("common dir from a subdirectory");
    return ok(repo.dotGitIsDirectory ? ".git\n" : `${toGitPath(repo.commonDir)}\n`);
  }
  if (sameArgs(args, ["--abbrev-ref", "HEAD"])) {
    const head = await readHead(repo);
    if (head.ref === null) return ok("HEAD\n");
    // An unborn branch is an error in git, with a message worth keeping.
    if ((await refState(repo, head.ref)) === "missing") unsure("unborn branch");
    return ok(`${await shortBranchName(repo, head.ref)}\n`);
  }
  if (sameArgs(args, ["--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) {
    const head = await readHead(repo);
    // Detached and unborn HEADs fail with messages of their own.
    if (head.ref === null || !head.ref.startsWith("refs/heads/")) unsure("detached HEAD");
    if ((await refState(repo, head.ref!)) === "missing") unsure("unborn branch");
    const branch = head.ref!.slice("refs/heads/".length);
    const upstream = await resolveUpstream(repo, await mergedConfig(repo), branch);
    if (!upstream && gitMessagesMayBeTranslated(env)) unsure("translated error message");
    return upstream
      ? ok(`${upstream.short}\n`)
      : {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: no upstream configured for branch '${branch}'\n`,
        };
  }
  return unsure("rev-parse arguments");
}

async function answerSymbolicRef(repo: Repository, args: ReadonlyArray<string>) {
  if (sameArgs(args, ["--quiet", "--short", "HEAD"])) {
    const head = await readHead(repo);
    return head.ref === null ? silentFailure : ok(`${await shortBranchName(repo, head.ref)}\n`);
  }
  if (
    args.length === 1 &&
    /^refs\/remotes\/[^/]+\/HEAD$/.test(args[0]!) &&
    isSafeRefName(args[0]!)
  ) {
    const content =
      (await readBoundedFile(
        NodePath.join(repo.commonDir, ...args[0]!.split("/")),
        SMALL_FILE_BYTES,
      )) ?? unsure("no such ref");
    const symbolic = /^ref: (refs\/\S+)\r?\n?$/.exec(content);
    if (!symbolic || !isSafeRefName(symbolic[1]!)) unsure("not a symbolic ref");
    // git prints the end of a chain; `refObjectId` declines when the target is symbolic too.
    await refObjectId(repo, symbolic![1]!);
    return ok(`${symbolic![1]!}\n`);
  }
  return unsure("symbolic-ref arguments");
}

async function answerRemote(repo: Repository, args: ReadonlyArray<string>) {
  const remotes = await readRemotes(repo);
  if (args.length === 0) return ok(remotes.map(({ name }) => `${name}\n`).join(""));
  if (sameArgs(args, ["-v"])) {
    return ok(
      remotes
        .flatMap(({ name, urls, pushUrls }) => [
          `${name}\t${urls[0]!} (fetch)\n`,
          ...(pushUrls.length > 0 ? pushUrls : urls).map((url) => `${name}\t${url} (push)\n`),
        ])
        .join(""),
    );
  }
  if (args.length === 2 && args[0] === "get-url") {
    // A missing remote has a specific exit code and message; git reports it.
    const remote = remotes.find(({ name }) => name === args[1]) ?? unsure("no such remote");
    // So does one that only system or global config defines: `get-url` wants it in the repository.
    if (!repo.localConfig.some(({ key }) => key.startsWith(`remote.${remote.name}.`)))
      unsure("remote defined outside the repository");
    return ok(`${remote.urls[0]!}\n`);
  }
  return unsure("remote arguments");
}

// ---------------------------------------------------------------------------
// for-each-ref

const REFNAME_FORMAT = "--format=%(refname)";
const UPSTREAM_FORMAT =
  "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)";

const byteOrder = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

/** Every ref below `refs/heads` or `refs/remotes`, loose and packed, that resolves to an object. */
async function listBranchRefs(repo: Repository, namespace: string): Promise<ReadonlyArray<string>> {
  const packed = await readPackedRefs(repo.commonDir);
  const refs = new Set<string>();
  for (const ref of packed.keys()) if (ref.startsWith(`${namespace}/`)) refs.add(ref);

  const walk = async (ref: string): Promise<void> => {
    const entries = await NodeFSP.readdir(NodePath.join(repo.commonDir, ...ref.split("/")), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : unsure("unreadable refs directory"),
    );
    for (const entry of entries) {
      const child = `${ref}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      // Lock files, odd names and non-files are git's to judge.
      if (!entry.isFile() || !isSafeRefName(child)) unsure("unexpected entry under refs");
      const content = (
        (await readBoundedFile(
          NodePath.join(repo.commonDir, ...child.split("/")),
          SMALL_FILE_BYTES,
        )) ?? unsure("ref vanished")
      ).trim();
      if (OBJECT_ID.test(content)) {
        refs.add(child);
        continue;
      }
      // A symbolic ref is listed only when its target exists; git warns about the rest.
      const symbolic = /^ref: (refs\/\S+)$/.exec(content) ?? unsure("damaged loose ref");
      if ((await refState(repo, symbolic[1]!)) === "missing") unsure("dangling symbolic ref");
      refs.add(child);
    }
  };
  await walk(namespace);
  return [...refs];
}

/** git's pattern rule: the whole ref, a leading directory of it, or a glob where `*` stays within one level. */
function refPatternMatcher(pattern: string): (ref: string) => boolean {
  if (!isSafeRefName(pattern.replaceAll("*", "x")) || pattern.includes("**")) unsure("ref pattern");
  if (!pattern.includes("*")) return (ref) => ref === pattern || ref.startsWith(`${pattern}/`);
  const glob = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  return (ref) => glob.test(ref);
}

/** Tracking ref for `branch.<name>.merge` under the remote's fetch refspecs, or `null` when none maps it. */
function mapThroughFetchRefspecs(refspecs: ReadonlyArray<string>, source: string): string | null {
  for (const raw of refspecs) {
    const refspec = raw.startsWith("+") ? raw.slice(1) : raw;
    const colon = refspec.indexOf(":");
    // Negative and one-sided refspecs change the mapping in ways not modelled here.
    if (refspec.startsWith("^") || colon <= 0 || colon === refspec.length - 1)
      unsure("unsupported fetch refspec");
    const from = refspec.slice(0, colon);
    const to = refspec.slice(colon + 1);
    const fromStar = from.indexOf("*");
    const toStar = to.indexOf("*");
    if (fromStar === -1 && toStar === -1) {
      if (from === source) return to;
      continue;
    }
    if (
      fromStar === -1 ||
      toStar === -1 ||
      from.includes("*", fromStar + 1) ||
      to.includes("*", toStar + 1)
    )
      unsure("unsupported fetch refspec");
    const prefix = from.slice(0, fromStar);
    const suffix = from.slice(fromStar + 1);
    if (
      source.length >= prefix.length + suffix.length &&
      source.startsWith(prefix) &&
      source.endsWith(suffix)
    ) {
      const middle = source.slice(prefix.length, source.length - suffix.length);
      return `${to.slice(0, toStar)}${middle}${to.slice(toStar + 1)}`;
    }
  }
  return null;
}

/** `refs/remotes/origin/x` -> `origin/x`, only when nothing else could claim that short name. */
async function shortTrackingName(repo: Repository, ref: string): Promise<string> {
  if (!ref.startsWith("refs/remotes/")) unsure("upstream outside refs/remotes");
  // git shortens `refs/remotes/origin/HEAD` to `origin`, by a rule of its own.
  if (ref.endsWith("/HEAD")) unsure("upstream is a remote HEAD");
  const short = ref.slice("refs/remotes/".length);
  const rivals = [`refs/${short}`, `refs/tags/${short}`, `refs/heads/${short}`, `${ref}/HEAD`];
  const packed = await readPackedRefs(repo.commonDir);
  for (const rival of rivals) {
    if (!isSafeRefName(rival) || packed.has(rival)) unsure("ambiguous short name");
    if (await statOrNull(NodePath.join(repo.commonDir, ...rival.split("/"))))
      unsure("ambiguous short name");
  }
  for (const dir of new Set([repo.gitDir, repo.commonDir])) {
    if (await statOrNull(NodePath.join(dir, ...short.split("/")))) unsure("ambiguous short name");
  }
  return short;
}

interface Upstream {
  /** `origin/main` */
  readonly short: string;
  readonly remote: string;
  /** `refs/heads/main` on the remote. */
  readonly merge: string;
}

/** Configured upstream of a local branch, `null` when it has none. */
async function resolveUpstream(
  repo: Repository,
  config: ReadonlyArray<GitConfigEntry>,
  branch: string,
): Promise<Upstream | null> {
  const values = (name: string) =>
    config.filter(({ key }) => key === `branch.${branch}.${name}`).map(({ value }) => value);
  const remote = values("remote").at(-1);
  const merges = values("merge");
  if (remote === undefined && merges.length === 0) return null;
  // Half-configured, local (".") and multi-merge upstreams follow rules not modelled here.
  if (remote === undefined || remote === "." || merges.length !== 1) unsure("unusual upstream");
  const merge = merges[0]!;
  if (!isSafeRefName(merge)) unsure("unusual upstream");
  if (!config.some(({ key }) => key === `remote.${remote}.url`))
    unsure("upstream remote is not configured");
  const refspecs = config
    .filter(({ key }) => key === `remote.${remote}.fetch`)
    .map(({ value }) => value);
  const tracking =
    mapThroughFetchRefspecs(refspecs, merge) ?? unsure("upstream has no tracking ref");
  if ((await refState(repo, tracking)) === "missing") unsure("tracking ref is missing");
  return { short: await shortTrackingName(repo, tracking), remote: remote!, merge };
}

async function upstreamFields(
  repo: Repository,
  config: ReadonlyArray<GitConfigEntry>,
  ref: string,
): Promise<string> {
  const upstream = ref.startsWith("refs/heads/")
    ? await resolveUpstream(repo, config, ref.slice("refs/heads/".length))
    : null;
  return upstream ? `${upstream.short}\0${upstream.remote}\0${upstream.merge}` : "\0\0";
}

async function answerForEachRef(repo: Repository, args: ReadonlyArray<string>) {
  let rest = args;
  let count = Number.POSITIVE_INFINITY;
  if (rest[0] === "--count=1") {
    count = 1;
    rest = rest.slice(1);
  }
  const [format, ...patterns] = rest;
  if ((format !== REFNAME_FORMAT && format !== UPSTREAM_FORMAT) || patterns.length === 0)
    unsure("for-each-ref arguments");

  const namespaces = new Set<string>();
  for (const pattern of patterns) {
    const namespace = /^(refs\/(?:heads|remotes))(?:\/|$)/.exec(pattern)?.[1];
    namespaces.add(namespace ?? unsure("for-each-ref outside branches"));
  }
  const matchers = patterns.map(refPatternMatcher);
  const listed = await Promise.all(
    [...namespaces].map((namespace) => listBranchRefs(repo, namespace)),
  );
  const refs = listed
    .flat()
    .filter((ref) => matchers.some((matches) => matches(ref)))
    .toSorted(byteOrder)
    .slice(0, count);

  if (format === REFNAME_FORMAT) return ok(refs.map((ref) => `${ref}\n`).join(""));
  const config = await mergedConfig(repo);
  let stdout = "";
  for (const ref of refs) stdout += `${ref}\0${await upstreamFields(repo, config, ref)}\n`;
  return ok(stdout);
}

// ---------------------------------------------------------------------------
// rev-list counts
//
// Ahead/behind counts are a pure function of the two commits. Equal commits
// need no git at all; any other pair is answered from what git said last time
// for that same pair.

const REV_LIST_MEMO_CAPACITY = 512;
const revListMemo = new Map<string, string>();

/** A branch-like name -> object id, only when exactly one ref namespace knows it. */
async function resolveRevision(repo: Repository, name: string): Promise<string> {
  if (name === "HEAD") {
    const head = await readHead(repo);
    if (head.ref === null) return head.objectId;
    return (await refObjectId(repo, head.ref)) ?? unsure("unborn branch");
  }
  // Anything that could be an object id or revision syntax is git's to parse.
  if (/^[0-9a-f]{4,64}$/i.test(name) || !isSafeRefName(`refs/heads/${name}`)) unsure("revision");
  const candidates = [
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
  for (const dir of new Set([repo.gitDir, repo.commonDir])) {
    if (await statOrNull(NodePath.join(dir, ...name.split("/")))) unsure("ambiguous revision");
  }
  const found: Array<string> = [];
  for (const candidate of candidates) {
    const objectId = await refObjectId(repo, candidate).catch(() => unsure("ambiguous revision"));
    if (objectId !== null) found.push(objectId);
  }
  if (found.length !== 1) unsure("ambiguous or missing revision");
  return found[0]!;
}

interface RevListQuery {
  readonly key: string;
  readonly left: string;
  readonly right: string;
  readonly symmetric: boolean;
}

async function revListQuery(repo: Repository, args: ReadonlyArray<string>): Promise<RevListQuery> {
  const symmetric = sameArgs(args.slice(0, 2), ["--left-right", "--count"]) && args.length === 3;
  const range = symmetric
    ? args[2]!
    : sameArgs(args.slice(0, 1), ["--count"]) && args.length === 2
      ? args[1]!
      : unsure("rev-list arguments");
  const separator = symmetric ? "..." : "..";
  const at = range.indexOf(separator);
  if (
    at <= 0 ||
    range.indexOf("..", at + separator.length) !== -1 ||
    (!symmetric && range.includes("..."))
  )
    unsure("rev-list range");
  // Grafts, replacements and shallow boundaries change counts without changing the commits.
  for (const file of ["shallow", NodePath.join("info", "grafts")]) {
    if (await statOrNull(NodePath.join(repo.commonDir, file))) unsure("altered history");
  }
  const replacements = await NodeFSP.readdir(
    NodePath.join(repo.commonDir, "refs", "replace"),
  ).catch(() => []);
  const packed = await readPackedRefs(repo.commonDir);
  if (replacements.length > 0 || [...packed.keys()].some((ref) => ref.startsWith("refs/replace/")))
    unsure("altered history");

  const left = await resolveRevision(repo, range.slice(0, at));
  const right = await resolveRevision(repo, range.slice(at + separator.length));
  return { key: `${repo.commonDir}\0${separator}\0${left}\0${right}`, left, right, symmetric };
}

async function answerRevList(repo: Repository, args: ReadonlyArray<string>) {
  const query = await revListQuery(repo, args);
  if (query.left === query.right) return ok(query.symmetric ? "0\t0\n" : "0\n");
  return ok(revListMemo.get(query.key) ?? unsure("not seen before"));
}

async function answerConfigGet(repo: Repository, key: string) {
  const canonical = canonicalConfigKey(key) ?? unsure("config key");
  // Only keys that live in repository config in practice.
  if (!canonical.startsWith("branch.") && !canonical.startsWith("remote."))
    unsure("config section");
  const value = lastValue(await mergedConfig(repo), canonical);
  return value === undefined ? silentFailure : ok(`${value}\n`);
}

async function answer(input: GitFastPathInput): Promise<GitFastPathAnswer> {
  let args = input.args;
  let cwd = input.cwd;
  let explicitGitDir: string | null = null;
  if (args[0] === "-C" && args.length > 2) {
    cwd = NodePath.resolve(cwd, args[1]!);
    args = args.slice(2);
  }
  if (args[0] === "--git-dir" && args.length > 2) {
    explicitGitDir = NodePath.resolve(cwd, args[1]!);
    args = args.slice(2);
  }
  const [command, ...rest] = args;

  if (command === "rev-parse") {
    if (explicitGitDir) unsure("rev-parse with --git-dir");
    return answerRevParse(cwd, rest, input.env);
  }
  const repoCommand =
    command === "symbolic-ref" ||
    command === "remote" ||
    command === "show-ref" ||
    command === "for-each-ref" ||
    command === "rev-list" ||
    (command === "config" && rest.length === 2 && rest[0] === "--get");
  if (!repoCommand) unsure("unsupported command");

  // With --git-dir only commands that ignore the worktree are answered.
  const repo = explicitGitDir
    ? await openRepository(explicitGitDir, explicitGitDir, false)
    : (
        await discoverRepository(cwd).catch((error: unknown) =>
          // `git config` works outside a repository, from system and global config alone.
          error instanceof NotARepository && command === "config"
            ? unsure("config outside a repository")
            : Promise.reject(error),
        )
      ).repo;
  await requireGitAgrees(repo, explicitGitDir !== null);
  if (explicitGitDir && command === "symbolic-ref" && rest.includes("HEAD"))
    unsure("HEAD with --git-dir");

  if (command === "symbolic-ref") return answerSymbolicRef(repo, rest);
  if (command === "remote") return answerRemote(repo, rest);
  if (command === "config") return answerConfigGet(repo, rest[1]!);
  if (command === "for-each-ref") return answerForEachRef(repo, rest);
  if (command === "rev-list") return answerRevList(repo, rest);
  if (rest.length === 3 && rest[0] === "--verify" && rest[1] === "--quiet") {
    return (await refState(repo, rest[2]!)) === "exists" ? ok("") : silentFailure;
  }
  return unsure("show-ref arguments");
}

/**
 * Returns git's exact output for a supported read-only command, or `null` when
 * the caller has to spawn git. Never throws.
 */
export async function tryAnswerGitCommand(
  input: GitFastPathInput,
): Promise<GitFastPathAnswer | null> {
  if (!isGitFastPathEnabled() || !isGitFastPathEnabled(input.env ?? {})) return null;
  if (hasGitEnvOverride(process.env) || hasGitEnvOverride(input.env)) return null;
  if (movesGitOrItsConfig(input.env)) return null;
  // No budget at all: nothing may be answered, however fast the reads turn out.
  if (typeof input.timeoutMs === "number" && input.timeoutMs <= 0) return null;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Reads that take this long mean a stuck disk or share; git gets the question instead.
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, Math.min(ANSWER_TIMEOUT_MS, input.timeoutMs ?? Infinity), null);
    });
    // Asking for the outer config first proves git runs at all, so a missing git is not papered over.
    const answering = getOuterConfig().then(() => answer(input));
    // When the timer wins, the abandoned attempt still settles; its decline is not an error.
    answering.catch(() => undefined);
    const result = await Promise.race([answering, timedOut]);
    return result !== null &&
      Math.max(Buffer.byteLength(result.stdout), Buffer.byteLength(result.stderr)) > maxOutputBytes
      ? null
      : result;
  } catch (error) {
    return error instanceof NotARepository && !gitMessagesMayBeTranslated(input.env)
      ? { exitCode: 128, stdout: "", stderr: error.stderr }
      : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identifies a command whose answer depends only on commits that can be read
 * from the repository files, or `null`. Take it before spawning git and hand it
 * to `rememberGitAnswer` with git's output, so the same question is answered
 * without a process until one of those commits changes.
 */
export async function gitAnswerMemoKey(input: GitFastPathInput): Promise<string | null> {
  if (!isGitFastPathEnabled() || !isGitFastPathEnabled(input.env ?? {})) return null;
  if (hasGitEnvOverride(process.env) || hasGitEnvOverride(input.env)) return null;
  const [command, ...rest] = input.args;
  if (command !== "rev-list") return null;
  try {
    const { repo } = await discoverRepository(input.cwd);
    await requireGitAgrees(repo, false);
    return (await revListQuery(repo, rest)).key;
  } catch {
    return null;
  }
}

/** Stores git's output for `key` if the commits behind it did not move while git ran. */
export async function rememberGitAnswer(
  input: GitFastPathInput,
  key: string,
  stdout: string,
): Promise<void> {
  if (!/^\d+(?:\t\d+)?\n$/.test(stdout) || (await gitAnswerMemoKey(input)) !== key) return;
  if (revListMemo.size >= REV_LIST_MEMO_CAPACITY) revListMemo.clear();
  revListMemo.set(key, stdout);
}
