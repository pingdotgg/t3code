import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  findEnvironmentUpdate,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-personal",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T00:00:00.000Z",
  models: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    canUpdate: true,
    updateCommand: null,
    checkedAt: null,
    message: null,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it("requires remote desktop update support for desktop hosts", () => {
    expect(supportsEnvironmentUpdate({})).toBe(false);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "respawn" })).toBe(true);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed" })).toBe(false);
    expect(
      supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed", desktopAppUpdate: true }),
    ).toBe(true);
  });

  it("excludes unavailable, manual, busy, and incompatible provider updates", () => {
    expect(canUpdateEnvironmentProvider(provider)).toBe(true);
    expect(canUpdateEnvironmentProvider({ ...provider, installed: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, availability: "unavailable" })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, versionAdvisory: undefined })).toBe(false);
    for (const latestVersionStatus of ["broken", "unsupported"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }),
      ).toBe(false);
    }
    for (const status of ["queued", "running"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          updateState: {
            status,
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ).toBe(false);
    }
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: {
          ...provider.versionAdvisory!,
          canUpdate: false,
        },
      }),
    ).toBe(false);
  });
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  it("keeps stable hosts on stable releases and ignores drafts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json([
            { tag_name: "v2.0.0-nightly.20260923.1" },
            { tag_name: "v1.2.0", draft: true },
            { tag_name: "v1.1.0" },
          ]),
        ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.1.0");
    expect(await findEnvironmentUpdate("1.1.0", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.3.0", signal)).toBeNull();
  });

  it("walks release pages to find the host's channel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(Array.from({ length: 100 }, () => ({ tag_name: "v2.0.0" }))),
      )
      .mockResolvedValueOnce(Response.json([{ tag_name: "v1.0.0-preview.20260923.2" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await findEnvironmentUpdate("1.0.0-preview.20260923.1", signal)).toBe(
      "1.0.0-preview.20260923.2",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ signal });
  });

  it("reports failed checks instead of claiming the server is current", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("403");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("No stable release");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid" })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow();
  });
});
