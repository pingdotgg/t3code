import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => ({}) },
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: state.session, error: null }),
}));
vi.mock("./projectClones", () => ({ environmentProjectCloneListAtom: () => null }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assets")>()),
  createAssetEnvironmentAtoms: () => ({ createUrl: state.assetQuery }),
}));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useRefreshAssetUrl, useAssetUrlState } from "./assets";
import { mediaVideoPreviewUri } from "../lib/videoPreviewSource";
import { pullRequestMediaSource } from "../features/pull-requests/pullRequestMediaSource";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: "https://host.test/api/assets/image.png",
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("stops waiting for an unresolved grant when the connection is offline", () => {
  state.phase = "offline";
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "disconnected",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBeNull();
});

it("preserves the authored Bitbucket fragment through resolution, renewal, and fallback", async () => {
  const url = "https://bitbucket.org/acme/web/downloads/demo.mp4?download=1#t=2";
  const source = {
    type: "media" as const,
    name: "demo.mp4",
    mimeType: "video/mp4",
    ...pullRequestMediaSource(url, { environmentId, cwd: "/repo" }),
  };
  if (!("resource" in source)) throw new Error("Expected a renewable media resource");
  const refresh = useRefreshAssetUrl(environmentId, source.resource, source.fallbackUri);
  const asset = useAssetUrlState(environmentId, source.resource);
  expect(mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null)).toBe(
    "https://host.test/api/assets/image.png#t=2",
  );
  const unsupported = new Error("Unsupported asset resource: bitbucket-media");
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(unsupported)));
  expect(mediaVideoPreviewUri(source, await refresh())).toBe(url);

  state.mint.mockRejectedValue(unsupported);
  expect(mediaVideoPreviewUri(source, await refresh())).toBe(url);
  await expect(useRefreshAssetUrl(environmentId, resource)()).rejects.toBe(unsupported);

  state.mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/renewed.mp4", expiresAt: 2 }),
  );
  expect(mediaVideoPreviewUri(source, await refresh())).toBe(
    "https://host.test/api/assets/renewed.mp4#t=2",
  );
});
