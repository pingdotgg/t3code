/* oxlint-disable unicorn/require-post-message-target-origin */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

type ClientSettings = Record<string, unknown>;

interface HostRequest {
  readonly type: "t3.hostRequest";
  readonly id: string;
  readonly method: "getClientSettings" | "setClientSettings";
  readonly args?: readonly unknown[];
}

interface ClientSettingsDocument {
  readonly settings?: unknown;
}

export interface ClientSettingsPersistence {
  readonly get: () => Promise<ClientSettings | null>;
  readonly set: (settings: ClientSettings) => Promise<void>;
}

export function resolveClientSettingsPath(t3Home: string): string {
  return path.join(t3Home, "userdata", "client-settings.json");
}

export function createClientSettingsPersistence(settingsPath: string): ClientSettingsPersistence {
  return {
    get: async () => {
      try {
        const raw = await fs.readFile(settingsPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isObject(parsed)) {
          return null;
        }

        const legacyDocument = parsed as ClientSettingsDocument;
        return isObject(legacyDocument.settings) ? legacyDocument.settings : parsed;
      } catch {
        return null;
      }
    },
    set: async (settings) => {
      const directory = path.dirname(settingsPath);
      const tempPath = `${settingsPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(settings)}\n`, "utf8");
      await fs.rename(tempPath, settingsPath);
    },
  };
}

export function registerClientSettingsHostBridge(input: {
  readonly webview: vscode.Webview;
  readonly persistence: ClientSettingsPersistence;
  readonly outputChannel: vscode.OutputChannel;
}): vscode.Disposable {
  return input.webview.onDidReceiveMessage(async (message: unknown) => {
    const request = parseHostRequest(message);
    if (!request) {
      return;
    }

    try {
      const result =
        request.method === "getClientSettings"
          ? await input.persistence.get()
          : await setClientSettingsFromRequest(input.persistence, request);
      await input.webview.postMessage({
        type: "t3.hostResponse",
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown host bridge error.";
      input.outputChannel.appendLine(`[webview] Host bridge request failed: ${message}`);
      await input.webview.postMessage({
        type: "t3.hostResponse",
        id: request.id,
        ok: false,
        error: message,
      });
    }
  });
}

async function setClientSettingsFromRequest(
  persistence: ClientSettingsPersistence,
  request: HostRequest,
): Promise<void> {
  const settings = request.args?.[0];
  if (!isObject(settings)) {
    throw new Error("setClientSettings requires a settings object.");
  }
  await persistence.set(settings);
}

function parseHostRequest(message: unknown): HostRequest | null {
  if (!isObject(message)) {
    return null;
  }

  const candidate = message as Partial<HostRequest>;
  if (
    candidate.type !== "t3.hostRequest" ||
    typeof candidate.id !== "string" ||
    (candidate.method !== "getClientSettings" && candidate.method !== "setClientSettings")
  ) {
    return null;
  }

  const request = {
    type: candidate.type,
    id: candidate.id,
    method: candidate.method,
  };
  return Array.isArray(candidate.args) ? { ...request, args: candidate.args } : request;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
