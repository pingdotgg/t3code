import { assert, describe, it } from "@effect/vitest";

import {
  gitConfigEnvironmentSignature,
  gitConfigListDependencies,
  parseGitConfigList,
} from "./gitConfigSnapshot.ts";

describe("parseGitConfigList", () => {
  it.each([
    { name: "no entries", stdout: "", expected: [] },
    {
      name: "a value, an empty value and no value",
      stdout:
        "file:.git/config\0core.bare\nfalse\0file:.git/config\0core.empty\n\0command line:\0core.flag\0",
      expected: [
        { origin: "file:.git/config", key: "core.bare", value: "false" },
        { origin: "file:.git/config", key: "core.empty", value: "" },
        { origin: "command line:", key: "core.flag", value: null },
      ],
    },
    {
      name: "a value spanning lines",
      stdout: "file:/etc/gitconfig\0t3.note\nfirst\nsecond\0",
      expected: [{ origin: "file:/etc/gitconfig", key: "t3.note", value: "first\nsecond" }],
    },
    { name: "a missing terminator", stdout: "file:a\0core.bare\nfalse", expected: null },
    {
      name: "an origin without an entry",
      stdout: "file:a\0core.bare\nfalse\0file:b\0",
      expected: null,
    },
  ])("parses $name", ({ stdout, expected }) => {
    assert.deepStrictEqual(parseGitConfigList(stdout), expected);
  });
});

describe("gitConfigListDependencies", () => {
  const options = {
    home: "/home/me",
    windows: false,
    isAbsolute: (p: string) => p.startsWith("/"),
  };
  const entry = (origin: string, key: string, value: string | null = "x") => ({
    origin,
    key,
    value,
  });

  it.each([
    {
      name: "absolute origins, and not the repository's relative ones",
      entries: [
        entry("file:/home/me/.gitconfig", "user.name"),
        entry("file:.git/config", "core.bare"),
        entry("command line:", "safe.barerepository"),
      ],
      expected: { paths: ["/home/me/.gitconfig"], supported: true },
    },
    {
      name: "include targets whether or not they were read",
      entries: [
        entry("file:/home/me/.gitconfig", "include.path", "~/.gitconfig-local"),
        entry("file:/home/me/.gitconfig", "includeif.gitdir:~/work/.path", "work/../config"),
        entry("file:.git/config", "includeif.hasconfig:remote.*.url:https://x/**.path", "/etc/x"),
        entry("file:.git/config", "includeif.gitdir/i:/w/.path", "/etc/y"),
      ],
      expected: {
        paths: [
          "/home/me/.gitconfig",
          "/home/me/.gitconfig-local",
          "/home/me/work/../config",
          "/etc/x",
          "/etc/y",
        ],
        supported: true,
      },
    },
    {
      name: "a relative include in a relative origin",
      entries: [entry("file:.git/config", "include.path", "shared.inc")],
      expected: { paths: [], supported: false },
    },
    {
      name: "an include that depends on the branch",
      entries: [entry("file:/home/me/.gitconfig", "includeif.onbranch:main.path", "/etc/main")],
      expected: { paths: ["/home/me/.gitconfig", "/etc/main"], supported: false },
    },
    {
      name: "an include in another user's home",
      entries: [entry("file:/home/me/.gitconfig", "include.path", "~other/config")],
      expected: { paths: ["/home/me/.gitconfig"], supported: false },
    },
    {
      name: "an include under the runtime prefix",
      entries: [entry("command line:", "include.path", "%(prefix)/etc/x")],
      expected: { paths: [], supported: false },
    },
    {
      name: "an include without a value",
      entries: [entry("file:/etc/gitconfig", "include.path", null)],
      expected: { paths: ["/etc/gitconfig"], supported: false },
    },
    {
      name: "values that are not from files",
      entries: [entry("standard input:", "core.bare")],
      expected: { paths: [], supported: false },
    },
  ])("tracks $name", ({ entries, expected }) => {
    assert.deepStrictEqual(gitConfigListDependencies(entries, options), expected);
  });

  it("joins a relative include onto a Windows origin's directory", () => {
    assert.deepStrictEqual(
      gitConfigListDependencies(
        [entry("file:C:\\Users\\me\\.gitconfig", "include.path", "local")],
        {
          home: undefined,
          windows: true,
          isAbsolute: (p) => /^[A-Za-z]:[\\/]/.test(p),
        },
      ),
      { paths: ["C:\\Users\\me\\.gitconfig", "C:\\Users\\me\\local"], supported: true },
    );
  });
});

describe("gitConfigEnvironmentSignature", () => {
  it("changes with the config Git takes from the environment", () => {
    const base = { HOME: "/home/me", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b" };
    assert.notEqual(
      gitConfigEnvironmentSignature({ ...base, GIT_CONFIG_VALUE_0: "1" }),
      gitConfigEnvironmentSignature({ ...base, GIT_CONFIG_VALUE_0: "2" }),
    );
    assert.notEqual(
      gitConfigEnvironmentSignature(base),
      gitConfigEnvironmentSignature({ ...base, HOME: "/home/other" }),
    );
    assert.notEqual(
      gitConfigEnvironmentSignature(base),
      gitConfigEnvironmentSignature({ ...base, GIT_OBJECT_DIRECTORY: "/tmp/objects" }),
    );
    assert.isNull(gitConfigEnvironmentSignature({ ...base, GIT_CONFIG: "/tmp/only" }));
    assert.isNull(gitConfigEnvironmentSignature({ ...base, GIT_CONFIG_COUNT: "1001" }));
  });
});
