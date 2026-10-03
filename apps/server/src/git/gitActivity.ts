const READ_ONLY_COMMANDS = new Set([
  "blame",
  "cat-file",
  "check-attr",
  "check-ref-format",
  "check-ignore",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "fsck",
  "grep",
  "get-tar-commit-id",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "rev-list",
  "rev-parse",
  "show",
  "show-branch",
  "show-ref",
  "shortlog",
  "status",
  "verify-commit",
  "verify-tag",
  "whatchanged",
]);

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

function commandAndArguments(args: ReadonlyArray<string>): {
  readonly command: string | undefined;
  readonly args: ReadonlyArray<string>;
} {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (GLOBAL_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-c") && argument.length > 2) continue;
    if (argument.startsWith("--") && argument.includes("=")) continue;
    if (argument.startsWith("-")) continue;
    return { command: argument, args: args.slice(index + 1) };
  }
  return { command: undefined, args: [] };
}

function firstPositional(args: ReadonlyArray<string>): string | undefined {
  return args.find((argument) => !argument.startsWith("-"));
}

function branchArgumentsAreReadOnly(args: ReadonlyArray<string>): boolean {
  const readFlags = new Set([
    "-a",
    "-r",
    "-v",
    "-vv",
    "--all",
    "--remotes",
    "--list",
    "-l",
    "--show-current",
    "--column",
    "--color",
    "--no-color",
    "--ignore-case",
  ]);
  const readOptionsWithValue = new Set([
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--format",
    "--sort",
  ]);
  const mutationFlags = new Set([
    "-c",
    "-C",
    "-d",
    "-D",
    "-m",
    "-M",
    "--copy",
    "--delete",
    "--edit-description",
    "--move",
    "--set-upstream-to",
    "--unset-upstream",
  ]);
  if (args.some((argument) => mutationFlags.has(argument))) return false;

  let listingMode = args.length === 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (readOptionsWithValue.has(argument)) {
      index += 1;
      listingMode = true;
    } else if (readFlags.has(argument)) {
      listingMode = true;
    } else if (argument.startsWith("--format=") || argument.startsWith("--sort=")) {
      listingMode = true;
    } else if (argument.startsWith("-")) {
      return false;
    } else if (!listingMode) {
      return false;
    }
  }
  return listingMode;
}

function isReadOnlyMixedCommand(command: string, args: ReadonlyArray<string>): boolean {
  switch (command) {
    case "branch":
      return branchArgumentsAreReadOnly(args);
    case "config":
      return (
        args.length === 0 ||
        args.some((argument) =>
          [
            "--get",
            "--get-all",
            "--get-regexp",
            "--get-urlmatch",
            "--list",
            "-l",
            "--name-only",
            "--show-origin",
            "--show-scope",
            "--type",
            "--bool",
            "--int",
            "--path",
            "--null",
          ].includes(argument),
        )
      );
    case "notes":
      return args.length === 0 || ["list", "show", "get-ref"].includes(firstPositional(args) ?? "");
    case "remote":
      return (
        args.length === 0 ||
        firstPositional(args) === undefined ||
        ["show", "get-url"].includes(firstPositional(args) ?? "")
      );
    case "stash":
      return args.length === 0 || ["list", "show"].includes(firstPositional(args) ?? "");
    case "symbolic-ref":
      return (
        !args.includes("--delete") &&
        args.filter((argument) => !argument.startsWith("-")).length < 2
      );
    case "tag":
      return (
        args.length === 0 ||
        args.some((argument) =>
          [
            "-l",
            "--list",
            "--contains",
            "--no-contains",
            "--points-at",
            "--merged",
            "--no-merged",
            "--format",
            "--sort",
            "-n",
            "-v",
          ].includes(argument),
        ) ||
        args.some((argument) => argument.startsWith("--format=") || argument.startsWith("--sort="))
      );
    case "worktree":
      return firstPositional(args) === "list";
    case "submodule":
      return ["status", "summary"].includes(firstPositional(args) ?? "");
    default:
      return false;
  }
}

/** Unknown commands are treated as mutating; known reads are hidden by default. */
export function isGitMutatingInvocation(args: ReadonlyArray<string>): boolean {
  const parsed = commandAndArguments(args);
  if (parsed.command === undefined) return false;
  if (READ_ONLY_COMMANDS.has(parsed.command)) return false;
  if (isReadOnlyMixedCommand(parsed.command, parsed.args)) return false;
  return true;
}
