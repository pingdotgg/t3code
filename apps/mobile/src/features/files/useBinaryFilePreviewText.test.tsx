import { RegistryProvider } from "@effect/atom-react";
import { type AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  resources: [] as (AssetResource | null)[],
  fetches: [] as { uri: string; range: string | undefined }[],
}));

vi.mock("../../state/assets", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: AssetResource | null) => {
    mocks.resources.push(resource);
    return resource === null ? { _tag: "Loading" } : { _tag: "Success", url: "https://host/a" };
  },
}));
vi.mock("expo/fetch", () => ({
  fetch: async (uri: string, init: { headers: Record<string, string> }) => {
    mocks.fetches.push({ uri, range: init.headers.Range });
    // "// 中文注释\n" encoded as GBK: the read RPC refuses it as binary.
    return new Response(
      new Uint8Array([0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd, 0x0a]),
    );
  },
}));

const { useBinaryFilePreviewText } = await import("./useBinaryFilePreviewText");

describe("useBinaryFilePreviewText", () => {
  it("reads a binary_file workspace file read-only and decodes GBK text", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    let state: ReturnType<typeof useBinaryFilePreviewText> | null = null;
    let decoded = () => {};
    const contentReady = new Promise<void>((resolve) => (decoded = resolve));
    function Probe() {
      state = useBinaryFilePreviewText({
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        cwd: "/repo",
        relativePath: "src/main.c",
        revision: "0",
      });
      if (state.content !== null) decoded();
      return null;
    }
    await act(async () => {
      root.render(
        <RegistryProvider>
          <Probe />
        </RegistryProvider>,
      );
    });
    await act(() => contentReady);

    expect(state).toEqual({ content: { text: "// 中文注释\n", truncated: false }, error: null });
    expect(mocks.resources.at(-1)).toEqual({
      _tag: "media-file",
      threadId: "thread",
      path: "/repo/src/main.c",
      disposition: "attachment",
    });
    expect(mocks.fetches).toEqual([{ uri: "https://host/a", range: "bytes=0-1048576" }]);
    await act(async () => root.unmount());
  });
});
