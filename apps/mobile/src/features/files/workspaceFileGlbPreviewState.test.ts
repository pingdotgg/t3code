import { describe, expect, it } from "vite-plus/test";

import { workspaceFileGlbPreviewState } from "./workspaceFileGlbPreviewState";

const connected = { phase: "connected", error: null, traceId: null } as const;
const reconnecting = { phase: "reconnecting", error: null, traceId: null } as const;

describe("workspaceFileGlbPreviewState", () => {
  it("shows the environment recovery state instead of an asset spinner while disconnected", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: reconnecting,
        error: null,
        isPending: true,
        uri: null,
      }),
    ).toEqual({ kind: "connection-unavailable", connection: reconnecting });
  });

  it("shows an asset error when URL creation fails", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: connected,
        error: "Asset request failed.",
        isPending: false,
        uri: null,
      }),
    ).toEqual({ kind: "asset-error", message: "Asset request failed." });
  });

  it("shows a refresh error instead of reusing a stale asset URL", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: connected,
        error: "Asset refresh failed.",
        isPending: false,
        uri: "http://192.168.1.2:3773/api/assets/stale-model",
      }),
    ).toEqual({ kind: "asset-error", message: "Asset refresh failed." });
  });

  it("does not spin forever when URL creation settles without a URL", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: connected,
        error: null,
        isPending: false,
        uri: null,
      }),
    ).toEqual({
      kind: "asset-error",
      message: "The app could not prepare this 3D model for preview.",
    });
  });

  it("shows preparation only while URL creation is actually pending", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: connected,
        error: null,
        isPending: true,
        uri: null,
      }),
    ).toEqual({ kind: "preparing" });
  });

  it("shows the native viewer once a URL is available", () => {
    expect(
      workspaceFileGlbPreviewState({
        connection: connected,
        error: null,
        isPending: false,
        uri: "http://192.168.1.2:3773/api/assets/model",
      }),
    ).toEqual({ kind: "ready", uri: "http://192.168.1.2:3773/api/assets/model" });
  });
});
