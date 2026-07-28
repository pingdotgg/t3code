import { WS_METHODS } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { createEnvironmentRpcQueryAtomFamily } = vi.hoisted(() => ({
  createEnvironmentRpcQueryAtomFamily: vi.fn(() => Symbol("filesystem-browse-query")),
}));

vi.mock("./runtime.ts", () => ({ createEnvironmentRpcQueryAtomFamily }));

import { createFilesystemEnvironmentAtoms } from "./filesystem.ts";

describe("filesystem browse query policy", () => {
  beforeEach(() => {
    createEnvironmentRpcQueryAtomFamily.mockClear();
  });

  it("marks directory listings stale immediately so browser remounts revalidate", () => {
    const runtime = {} as never;

    createFilesystemEnvironmentAtoms(runtime);

    expect(createEnvironmentRpcQueryAtomFamily).toHaveBeenCalledWith(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
      staleTimeMs: 0,
    });
  });
});
