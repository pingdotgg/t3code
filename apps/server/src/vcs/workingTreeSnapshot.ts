// @effect-diagnostics nodeBuiltinImport:off - The snapshot shells out to git and copies files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

/** Path segments that are install trees. A named file under one of these stays out. */
const INSTALL_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
]);

export async function copyWorkingTreeSnapshot(input: {
  readonly parentCwd: string;
  readonly childCwd: string;
  readonly brief: string;
}): Promise<void> {
  const parent = NodePath.resolve(input.parentCwd);
  const child = NodePath.resolve(input.childCwd);
  if (parent === child) return;
  const quiet = await gitExit(parent, ["diff", "--quiet", "HEAD"]);
  if (quiet === 1) {
    await pipeGit(
      ["-C", parent, "diff", "--binary", "--full-index", "HEAD"],
      ["-C", child, "apply", "--whitespace=nowarn", "-"],
    );
  } else if (quiet !== 0) {
    throw new Error("git diff --quiet HEAD failed");
  }
  const status = await gitStdout(parent, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  for (const rel of untrackedPaths(status)) {
    if (hasInstallSegment(rel) || !namedInBrief(rel, input.brief)) continue;
    await copyRel(parent, child, rel);
  }
}

function hasInstallSegment(rel: string): boolean {
  return rel.split("/").some((segment) => INSTALL_SEGMENTS.has(segment));
}

/** True when the brief names this path, or a directory that contains it, as its own token. */
export function namedInBrief(rel: string, brief: string): boolean {
  if (brief.length === 0 || rel.length === 0) return false;
  const tokens = [rel];
  const slash = rel.lastIndexOf("/");
  if (slash > 0) tokens.push(rel.slice(0, slash + 1));
  return tokens.some((token) => hasToken(brief, token));
}

function hasToken(brief: string, token: string): boolean {
  let from = 0;
  while (from < brief.length) {
    const at = brief.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : brief.charAt(at - 1);
    const after = brief.charAt(at + token.length);
    if (isBoundary(before) && isBoundary(after)) return true;
    from = at + token.length;
  }
  return false;
}

function isBoundary(ch: string): boolean {
  return ch === "" || ch === "/" || /[\s"'`()[\]{}<>|,]/.test(ch);
}

export function untrackedPaths(status: string): string[] {
  const paths: string[] = [];
  for (const entry of status.split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    const rel = entry.slice(3);
    if (rel.length === 0 || rel.split("/").includes("..")) continue;
    paths.push(rel);
  }
  return paths;
}

async function copyRel(parent: string, child: string, rel: string): Promise<void> {
  const from = NodePath.resolve(parent, rel);
  const to = NodePath.resolve(child, rel);
  if (!inside(parent, from) || !inside(child, to)) {
    throw new Error(`Refusing to copy ${rel} outside the checkout.`);
  }
  await NodeFS.mkdir(NodePath.dirname(to), { recursive: true });
  await NodeFS.cp(from, to, { verbatimSymlinks: true, force: true });
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + NodePath.sep);
}

function gitExit(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", ["-C", cwd, ...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function gitStdout(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `git ${args[0]} failed`));
    });
  });
}

function pipeGit(source: string[], sink: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const producer = NodeChildProcess.spawn("git", source, { stdio: ["ignore", "pipe", "pipe"] });
    const consumer = NodeChildProcess.spawn("git", sink, { stdio: ["pipe", "pipe", "pipe"] });
    const errors: string[] = [];
    producer.stderr.on("data", (chunk) => errors.push(String(chunk)));
    consumer.stderr.on("data", (chunk) => errors.push(String(chunk)));
    producer.stdout.pipe(consumer.stdin);
    producer.on("error", reject);
    consumer.on("error", reject);
    let producerCode = 0;
    let consumerCode: number | null = null;
    const finish = () => {
      if (consumerCode === null) return;
      if (producerCode === 0 && consumerCode === 0) resolve();
      else reject(new Error(errors.join("").trim() || "git apply failed"));
    };
    producer.on("close", (code) => {
      producerCode = code ?? 1;
      finish();
    });
    consumer.on("close", (code) => {
      consumerCode = code ?? 1;
      finish();
    });
  });
}
