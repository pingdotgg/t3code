/**
 * fork: f4 — the commit drawer's read: body, files, stats and ref badges.
 *
 * Every commit-scoped read passes `--first-parent` so a merge commit shows a
 * meaningful file list instead of nothing, and refs are read through
 * `for-each-ref` with `%(*objectname)` so an annotated tag keys by the commit
 * it dereferences to rather than by its own tag object.
 */
import * as Effect from "effect/Effect";

import type {
  WorkingCopyChange,
  WorkingCopyCommitDetail,
  WorkingCopyCommitFile,
  WorkingCopyCommitRef,
  WorkingCopyError,
  WorkingCopyRefKind,
} from "@t3tools/contracts";
import * as commands from "./commands.ts";
import { parseNumstatZ } from "./porcelain.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

const OPERATION = "workingCopy.commitDetail";

function changeFromNameStatus(code: string): WorkingCopyChange {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

/**
 * `--name-status -z` emits `<code>\0<path>\0`, or `<code>\0<old>\0<new>\0` for
 * a rename or copy.
 */
export function parseNameStatusZ(stdout: string): ReadonlyArray<WorkingCopyCommitFile> {
  const fields = stdout.split("\0");
  const files: Array<WorkingCopyCommitFile> = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index]?.replace(/^\n+/, "");
    index += 1;
    if (code === undefined || code.length === 0) {
      continue;
    }
    const first = fields[index];
    index += 1;
    if (first === undefined || first.length === 0) {
      continue;
    }
    const change = changeFromNameStatus(code);
    if (change === "renamed" || change === "copied") {
      const second = fields[index];
      index += 1;
      if (second === undefined || second.length === 0) {
        files.push({ path: first, change });
        continue;
      }
      files.push({ path: second, change, oldPath: first });
      continue;
    }
    files.push({ path: first, change });
  }
  return files;
}

function refKind(refName: string): WorkingCopyRefKind {
  if (refName.startsWith("refs/tags/")) {
    return "tag";
  }
  if (refName.startsWith("refs/remotes/")) {
    return "remote";
  }
  return "branch";
}

export function parseCommitRefs(
  stdout: string,
): ReadonlyMap<string, ReadonlyArray<WorkingCopyCommitRef>> {
  const byHash = new Map<string, Array<WorkingCopyCommitRef>>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [objectName = "", dereferenced = "", short = "", full = ""] = line.split(
      commands.LOG_FIELD_SEPARATOR,
    );
    // An annotated tag's own object name is the tag object; the commit it
    // points at is `%(*objectname)`.
    const hash = dereferenced.length > 0 ? dereferenced : objectName;
    if (hash.length === 0 || short.length === 0) {
      continue;
    }
    const existing = byHash.get(hash) ?? [];
    existing.push({ name: short, kind: refKind(full) });
    byHash.set(hash, existing);
  }
  return byHash;
}

export const readCommitDetail = Effect.fn("workingCopy.readCommitDetail")(function* (
  git: WorkingCopyGit,
  hash: string,
): Effect.fn.Return<WorkingCopyCommitDetail, WorkingCopyError> {
  const validated = yield* commands.requireHashIsh(OPERATION, hash);

  const detail = yield* git.ok({
    operation: OPERATION,
    args: commands.commitDetailArgs(validated),
  });
  const record = detail.stdout.split(commands.LOG_RECORD_SEPARATOR)[0] ?? "";
  const fields = record.split(commands.LOG_FIELD_SEPARATOR);

  const nameStatus = yield* git.run({
    operation: OPERATION,
    args: commands.commitNameStatusArgs(validated),
  });
  const numstat = yield* git.run({
    operation: OPERATION,
    args: commands.commitNumstatArgs(validated),
  });

  const counts = new Map(
    (numstat.exitCode === 0 ? parseNumstatZ(numstat.stdout) : []).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const files = (nameStatus.exitCode === 0 ? parseNameStatusZ(nameStatus.stdout) : []).map(
    (file) => {
      const entry = counts.get(file.path);
      if (entry === undefined) {
        return file;
      }
      return {
        ...file,
        ...(entry.insertions !== undefined ? { insertions: entry.insertions } : {}),
        ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
      };
    },
  );

  const refsOutput = yield* git.run({ operation: OPERATION, args: commands.commitRefsArgs() });
  const refsByHash =
    refsOutput.exitCode === 0
      ? parseCommitRefs(refsOutput.stdout)
      : new Map<string, ReadonlyArray<WorkingCopyCommitRef>>();
  const head = yield* git.run({ operation: OPERATION, args: commands.headHashArgs() });
  const headHash = head.exitCode === 0 ? head.stdout.trim() : "";

  const fullHash = fields[0] ?? validated;
  const refs: Array<WorkingCopyCommitRef> = [];
  if (headHash.length > 0 && headHash === fullHash) {
    refs.push({ name: "HEAD", kind: "head" });
  }
  refs.push(...(refsByHash.get(fullHash) ?? []));

  return {
    hash: fullHash,
    shortHash: fields[1] ?? "",
    subject: fields[2] ?? "",
    authorName: fields[3] ?? "",
    authorEmail: fields[4] ?? "",
    authoredAt: fields[5] ?? "",
    parents: (fields[6] ?? "").split(" ").filter((parent) => parent.length > 0),
    body: (fields[7] ?? "").replace(/\n+$/, ""),
    files,
    insertions: files.reduce((total, file) => total + (file.insertions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    refs,
  };
});
