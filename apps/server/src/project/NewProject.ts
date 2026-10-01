/**
 * NewProject - makes the folder for a project started from just a name:
 * `<projects root>/<slug>` with a README, an icon, and a first commit.
 *
 * The icon lives at `assets/icon.svg`, a path ProjectFaviconResolver already
 * checks after the usual web app icons. It travels with the repository, so
 * every machine that clones the project shows the same icon.
 *
 * @module NewProject
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { newProjectFolderName } from "@t3tools/shared/path";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

// Tailwind 600 shades: dark enough for white initials on every hue.
const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_FOLDER_ATTEMPTS = 100;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A rounded square with the name's initials, colored by a hash of the name. */
function newProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function newProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    "Created in [T3 Code](https://t3.codes).",
    "",
  ].join("\n");
}

// Git's own identity message runs several lines; say what to do instead.
// Otherwise its last line ("error: gpg failed to sign the data") says enough.
function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Git could not make the first commit.";
}

/**
 * Claims a fresh folder for `name` under `root` (adding `-2`, `-3`, ... when
 * the name is taken), writes the starter files, and makes the first commit.
 * A failed commit (no Git identity, a signing prompt) keeps the folder and
 * returns why, so the project still opens. Any other failure removes the
 * folder it claimed.
 */
export const createNewProjectFolder = Effect.fn("NewProject.createNewProjectFolder")(
  function* (input: { readonly root: string; readonly name: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;

    yield* fileSystem.makeDirectory(input.root, { recursive: true });
    // Created without `recursive`, so the create itself claims the folder and
    // two requests for the same name never share one.
    const folderName = newProjectFolderName(input.name);
    let workspaceRoot: string | null = null;
    for (let attempt = 1; workspaceRoot === null && attempt <= MAX_FOLDER_ATTEMPTS; attempt++) {
      const candidate = path.join(
        input.root,
        attempt === 1 ? folderName : `${folderName}-${attempt}`,
      );
      const claimed = yield* fileSystem.makeDirectory(candidate).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
      if (claimed) workspaceRoot = candidate;
    }
    if (workspaceRoot === null) {
      return yield* PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "makeDirectory",
        description: `Every folder name for "${folderName}" is taken.`,
        pathOrDescriptor: input.root,
      });
    }
    const cwd = workspaceRoot;

    return yield* Effect.gen(function* () {
      const branch =
        (yield* git
          .readConfigValue(cwd, "init.defaultBranch")
          .pipe(Effect.orElseSucceed(() => null))) ?? "main";
      yield* git.execute({
        operation: "NewProject.init",
        cwd,
        args: ["init", `--initial-branch=${branch}`],
        timeoutMs: 10_000,
      });
      yield* fileSystem.writeFileString(path.join(cwd, "README.md"), newProjectReadme(input.name));
      yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
      yield* fileSystem.writeFileString(
        path.join(cwd, "assets", "icon.svg"),
        newProjectIconSvg(input.name),
      );
      // Named and forced so a global ignore rule (say `*.svg`) cannot drop one.
      yield* git.execute({
        operation: "NewProject.add",
        cwd,
        args: ["add", "--force", "--", "README.md", "assets/icon.svg"],
        timeoutMs: 10_000,
      });
      const commitError = yield* git
        .execute({
          operation: "NewProject.commit",
          cwd,
          args: ["commit", "--message", "Initial commit"],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.map((result) =>
            result.exitCode === 0 ? undefined : describeCommitFailure(result.stderr),
          ),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
      return { workspaceRoot: cwd, commitError };
    }).pipe(Effect.onError(() => fileSystem.remove(cwd, { recursive: true }).pipe(Effect.ignore)));
  },
);
