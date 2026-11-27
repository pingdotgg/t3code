import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { useFileDownload } from "./useFileDownload";

const state = vi.hoisted(() => ({
  canRead: true,
  hostOs: undefined as "linux" | "windows" | "unknown" | undefined,
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
  readPreparedConnection: () =>
    ({
      httpBaseUrl: "https://host.example/",
      descriptor: state.hostOs === undefined ? undefined : { platform: { os: state.hostOs } },
    }) as never,
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.createUrl }));
vi.mock("../media/mediaContent", () => ({ downloadMedia: state.download }));

const environmentId = EnvironmentId.make("env");

beforeEach(() => {
  state.canRead = true;
  state.hostOs = undefined;
  vi.clearAllMocks();
});

it("saves the host file through an attachment asset URL, and only with file access", async () => {
  const downloaded = Promise.withResolvers<void>();
  state.download.mockImplementationOnce(async () => downloaded.resolve());
  useFileDownload(environmentId, "host")!("/repo", Promise.resolve("/repo/dist/a.zip"));
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
  expect(useFileDownload(environmentId, "host")).toBeNull();
});

it.each([
  {
    hostOs: undefined,
    pathKind: "workspace-relative",
    path: "docs/report\\draft.txt",
    name: "report\\draft.txt",
  },
  {
    hostOs: "unknown",
    pathKind: "workspace-relative",
    path: "docs/report\\draft.txt",
    name: "report\\draft.txt",
  },
  { hostOs: "linux", pathKind: "host", path: "/repo/report\\draft.txt", name: "report\\draft.txt" },
  { hostOs: "windows", pathKind: "host", path: "C:\\repo\\draft.txt", name: "draft.txt" },
] as const)("downloads $path as $name", async ({ hostOs, pathKind, path, name }) => {
  state.hostOs = hostOs;
  const downloaded = Promise.withResolvers<void>();
  state.download.mockImplementationOnce(async () => downloaded.resolve());
  useFileDownload(environmentId, pathKind)!("/repo", path);
  await downloaded.promise;
  expect(state.download).toHaveBeenLastCalledWith("https://host.example/api/assets/t/a.zip", name);
});
