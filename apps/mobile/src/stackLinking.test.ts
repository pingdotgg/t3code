import * as NodeModule from "node:module";

import { getPathFromState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

import { fileScreenLinking, getStackStateFromPath } from "./stackLinking";

// @react-navigation/native pulls in react-native; its linking helpers live in core.
vi.mock("@react-navigation/native", () => {
  const requireFromNative = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return requireFromNative("@react-navigation/core") as typeof import("@react-navigation/native");
});

const config = { screens: fileScreenLinking };

describe.each([
  {
    name: "ThreadFile",
    prefix: "/threads/env-1/thread-1/files",
    params: { environmentId: "env-1", threadId: "thread-1" },
  },
  {
    name: "NewTaskFile",
    prefix: "/new/draft/files",
    params: { environmentId: "env-1", cwd: "/repo" },
  },
])("$name links", ({ name, prefix, params }) => {
  it("opens a nested file at the linked line", () => {
    expect(
      getStackStateFromPath(
        `${prefix}/packages/expo-development-client.ts?environmentId=env-1&cwd=%2Frepo&line=3`,
        config,
      )?.routes.at(-1),
    ).toMatchObject({
      name,
      params: { ...params, path: "packages/expo-development-client.ts", line: "3" },
    });
  });

  it.each([
    { segments: ["docs", "probe #1.md"], path: "docs/probe #1.md" },
    { segments: ["", "repo", "probe.md"], path: "/repo/probe.md" },
    { segments: ["undefined"], path: "undefined" },
  ])("round-trips the file $path", ({ segments, path }) => {
    const link = getPathFromState(
      { routes: [{ name, params: { ...params, path: segments } }] },
      config,
    );
    expect(getStackStateFromPath(link, config)?.routes.at(-1)).toMatchObject({
      name,
      params: { ...params, path },
    });
  });

  it("opens a saved link with path segments in the query", () => {
    expect(
      getStackStateFromPath(
        `${prefix}/undefined?environmentId=env-1&cwd=%2Frepo&path=docs&path=a%2Bb.md`,
        config,
      )?.routes.at(-1),
    ).toMatchObject({ name, params: { ...params, path: ["docs", "a+b.md"] } });
  });
});
