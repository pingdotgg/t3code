import { reportSteps, type ProgressReporter } from "./WorkflowProgress.ts";
import type { GitWorkflowStep } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  GitManagerError,
  type GitStackStatusResult,
  type GitStackManageInput,
} from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const LayerState = Schema.Struct({
  branch: Schema.String,
  parentHead: Schema.String,
  remoteHead: Schema.NullOr(Schema.String),
});
const StackState = Schema.Struct({
  base: Schema.String,
  baseRef: Schema.String,
  remote: Schema.String,
  layers: Schema.Array(LayerState),
});
const SavedState = Schema.Array(StackState);
const Journal = Schema.Struct({
  stack: StackState,
  originalBranch: Schema.String,
  cwd: Schema.String,
  index: Schema.Number,
  phase: Schema.Literals(["rebase", "push", "hooks"]),
  pushedBranches: Schema.optional(Schema.Array(Schema.String)),
  hookIndex: Schema.optional(Schema.Number),
  hookCwd: Schema.optional(Schema.String),
  originalHeads: Schema.Record(Schema.String, Schema.String),
  installedHeads: Schema.Record(Schema.String, Schema.String),
  expectedRemoteHeads: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  targetBase: Schema.String,
});
const isManagerError = Schema.is(GitManagerError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
type Stack = typeof StackState.Type;
type Operation = typeof Journal.Type;
type AfterPush = (cwd: string, branch: string) => Effect.Effect<void, GitManagerError>;
interface UpdateOptions {
  readonly includeLatestBase?: boolean | undefined;
  readonly mergedBranches?: readonly string[];
  readonly report?: (branch: string) => Effect.Effect<void>;
  readonly afterPush?: AfterPush;
  readonly onProgress?: ProgressReporter;
}
const GlabRef = Schema.Struct({
  prev: Schema.String,
  next: Schema.String,
  sha: Schema.String,
  branch: Schema.String,
});

function stackProgress(
  journal: Pick<Operation, "stack" | "index" | "phase" | "pushedBranches" | "hookIndex">,
): GitWorkflowStep[] {
  return journal.stack.layers.flatMap((layer, index) => [
    {
      id: `${layer.branch}:rebase`,
      group: layer.branch,
      label: "Rebase",
      state: index < journal.index ? "completed" : "pending",
    },
    {
      id: `${layer.branch}:push`,
      group: layer.branch,
      label: "Push",
      state:
        journal.phase === "hooks"
          ? journal.pushedBranches?.includes(layer.branch)
            ? "completed"
            : "skipped"
          : "pending",
    },
    {
      id: `${layer.branch}:hooks`,
      group: layer.branch,
      label: "Post-push hooks",
      state:
        journal.phase === "hooks"
          ? !journal.pushedBranches?.includes(layer.branch)
            ? "skipped"
            : journal.pushedBranches.indexOf(layer.branch) < (journal.hookIndex ?? 0)
              ? "completed"
              : "pending"
          : "pending",
    },
  ]);
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const failure = (cwd: string, detail: string, cause?: unknown) =>
    new GitManagerError({
      operation: "stack",
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const git = Effect.fn("BranchStack.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    allowNonZeroExit = false,
  ) {
    return yield* process
      .run({
        operation: "BranchStack.git",
        command: "git",
        args,
        cwd,
        allowNonZeroExit,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
        timeoutMs: 10 * 60_000,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            cwd,
            "The stack Git operation failed. Check the checkout and remote connection before retrying.",
            cause,
          ),
        ),
      );
  });
  const text = Effect.fn("BranchStack.text")(function* (cwd: string, args: ReadonlyArray<string>) {
    return (yield* git(cwd, args)).stdout.trim();
  });
  const config = Effect.fn("BranchStack.config")(function* (cwd: string, key: string) {
    const result = yield* git(cwd, ["config", "--get", key], true);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  });
  const common = Effect.fn("BranchStack.common")(function* (cwd: string) {
    return yield* text(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  });
  const read = Effect.fn("BranchStack.read")(function* <S extends Schema.Top>(
    cwd: string,
    filename: string,
    schema: S,
  ) {
    if (!(yield* fs.exists(filename))) return null;
    return yield* fs.readFileString(filename).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.mapError((cause) =>
        failure(cwd, "Stack metadata could not be read. It has been left unchanged.", cause),
      ),
    );
  });
  const write = Effect.fn("BranchStack.write")(function* (
    cwd: string,
    filename: string,
    value: unknown,
  ) {
    const encoded = yield* encodeJson(value).pipe(
      Effect.mapError((cause) => failure(cwd, "Stack metadata could not be encoded.", cause)),
    );
    yield* fs.writeFileString(`${filename}.tmp`, encoded).pipe(
      Effect.andThen(fs.rename(`${filename}.tmp`, filename)),
      Effect.mapError((cause) => failure(cwd, "Stack metadata could not be saved.", cause)),
    );
  });
  const paths = Effect.fn("BranchStack.paths")(function* (cwd: string) {
    const dir = yield* common(cwd);
    return {
      state: path.join(dir, "t3-branch-stacks.json"),
      journal: path.join(dir, "t3-stack-operation.json"),
      dir,
    };
  });
  const head = (cwd: string, branch: string) =>
    text(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const isAncestor = Effect.fn("BranchStack.isAncestor")(function* (
    cwd: string,
    a: string,
    b: string,
  ) {
    return (yield* git(cwd, ["merge-base", "--is-ancestor", a, b], true)).exitCode === 0;
  });
  const worktrees = Effect.fn("BranchStack.worktrees")(function* (cwd: string) {
    const output = yield* text(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const result = new Map<string, string>();
    let owner = "";
    for (const field of output.split("\0")) {
      if (field.startsWith("worktree ")) owner = field.slice(9);
      if (field.startsWith("branch refs/heads/")) result.set(field.slice(18), owner);
    }
    return result;
  });
  const defaults = Effect.fn("BranchStack.defaults")(function* (cwd: string, branch: string) {
    const remote =
      (yield* config(cwd, `branch.${branch}.pushRemote`)) ??
      (yield* config(cwd, "remote.pushDefault")) ??
      (yield* config(cwd, `branch.${branch}.remote`)) ??
      "origin";
    const baseRemote = (yield* config(cwd, "t3.stackBaseRemote")) ?? "origin";
    const symbolic = yield* git(
      cwd,
      ["symbolic-ref", "--quiet", `refs/remotes/${baseRemote}/HEAD`],
      true,
    );
    const base =
      symbolic.exitCode === 0
        ? symbolic.stdout.trim().replace(`refs/remotes/${baseRemote}/`, "")
        : (yield* git(cwd, ["show-ref", "--verify", "--quiet", "refs/heads/main"], true))
              .exitCode === 0
          ? "main"
          : "master";
    return { remote, base, baseRemote };
  });
  const discover = Effect.fn("BranchStack.discover")(function* (
    cwd: string,
    branch: string,
    dir: string,
    base: string,
    baseRemote: string,
  ) {
    const stacked = path.join(dir, "stacked");
    if (yield* fs.exists(stacked)) {
      const names = yield* fs
        .readDirectory(stacked)
        .pipe(
          Effect.mapError((cause) => failure(cwd, "Could not inspect glab stack metadata.", cause)),
        );
      for (const name of names.slice(0, 100)) {
        const root = path.join(stacked, name);
        if ((yield* fs.stat(root)).type !== "Directory") continue;
        const files = yield* fs.readDirectory(root);
        const refs = [];
        for (const file of files.filter((name) => name.endsWith(".json")).slice(0, 50)) {
          const ref = yield* read(cwd, path.join(root, file), GlabRef);
          if (ref) refs.push(ref);
        }
        if (!refs.some((ref) => ref.branch === branch)) continue;
        const ordered: string[] = [];
        let next = refs.find((ref) => ref.prev === "");
        while (next && !ordered.includes(next.branch)) {
          ordered.push(next.branch);
          const id = next.next;
          next = refs.find((ref) => ref.sha === id);
        }
        if (ordered.length !== refs.length)
          return yield* failure(cwd, "The glab stack has inconsistent layer ordering.");
        const savedBase = path.join(root, "BASE_BRANCH");
        return {
          base: (yield* fs.exists(savedBase)) ? (yield* fs.readFileString(savedBase)).trim() : base,
          branches: ordered,
        };
      }
    }
    if (!branch || branch === base) return { base, branches: [] };
    const refs = (yield* text(cwd, [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    ]))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "));
    const branches = refs.map(([name]) => name!).filter((name) => name !== base);
    const namesByHead = new Map<string, string[]>();
    for (const [name, sha] of refs) {
      if (name === base || !sha) continue;
      namesByHead.set(sha, [...(namesByHead.get(sha) ?? []), name!]);
    }
    const parents = new Map<string, string>();
    const configured = yield* git(
      cwd,
      ["config", "--get-regexp", "^branch\\..*\\.(t3-merge-base|gh-merge-base)$"],
      true,
    );
    for (const line of configured.stdout.trim().split("\n")) {
      const match = /^branch\.(.*)\.(t3-merge-base|gh-merge-base)\s+(.*)$/.exec(line);
      if (match && (match[2] === "t3-merge-base" || !parents.has(match[1]!)))
        parents.set(match[1]!, match[3]!.replace(/^refs\/heads\//, ""));
    }
    const history = yield* git(
      cwd,
      [
        "rev-list",
        "--first-parent",
        "--parents",
        "--branches",
        "--not",
        refs.some(([name]) => name === base) ? base : `${baseRemote}/${base}`,
      ],
      true,
    );
    if (history.exitCode === 0) {
      const previous = new Map(
        history.stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [sha, parent] = line.split(" ");
            return [sha!, parent] as const;
          }),
      );
      for (const [name, sha] of refs) {
        if (
          name === base ||
          (parents.has(name!) &&
            branches.includes(parents.get(name!)!) &&
            parents.get(name!) !== base)
        )
          continue;
        let ancestor = previous.get(sha!);
        while (ancestor) {
          const candidates = namesByHead.get(ancestor);
          if (candidates) {
            if (candidates.length === 1) parents.set(name!, candidates[0]!);
            break;
          }
          ancestor = previous.get(ancestor);
        }
      }
    }
    const ordered = [branch];
    while (parents.has(ordered[0]!)) {
      const parent = parents.get(ordered[0]!)!;
      if (parent === base || !branches.includes(parent) || ordered.includes(parent)) break;
      ordered.unshift(parent);
    }
    while (true) {
      const children = branches.filter((name) => parents.get(name) === ordered.at(-1));
      if (children.length !== 1 || ordered.includes(children[0]!)) break;
      ordered.push(children[0]!);
    }
    return { base, branches: ordered };
  });
  const inspect = Effect.fn("BranchStack.inspect")(
    function* (cwd: string, includeCandidates = true) {
      const files = yield* paths(cwd);
      const branchResult = yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const branch = branchResult.stdout.trim();
      const saved = (yield* read(cwd, files.state, SavedState)) ?? [];
      const journal = yield* read(cwd, files.journal, Journal);
      const active =
        journal?.stack ??
        saved.find((stack) => stack.layers.some((layer) => layer.branch === branch));
      if (!active && !includeCandidates)
        return {
          managed: false,
          baseIsDefault: false,
          base: "",
          remote: "",
          layers: [] as GitStackStatusResult["layers"],
          operation: null,
        };
      const settings = yield* defaults(cwd, branch);
      const candidate = active
        ? null
        : includeCandidates
          ? yield* discover(cwd, branch, files.dir, settings.base, settings.baseRemote)
          : { base: settings.base, branches: [] as string[] };
      const base = active?.base ?? candidate!.base;
      const branches =
        active?.layers.map((layer) => layer.branch) ?? candidate!.branches.filter(Boolean);
      const owners = yield* worktrees(cwd);
      const layers: GitStackStatusResult["layers"][number][] = [];
      for (const [index, name] of branches.entries()) {
        const parent = branches[index - 1] ?? base;
        const parentRef =
          index === 0 ? (active?.baseRef ?? `refs/heads/${base}`) : `refs/heads/${parent}`;
        const target = yield* git(cwd, ["rev-parse", "--verify", `${parentRef}^{commit}`], true);
        layers.push({
          branch: name,
          parent,
          headSha: yield* head(cwd, name),
          current: name === branch,
          needsRestack:
            !!active &&
            target.exitCode === 0 &&
            active.layers[index]!.parentHead !== target.stdout.trim(),
          worktreePath: owners.get(name) ?? null,
          hasChanges:
            !!active && owners.has(name)
              ? (yield* text(owners.get(name)!, ["status", "--porcelain"])) !== ""
              : false,
          pullRequest: null,
        });
      }
      return {
        managed: active !== undefined,
        baseIsDefault: base === settings.base,
        base,
        remote: active?.remote ?? settings.remote,
        layers,
        operation: journal
          ? {
              branch:
                journal.phase === "hooks"
                  ? (journal.pushedBranches?.[journal.hookIndex ?? 0] ?? journal.originalBranch)
                  : (journal.stack.layers[journal.index]?.branch ?? journal.originalBranch),
              cwd: journal.cwd,
              phase: journal.phase,
            }
          : null,
      };
    },
    (effect, cwd: string, _includeCandidates?: boolean) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : failure(cwd, "Stack metadata could not be accessed.", cause),
        ),
      ),
  );
  const saveStack = Effect.fn("BranchStack.saveStack")(function* (
    cwd: string,
    stack: Stack,
    oldBranches: readonly string[],
  ) {
    const files = yield* paths(cwd);
    const saved = (yield* read(cwd, files.state, SavedState)) ?? [];
    yield* write(cwd, files.state, [
      ...saved.filter((item) => !item.layers.some((layer) => oldBranches.includes(layer.branch))),
      stack,
    ]);
  });
  const remoteHeads = Effect.fn("BranchStack.remoteHeads")(function* (
    cwd: string,
    remote: string,
    branches: readonly string[],
  ) {
    const output = yield* text(cwd, [
      "ls-remote",
      "--heads",
      remote,
      ...branches.map((branch) => `refs/heads/${branch}`),
    ]);
    const found = new Map(
      output
        .split("\n")
        .map((line) => line.split(/\s+/))
        .filter((entry) => entry.length === 2)
        .map(([sha, ref]) => [ref!, sha!]),
    );
    return Object.fromEntries(
      branches.map((branch) => [branch, found.get(`refs/heads/${branch}`) ?? null]),
    );
  });
  const assertClean = Effect.fn("BranchStack.assertClean")(function* (cwd: string) {
    if ((yield* text(cwd, ["status", "--porcelain"])) !== "")
      return yield* failure(cwd, "Commit or stash changes before updating the stack.");
  });
  const assertIdle = Effect.fn("BranchStack.assertIdle")(
    function* (cwd: string, checkGitOperation = true) {
      const files = yield* paths(cwd);
      if (yield* fs.exists(files.journal))
        return yield* failure(
          cwd,
          "A stack operation is paused. Continue or abort it from the sidebar first.",
        );
      for (const marker of checkGitOperation
        ? ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]
        : []) {
        const filename = yield* text(cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          marker,
        ]);
        if (yield* fs.exists(filename))
          return yield* failure(cwd, "Finish the current Git operation before updating the stack.");
      }
    },
    (effect, cwd: string, _checkGitOperation?: boolean) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : failure(cwd, "Stack metadata could not be accessed.", cause),
        ),
      ),
  );
  const run = Effect.fn("BranchStack.run")(function* (
    cwd: string,
    operation: Operation,
    report?: (branch: string) => Effect.Effect<void>,
    afterPush?: AfterPush,
    onProgress?: ProgressReporter,
  ) {
    const files = yield* paths(cwd);
    let journal = operation;
    const oldBranches = Object.keys(journal.originalHeads);
    const progress = reportSteps(onProgress, stackProgress(journal));
    const step = (id: string, state: GitWorkflowStep["state"], label: string) =>
      progress(label, (steps) => steps.map((item) => (item.id === id ? { ...item, state } : item)));
    yield* progress("Preparing stack...");

    while (journal.index < journal.stack.layers.length) {
      const index = journal.index;
      const layer = journal.stack.layers[index]!;
      if (report) yield* report(`Restacking ${layer.branch}...`);
      yield* step(`${layer.branch}:rebase`, "running", `Restacking ${layer.branch}...`);
      const parent =
        index === 0
          ? journal.targetBase
          : yield* head(cwd, journal.stack.layers[index - 1]!.branch);
      const current = yield* head(cwd, layer.branch);
      if (journal.installedHeads[layer.branch] !== current)
        return yield* failure(
          cwd,
          `Branch ${layer.branch} changed during the stack operation. Recovery metadata has been kept.`,
        );
      yield* write(cwd, files.journal, journal);
      yield* git(cwd, ["checkout", "--quiet", layer.branch]);
      const remoteHead = journal.expectedRemoteHeads[layer.branch];
      if (remoteHead && remoteHead !== current && (yield* isAncestor(cwd, current, remoteHead))) {
        yield* git(cwd, ["merge", "--ff-only", remoteHead]);
        journal = Object.assign({}, journal, {
          installedHeads: Object.assign({}, journal.installedHeads, { [layer.branch]: remoteHead }),
        });
        yield* write(cwd, files.journal, journal);
      }
      if (layer.parentHead !== parent) {
        const rebase = yield* git(cwd, ["rebase", "--onto", parent, layer.parentHead], true);
        if (rebase.exitCode !== 0)
          return yield* failure(
            cwd,
            `Stack update stopped at ${layer.branch}. Resolve its conflicts, then Continue or Abort in the sidebar.`,
          );
      }
      const newHead = yield* head(cwd, layer.branch);
      journal = Object.assign({}, journal, {
        index: index + 1,
        installedHeads: { ...journal.installedHeads, [layer.branch]: newHead },
        stack: {
          ...journal.stack,
          layers: journal.stack.layers.map((item, i) =>
            i === index ? { ...item, parentHead: parent } : item,
          ),
        },
      });
      yield* write(cwd, files.journal, journal);
      yield* step(`${layer.branch}:rebase`, "completed", `Restacked ${layer.branch}`);
    }
    if (journal.phase !== "hooks") {
      const branches = journal.stack.layers.map((layer) => layer.branch);
      journal = Object.assign({}, journal, {
        phase: "push" as const,
        pushedBranches:
          journal.pushedBranches ??
          branches.filter(
            (branch) => journal.expectedRemoteHeads[branch] !== journal.installedHeads[branch],
          ),
        hookIndex: journal.hookIndex ?? 0,
      });
      yield* write(cwd, files.journal, journal);
      yield* git(cwd, ["checkout", "--quiet", journal.originalBranch]);
      if (report) yield* report("Pushing stack...");
      yield* progress("Pushing stack...", (steps) =>
        steps.map((item) =>
          item.id.endsWith(":push")
            ? {
                ...item,
                state: journal.pushedBranches?.includes(item.group) ? "running" : "skipped",
              }
            : item,
        ),
      );
      const published = yield* remoteHeads(cwd, journal.stack.remote, branches);
      if (!branches.every((branch) => published[branch] === journal.installedHeads[branch])) {
        yield* git(cwd, [
          "push",
          "--atomic",
          ...branches.map(
            (branch) =>
              `--force-with-lease=refs/heads/${branch}:${journal.expectedRemoteHeads[branch] ?? ""}`,
          ),
          journal.stack.remote,
          ...branches.map((branch) => `${journal.installedHeads[branch]}:refs/heads/${branch}`),
        ]);
      }
      for (const branch of branches) {
        yield* git(cwd, [
          "update-ref",
          `refs/remotes/${journal.stack.remote}/${branch}`,
          journal.installedHeads[branch]!,
        ]);
        yield* git(cwd, ["branch", `--set-upstream-to=${journal.stack.remote}/${branch}`, branch]);
      }
      yield* progress("Stack published", (steps) =>
        steps.map((item) =>
          item.id.endsWith(":push")
            ? {
                ...item,
                state: journal.pushedBranches?.includes(item.group) ? "completed" : "skipped",
              }
            : item.id.endsWith(":hooks") && !journal.pushedBranches?.includes(item.group)
              ? { ...item, state: "skipped" }
              : item,
        ),
      );
      journal = Object.assign({}, journal, { phase: "hooks" as const });
      yield* write(cwd, files.journal, journal);
    }
    const hooks = Effect.gen(function* () {
      const branches = journal.pushedBranches ?? [];
      while ((journal.hookIndex ?? 0) < branches.length) {
        const index = journal.hookIndex ?? 0;
        const branch = branches[index]!;
        yield* assertClean(cwd);
        yield* git(cwd, ["checkout", "--quiet", branch]);
        if (report) yield* report(`Running post-push hooks for ${branch}...`);
        yield* step(`${branch}:hooks`, "running", `Running post-push hooks for ${branch}...`);
        const layerIndex = journal.stack.layers.findIndex((layer) => layer.branch === branch);
        const parent = journal.stack.layers[layerIndex - 1]?.branch ?? journal.stack.base;
        yield* git(cwd, ["config", `branch.${branch}.t3-merge-base`, parent]);
        if (afterPush) yield* afterPush(journal.hookCwd ?? cwd, branch);
        journal = Object.assign({}, journal, { hookIndex: index + 1 });
        yield* step(`${branch}:hooks`, "completed", `Finished ${branch}`);
        yield* write(cwd, files.journal, journal);
      }
      yield* assertClean(cwd);
      yield* git(cwd, ["checkout", "--quiet", journal.originalBranch]);
    });
    yield* hooks.pipe(
      Effect.onError(() =>
        assertClean(cwd).pipe(
          Effect.andThen(git(cwd, ["checkout", "--quiet", journal.originalBranch])),
          Effect.ignore,
        ),
      ),
    );
    const stack = {
      ...journal.stack,
      layers: journal.stack.layers.map((layer) => ({
        ...layer,
        remoteHead: journal.installedHeads[layer.branch]!,
      })),
    };
    yield* saveStack(cwd, stack, oldBranches);
    yield* fs
      .remove(files.journal)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            cwd,
            "The stack was pushed, but its recovery journal could not be removed.",
            cause,
          ),
        ),
      );
    return yield* inspect(cwd);
  });
  const update = Effect.fn("BranchStack.update")(
    function* (cwd: string, options: UpdateOptions = {}) {
      yield* assertIdle(cwd);
      yield* assertClean(cwd);
      const files = yield* paths(cwd);
      const branch = yield* text(cwd, ["symbolic-ref", "--short", "HEAD"]);
      const all = (yield* read(cwd, files.state, SavedState)) ?? [];
      const saved = all.find((stack) => stack.layers.some((layer) => layer.branch === branch));
      if (!saved) return yield* failure(cwd, "Adopt this branch stack before updating it.");
      if (options.onProgress)
        yield* options.onProgress({
          label: "Checking stack branches...",
          steps: stackProgress({ stack: saved, index: 0, phase: "rebase" }),
        });
      let first = 0;
      while (
        first < saved.layers.length &&
        options.mergedBranches?.includes(saved.layers[first]!.branch)
      )
        first++;
      if (first === saved.layers.length)
        return yield* failure(
          cwd,
          "Every layer has merged. Untrack this completed stack from the sidebar.",
        );
      const layers = saved.layers.slice(first);
      const root = yield* text(cwd, ["rev-parse", "--show-toplevel"]);
      const owners = yield* worktrees(cwd);
      for (const layer of layers) {
        const owner = owners.get(layer.branch);
        if (owner && owner !== root)
          return yield* failure(
            cwd,
            `Stack branch ${layer.branch} is checked out at ${owner}. Move that checkout off the branch before restacking.`,
          );
      }
      const remote = yield* remoteHeads(
        cwd,
        saved.remote,
        layers.map((layer) => layer.branch),
      );
      for (const layer of layers) {
        const remoteHead = remote[layer.branch];
        const localHead = yield* head(cwd, layer.branch);
        if (remoteHead && remoteHead !== localHead) {
          yield* git(cwd, [
            "fetch",
            "--no-tags",
            saved.remote,
            `+refs/heads/${layer.branch}:refs/remotes/${saved.remote}/${layer.branch}`,
          ]);
          const fetched = yield* text(cwd, [
            "rev-parse",
            `refs/remotes/${saved.remote}/${layer.branch}`,
          ]);
          if (fetched !== remoteHead)
            return yield* failure(
              cwd,
              `Remote branch ${layer.branch} moved while fetching. Retry the stack update.`,
            );
        }
        if (
          remoteHead !== layer.remoteHead &&
          remoteHead !== localHead &&
          !(remoteHead && (yield* isAncestor(cwd, localHead, remoteHead)))
        ) {
          return yield* failure(
            cwd,
            `Remote branch ${layer.branch} changed since the last stack sync. Fetch and reconcile it before retrying.`,
          );
        }
      }

      let targetBase = layers[0]!.parentHead;
      if (options.includeLatestBase || first > 0) {
        if (saved.baseRef.startsWith("refs/remotes/")) {
          const ref = saved.baseRef.slice(13);
          const slash = ref.indexOf("/");
          yield* git(cwd, [
            "fetch",
            "--no-tags",
            ref.slice(0, slash),
            `+refs/heads/${ref.slice(slash + 1)}:${saved.baseRef}`,
          ]);
        }
        targetBase = yield* text(cwd, ["rev-parse", "--verify", `${saved.baseRef}^{commit}`]);
      }
      const originalHeads: Record<string, string> = {};
      for (const layer of saved.layers)
        originalHeads[layer.branch] = yield* head(cwd, layer.branch);
      const journal: Operation = {
        cwd: root,
        originalBranch: branch,
        stack: { ...saved, layers },
        index: 0,
        phase: "rebase",
        originalHeads,
        installedHeads: originalHeads,
        expectedRemoteHeads: remote,
        targetBase,
        hookCwd: cwd,
      };
      const stamp = yield* text(cwd, ["rev-parse", "HEAD"]);
      for (const [index, sha] of Object.values(originalHeads).entries())
        yield* git(cwd, ["update-ref", `refs/t3/stack-backup/${stamp}/${index}`, sha]);
      const encoded = yield* encodeJson(journal);
      yield* fs.writeFileString(files.journal, encoded, { flag: "wx", mode: 0o600 });
      return yield* run(cwd, journal, options.report, options.afterPush, options.onProgress);
    },
    (effect, cwd: string, _options?: UpdateOptions) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : failure(cwd, "Stack metadata could not be accessed.", cause),
        ),
      ),
  );
  const manage = Effect.fn("BranchStack.manage")(
    function* (
      input: GitStackManageInput,
      mergedBranches: readonly string[] = [],
      afterPush?: AfterPush,
      onProgress?: ProgressReporter,
    ) {
      const { cwd } = input;
      const files = yield* paths(cwd);
      if (input.expectedBranch !== undefined) {
        const current =
          (yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)).stdout.trim() ||
          null;
        if (current !== input.expectedBranch)
          return yield* failure(cwd, "The checkout changed. Refresh the stack before retrying.");
      }
      const pending = yield* read(cwd, files.journal, Journal);
      if (input.action === "continue" || input.action === "abort") {
        if (!pending) return yield* failure(cwd, "There is no paused stack operation.");
        if (pending.cwd !== (yield* text(cwd, ["rev-parse", "--show-toplevel"])))
          return yield* failure(cwd, `Resume this stack operation from ${pending.cwd}.`);
        if (input.action === "abort") {
          const rebasePath = yield* text(cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "rebase-merge",
          ]);
          if (yield* fs.exists(rebasePath)) yield* git(cwd, ["rebase", "--abort"]);
          yield* assertClean(cwd);
          const current = yield* text(cwd, ["symbolic-ref", "--short", "HEAD"]);
          for (const [branch, sha] of Object.entries(pending.originalHeads)) {
            const actual = yield* head(cwd, branch);
            if (actual !== sha && actual !== pending.installedHeads[branch])
              return yield* failure(
                cwd,
                `Branch ${branch} changed since the stack paused. Recovery metadata has been kept.`,
              );
          }
          for (const [branch, sha] of Object.entries(pending.originalHeads)) {
            const actual = yield* head(cwd, branch);
            if (actual !== sha && actual !== pending.installedHeads[branch])
              return yield* failure(
                cwd,
                `Branch ${branch} changed since the stack paused. Recovery metadata has been kept.`,
              );
            if (branch === current) yield* git(cwd, ["reset", "--keep", sha]);
            else yield* git(cwd, ["update-ref", `refs/heads/${branch}`, sha, actual]);
          }
          yield* git(cwd, ["checkout", "--quiet", pending.originalBranch]);
          yield* fs.remove(files.journal);
          return yield* inspect(cwd);
        }
        let resumed = pending;
        if (pending.phase === "rebase" && pending.index < pending.stack.layers.length) {
          const rebasePath = yield* text(cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "rebase-merge",
          ]);
          if (yield* fs.exists(rebasePath)) {
            const branch = pending.stack.layers[pending.index]!.branch;
            if (onProgress)
              yield* onProgress({
                label: `Continuing rebase of ${branch}...`,
                steps: stackProgress(pending).map((step) =>
                  step.id === `${branch}:rebase` ? { ...step, state: "running" } : step,
                ),
              });
            const continued = yield* git(cwd, ["rebase", "--continue"], true);
            if (continued.exitCode !== 0)
              return yield* failure(
                cwd,
                "Conflicts remain. Resolve and stage them before continuing.",
              );
            const layer = pending.stack.layers[pending.index]!;
            const parent =
              pending.index === 0
                ? pending.targetBase
                : yield* head(cwd, pending.stack.layers[pending.index - 1]!.branch);
            resumed = {
              ...pending,
              index: pending.index + 1,
              installedHeads: {
                ...pending.installedHeads,
                [layer.branch]: yield* head(cwd, layer.branch),
              },
              stack: {
                ...pending.stack,
                layers: pending.stack.layers.map((item, i) =>
                  i === pending.index ? { ...item, parentHead: parent } : item,
                ),
              },
            };
            yield* write(cwd, files.journal, resumed);
          }
        }
        return yield* run(cwd, resumed, undefined, afterPush, onProgress);
      }
      yield* assertIdle(cwd);
      if (input.action === "update")
        return yield* update(cwd, {
          includeLatestBase: input.includeLatestBase,
          mergedBranches,
          ...(afterPush ? { afterPush } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
      const status = yield* inspect(cwd);
      if (input.action === "untrack") {
        for (const layer of status.layers)
          yield* git(cwd, ["config", `branch.${layer.branch}.t3-stack-disabled`, "true"]);
        const all = (yield* read(cwd, files.state, SavedState)) ?? [];
        yield* write(
          cwd,
          files.state,
          all.filter(
            (stack) =>
              !stack.layers.some((layer) =>
                status.layers.some((item) => item.branch === layer.branch),
              ),
          ),
        );
        return yield* inspect(cwd);
      }
      yield* assertIdle(cwd);
      if (input.action === "edit" && !status.managed)
        return yield* failure(cwd, "Adopt this branch stack before editing its layers.");
      const branches = input.branches ?? status.layers.map((layer) => layer.branch);
      const base = input.base ?? status.base;
      const currentBranch = yield* text(cwd, ["symbolic-ref", "--short", "HEAD"]);
      if (!branches.includes(currentBranch))
        return yield* failure(cwd, "Include the checked-out branch in the adopted stack.");
      if (
        branches.length === 0 ||
        new Set(branches).size !== branches.length ||
        branches.includes(base)
      )
        return yield* failure(
          cwd,
          "Choose distinct stack branches in order, excluding the base branch.",
        );
      for (const branch of [base, ...branches]) {
        if ((yield* git(cwd, ["check-ref-format", "--branch", branch], true)).exitCode !== 0)
          return yield* failure(cwd, "A stack branch name is invalid.");
        if (branch !== base) yield* head(cwd, branch);
      }
      const all = (yield* read(cwd, files.state, SavedState)) ?? [];
      const existing =
        input.action === "edit"
          ? all.find((stack) => stack.layers.some((layer) => layer.branch === currentBranch))
          : undefined;
      if (
        all.some(
          (stack) =>
            stack !== existing && stack.layers.some((layer) => branches.includes(layer.branch)),
        )
      )
        return yield* failure(
          cwd,
          "A branch is already managed in another stack. Untrack that stack first.",
        );
      const heads = yield* remoteHeads(cwd, status.remote, branches);
      const settings = yield* defaults(cwd, branches[0]!);
      const remoteBase = `refs/remotes/${settings.baseRemote}/${base}`;
      const exists = (yield* git(cwd, ["rev-parse", "--verify", remoteBase], true)).exitCode === 0;
      const baseRef = exists ? remoteBase : `refs/heads/${base}`;
      const layers: Stack["layers"][number][] = [];
      for (const [index, branch] of branches.entries()) {
        const parent = index === 0 ? baseRef : `refs/heads/${branches[index - 1]}`;
        const parentTip = yield* text(cwd, ["rev-parse", "--verify", `${parent}^{commit}`]);
        if (index > 0 && !(yield* isAncestor(cwd, parentTip, `refs/heads/${branch}`)))
          return yield* failure(
            cwd,
            `Branch ${branch} is not based on ${branches[index - 1]}. Restack it with its current manager before adopting it.`,
          );
        const parentHead =
          index === 0
            ? yield* text(cwd, ["merge-base", parent, `refs/heads/${branch}`])
            : parentTip;
        const previous = existing?.layers.find((layer) => layer.branch === branch);
        layers.push({
          branch,
          parentHead,
          remoteHead: previous ? previous.remoteHead : (heads[branch] ?? null),
        });
      }
      yield* saveStack(
        cwd,
        { base, baseRef, remote: status.remote, layers },
        existing?.layers.map((layer) => layer.branch) ?? [],
      );
      for (const layer of existing?.layers ?? []) {
        if (!branches.includes(layer.branch))
          yield* git(cwd, ["config", `branch.${layer.branch}.t3-stack-disabled`, "true"]);
      }
      for (const layer of layers)
        yield* git(cwd, ["config", `branch.${layer.branch}.t3-stack-disabled`, "false"]);
      return yield* inspect(cwd);
    },
    (
      effect,
      input: GitStackManageInput,
      _mergedBranches?: readonly string[],
      _afterPush?: AfterPush,
      _onProgress?: ProgressReporter,
    ) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : failure(input.cwd, "Stack metadata could not be accessed.", cause),
        ),
      ),
  );
  const canAutoTrack = Effect.fn("BranchStack.canAutoTrack")(function* (
    cwd: string,
    branches: readonly string[],
  ) {
    const result = yield* git(
      cwd,
      ["config", "--get-regexp", "^branch\\..*\\.t3-stack-disabled$"],
      true,
    );
    const disabled = new Set(result.stdout.trim().split("\n"));
    return !branches.some((branch) => disabled.has(`branch.${branch}.t3-stack-disabled true`));
  });
  const pushCurrent = Effect.fn("BranchStack.pushCurrent")(
    function* (cwd: string, branch: string, forceWithLease = false) {
      yield* assertIdle(cwd);
      const files = yield* paths(cwd);
      const saved = (yield* read(cwd, files.state, SavedState)) ?? [];
      const stack = saved.find((item) => item.layers.some((layer) => layer.branch === branch));
      if (!stack) return yield* failure(cwd, "The stack changed. Refresh before publishing.");
      const layer = stack.layers.find((item) => item.branch === branch)!;
      const sha = yield* head(cwd, branch);
      const remote = yield* remoteHeads(cwd, stack.remote, [branch]);
      if (remote[branch] === sha) return { status: "skipped_up_to_date" as const, branch };
      yield* git(cwd, [
        "push",
        ...(forceWithLease
          ? [`--force-with-lease=refs/heads/${branch}:${layer.remoteHead ?? ""}`]
          : []),
        stack.remote,
        `${sha}:refs/heads/${branch}`,
      ]);
      yield* git(cwd, ["update-ref", `refs/remotes/${stack.remote}/${branch}`, sha]);
      yield* git(cwd, ["branch", `--set-upstream-to=${stack.remote}/${branch}`, branch]);
      yield* saveStack(
        cwd,
        {
          ...stack,
          layers: stack.layers.map((item) =>
            item.branch === branch ? { ...item, remoteHead: sha } : item,
          ),
        },
        stack.layers.map((item) => item.branch),
      );
      return { status: "pushed" as const, branch, upstreamBranch: `${stack.remote}/${branch}` };
    },
    (effect, cwd: string, _branch: string, _forceWithLease?: boolean) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : failure(cwd, "The stack push could not be completed.", cause),
        ),
      ),
  );
  return { inspect, manage, update, assertIdle, pushCurrent, canAutoTrack };
});
