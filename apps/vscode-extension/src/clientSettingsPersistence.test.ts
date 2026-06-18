import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  createClientSettingsPersistence,
  registerClientSettingsHostBridge,
  resolveClientSettingsPath,
} from "./clientSettingsPersistence.ts";

describe("client settings persistence", () => {
  let t3Home: string;

  beforeEach(() => {
    t3Home = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-vscode-settings-"));
  });

  afterEach(() => {
    fs.rmSync(t3Home, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("resolves the desktop-compatible client settings path under T3 home userdata", () => {
    expect(resolveClientSettingsPath(t3Home)).toBe(
      path.join(t3Home, "userdata", "client-settings.json"),
    );
  });

  it("reads and writes raw client settings JSON", async () => {
    const persistence = createClientSettingsPersistence(resolveClientSettingsPath(t3Home));
    const settings = {
      favorites: [{ provider: "codex", model: "gpt-5.2" }],
      timestampFormat: "24-hour",
    };

    await persistence.set(settings);

    expect(JSON.parse(fs.readFileSync(resolveClientSettingsPath(t3Home), "utf8"))).toEqual(
      settings,
    );
    await expect(persistence.get()).resolves.toEqual(settings);
  });

  it("reads the legacy wrapped client settings document", async () => {
    fs.mkdirSync(path.join(t3Home, "userdata"), { recursive: true });
    fs.writeFileSync(
      resolveClientSettingsPath(t3Home),
      JSON.stringify({ settings: { timestampFormat: "12-hour" } }),
    );

    await expect(
      createClientSettingsPersistence(resolveClientSettingsPath(t3Home)).get(),
    ).resolves.toEqual({
      timestampFormat: "12-hour",
    });
  });

  it("routes webview host bridge get, set, and confirm requests", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const postMessage = vi.fn().mockResolvedValue(true);
    const confirm = vi.fn().mockResolvedValue(true);
    const webview = {
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
      postMessage,
    };
    const persistence = {
      get: vi.fn().mockResolvedValue({ timestampFormat: "locale" }),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const disposable = registerClientSettingsHostBridge({
      webview: webview as never,
      persistence,
      outputChannel: { appendLine: vi.fn() } as never,
      confirm,
    });

    await [...listeners][0]?.({
      type: "t3.hostRequest",
      id: "read-1",
      method: "getClientSettings",
    });
    await [...listeners][0]?.({
      type: "t3.hostRequest",
      id: "write-1",
      method: "setClientSettings",
      args: [{ timestampFormat: "24-hour" }],
    });
    await [...listeners][0]?.({
      type: "t3.hostRequest",
      id: "confirm-1",
      method: "confirm",
      args: ["Delete thread?"],
    });

    expect(persistence.get).toHaveBeenCalledWith();
    expect(persistence.set).toHaveBeenCalledWith({ timestampFormat: "24-hour" });
    expect(confirm).toHaveBeenCalledWith("Delete thread?");
    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.hostResponse",
      id: "read-1",
      ok: true,
      result: { timestampFormat: "locale" },
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.hostResponse",
      id: "write-1",
      ok: true,
      result: undefined,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.hostResponse",
      id: "confirm-1",
      ok: true,
      result: true,
    });

    disposable.dispose();
    expect(listeners.size).toBe(0);
  });
});
