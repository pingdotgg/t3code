import { EnvironmentId, ThreadId, type AssetCreateUrlResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  httpBaseUrl: "https://lan.test",
  mint: vi.fn(),
}));

vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: () => null } }));
vi.mock("~/state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: true }) }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: state.httpBaseUrl }),
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: state.httpBaseUrl } }),
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useAssetUrlRefresh } from "./assetUrls";

it("resolves a refreshed asset against the route that is current when minting finishes", async () => {
  let finishMint!: (result: AsyncResult.AsyncResult<AssetCreateUrlResult>) => void;
  state.mint.mockReturnValueOnce(new Promise((resolve) => (finishMint = resolve)));
  const resource = {
    _tag: "media-file",
    threadId: ThreadId.make("asset-thread"),
    path: "/repo/file.txt",
  } as const;
  const refreshed = useAssetUrlRefresh(EnvironmentId.make("asset-environment"), resource)();
  state.httpBaseUrl = "https://relay.test";
  finishMint(AsyncResult.success({ relativeUrl: "/api/assets/file", expiresAt: 1 }));
  await expect(refreshed).resolves.toBe("https://relay.test/api/assets/file");
});
