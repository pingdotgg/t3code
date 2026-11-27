import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useFileDownload } from "./useFileDownload";

const state = vi.hoisted(() => ({
  canRead: true,
  createUrl: vi.fn(async () => ({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/t/a.zip" },
  })),
  download: vi.fn(async () => {}),
}));

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (text: string) => text,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canRead,
  readPreparedConnection: () => ({ httpBaseUrl: "https://host.example/" }) as never,
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.createUrl }));
vi.mock("../media/mediaContent", () => ({ downloadMedia: state.download }));

const environmentId = EnvironmentId.make("env");

it("saves the host file through an attachment asset URL, and only with file access", async () => {
  const downloaded = Promise.withResolvers<void>();
  state.download.mockImplementationOnce(async () => downloaded.resolve());
  useFileDownload(environmentId)!("/repo", Promise.resolve("/repo/dist/a.zip"));
  await downloaded.promise;
  expect(state.download).toHaveBeenCalledWith("https://host.example/api/assets/t/a.zip", "a.zip");
  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId,
    input: {
      resource: {
        _tag: "draft-workspace-file",
        cwd: "/repo",
        path: "/repo/dist/a.zip",
        disposition: "attachment",
      },
    },
  });
  state.canRead = false;
  expect(useFileDownload(environmentId)).toBeNull();
});
