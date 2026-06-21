/* oxlint-disable unicorn/require-post-message-target-origin */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as vscode from "vscode";

type ClientSettings = Record<string, unknown>;

interface HostRequest {
  readonly type: "t3.hostRequest";
  readonly id: string;
  readonly method: "getClientSettings" | "setClientSettings" | "confirm";
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
  return NodePath.join(t3Home, "userdata", "client-settings.json");
}

export function createClientSettingsPersistence(
  settingsPath: string,
  outputChannel?: Pick<vscode.OutputChannel, "appendLine">,
): ClientSettingsPersistence {
  return {
    get: async () => {
      try {
        const raw = await NodeFSP.readFile(settingsPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isObject(parsed)) {
          return null;
        }

        const legacyDocument = parsed as ClientSettingsDocument;
        return isObject(legacyDocument.settings) ? legacyDocument.settings : parsed;
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) {
          outputChannel?.appendLine(
            `[webview] Failed to read client settings ${settingsPath}: ${stringifyError(error)}`,
          );
        }
        return null;
      }
    },
    set: async (settings) => {
      const directory = NodePath.dirname(settingsPath);
      const tempPath = `${settingsPath}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
      try {
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(tempPath, `${JSON.stringify(settings)}\n`, "utf8");
        await NodeFSP.rename(tempPath, settingsPath);
      } catch (error) {
        await NodeFSP.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    },
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerClientSettingsHostBridge(input: {
  readonly webview: vscode.Webview;
  readonly persistence: ClientSettingsPersistence;
  readonly outputChannel: vscode.OutputChannel;
  readonly confirm?: (message: string) => Promise<boolean>;
}): vscode.Disposable {
  return input.webview.onDidReceiveMessage(async (message: unknown) => {
    const request = parseHostRequest(message);
    if (!request) {
      return;
    }

    try {
      const result = await handleHostRequest(input, request);
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

async function handleHostRequest(
  input: {
    readonly persistence: ClientSettingsPersistence;
    readonly confirm?: (message: string) => Promise<boolean>;
  },
  request: HostRequest,
): Promise<unknown> {
  switch (request.method) {
    case "getClientSettings":
      return input.persistence.get();
    case "setClientSettings":
      return setClientSettingsFromRequest(input.persistence, request);
    case "confirm":
      return confirmFromRequest(input.confirm, request);
  }
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

async function confirmFromRequest(
  confirm: ((message: string) => Promise<boolean>) | undefined,
  request: HostRequest,
): Promise<boolean> {
  if (!confirm) {
    throw new Error("confirm is unavailable.");
  }
  const message = request.args?.[0];
  if (typeof message !== "string") {
    throw new Error("confirm requires a message string.");
  }
  return confirm(message);
}

function parseHostRequest(message: unknown): HostRequest | null {
  if (!isObject(message)) {
    return null;
  }

  const candidate = message as Partial<HostRequest>;
  if (
    candidate.type !== "t3.hostRequest" ||
    typeof candidate.id !== "string" ||
    (candidate.method !== "getClientSettings" &&
      candidate.method !== "setClientSettings" &&
      candidate.method !== "confirm")
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
