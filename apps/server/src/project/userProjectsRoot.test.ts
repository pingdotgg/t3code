import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { parseXdgProjectsDir, resolveUserProjectsRoot } from "./userProjectsRoot.ts";

// Written by xdg-user-dirs-update 0.20 for a new account
const GENERATED_USER_DIRS = `# This file is written by xdg-user-dirs-update
# If you want to change or add directories, just edit the line you're
# interested in. All local changes will be retained on the next run.
# Format is XDG_xxx_DIR="$HOME/yyy", where yyy is a shell-escaped
# homedir-relative path, or XDG_xxx_DIR="/yyy", where /yyy is an
# absolute path. No other format is supported.
#
XDG_DESKTOP_DIR="$HOME/Desktop"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_DOCUMENTS_DIR="$HOME/Documents"
XDG_PROJECTS_DIR="$HOME/Projects"
`;

describe("parseXdgProjectsDir", () => {
  it("reads the directory xdg-user-dirs-update writes", () => {
    expect(parseXdgProjectsDir(GENERATED_USER_DIRS)).toEqual(Option.some("~/Projects/"));
  });

  it("accepts the same values as xdg-user-dir", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['XDG_PROJECTS_DIR="/srv/code"', "/srv/code/"],
      ['XDG_PROJECTS_DIR="/srv/code//"', "/srv/code/"],
      ['XDG_PROJECTS_DIR="$HOME/My Projects"', "~/My Projects/"],
      ['XDG_PROJECTS_DIR="$HOME/ Projects "', "~/ Projects /"],
      ['XDG_PROJECTS_DIR="$HOME/a\\"b"', '~/a"b/'],
      ['XDG_PROJECTS_DIR="$HOME/a\\\\b"', "~/a\\b/"],
      ['XDG_PROJECTS_DIR="$HOME/a\\$b"', "~/a$b/"],
      ['\t XDG_PROJECTS_DIR \t= \t"$HOME/code" trailing', "~/code/"],
      ['XDG_PROJECTS_DIR="$HOME/code', "~/code/"],
      ['XDG_PROJECTS_DIR="$HOME"', "~/"],
      ['XDG_PROJECTS_DIR="$HOME/"', "~/"],
      ['XDG_PROJECTS_DIR="/"', "/"],
    ];
    for (const [line, root] of cases) {
      expect(parseXdgProjectsDir(line), line).toEqual(Option.some(root));
    }
  });

  it("ignores lines xdg-user-dir ignores", () => {
    const lines = [
      "XDG_PROJECTS_DIR=$HOME/unquoted",
      'export XDG_PROJECTS_DIR="$HOME/exported"',
      'XDG_PROJECTS_DIR="${HOME}/braced"',
      'XDG_PROJECTS_DIR="$HOMEx/code"',
      'XDG_PROJECTS_DIR="relative/code"',
      'XDG_PROJECTS_DIR=""',
      '#XDG_PROJECTS_DIR="$HOME/commented"',
      'XDG_PROJECTS_DIRS="$HOME/other-key"',
    ];
    for (const line of lines) {
      expect(parseXdgProjectsDir(line), line).toEqual(Option.none());
    }
  });

  it("uses the last valid line", () => {
    expect(
      parseXdgProjectsDir(
        'XDG_PROJECTS_DIR="$HOME/first"\r\nXDG_PROJECTS_DIR="$HOME/second"\r\nXDG_PROJECTS_DIR=bad\r\n',
      ),
    ).toEqual(Option.some("~/second/"));
  });
});

it.layer(NodeServices.layer)("resolveUserProjectsRoot", (it) => {
  const makeHome = Effect.fn("makeHome")(function* (input: {
    readonly userDirs?: string;
    readonly directories?: ReadonlyArray<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-user-projects-" });
    for (const directory of input.directories ?? []) {
      yield* fileSystem.makeDirectory(path.join(home, directory), { recursive: true });
    }
    if (input.userDirs !== undefined) {
      yield* fileSystem.makeDirectory(path.join(home, ".config"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(home, ".config", "user-dirs.dirs"),
        input.userDirs,
      );
    }
    return home;
  });

  const resolveFor = (
    home: string,
    options: { readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv } = {},
  ) =>
    resolveUserProjectsRoot().pipe(
      Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, options.env ?? {}),
    );

  it.effect("returns the Projects directory when it exists", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ userDirs: GENERATED_USER_DIRS, directories: ["Projects"] });

      expect(yield* resolveFor(home)).toEqual(Option.some("~/Projects/"));
    }),
  );

  it.effect("keeps whitespace at the end of the directory name", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        userDirs: 'XDG_PROJECTS_DIR="$HOME/ Projects "\n',
        directories: [" Projects "],
      });

      expect(yield* resolveFor(home)).toEqual(Option.some("~/ Projects /"));
    }),
  );

  it.effect("returns none when the directory was deleted", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ userDirs: GENERATED_USER_DIRS });

      expect(yield* resolveFor(home)).toEqual(Option.none());
    }),
  );

  it.effect("returns none without user-dirs.dirs", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ directories: ["Projects"] });

      expect(yield* resolveFor(home)).toEqual(Option.none());
    }),
  );

  it.effect("returns none when the directory is disabled by pointing it at home", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ userDirs: 'XDG_PROJECTS_DIR="$HOME/"\n' });

      expect(yield* resolveFor(home)).toEqual(Option.none());
    }),
  );

  // user-dirs.dirs only takes POSIX absolute paths
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "reads user-dirs.dirs from an absolute XDG_CONFIG_HOME",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHome({ directories: ["code", "config"] });
        yield* fileSystem.writeFileString(
          path.join(home, "config", "user-dirs.dirs"),
          `XDG_PROJECTS_DIR="${path.join(home, "code")}"\n`,
        );

        expect(
          yield* resolveFor(home, { env: { XDG_CONFIG_HOME: path.join(home, "config") } }),
        ).toEqual(Option.some(`${path.join(home, "code")}/`));
        expect(yield* resolveFor(home, { env: { XDG_CONFIG_HOME: "config" } })).toEqual(
          Option.none(),
        );
      }),
  );

  it.effect("returns none on Windows and macOS", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ userDirs: GENERATED_USER_DIRS, directories: ["Projects"] });

      expect(yield* resolveFor(home, { platform: "win32" })).toEqual(Option.none());
      expect(yield* resolveFor(home, { platform: "darwin" })).toEqual(Option.none());
    }),
  );
});
