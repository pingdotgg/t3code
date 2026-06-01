import type { BrowserAgentListResult } from "@t3tools/contracts";
import {
  BROWSER_AGENT_AUTO_PAIR_PATH,
  BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH,
} from "@t3tools/shared/browserAgent";

import { selectPairingEndpoint } from "./advertisedEndpointSelection";
import { createServerSessionBearerToken } from "./environments/primary";
import { readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { ensureLocalApi } from "./localApi";
import { useUiStateStore } from "./uiStateStore";

export { BROWSER_AGENT_AUTO_PAIR_PATH, BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH };
const AUTO_PAIR_REQUEST_TYPE = "t3code.browserAgent.autoPair";
const AUTO_PAIR_RESULT_TYPE = "t3code.browserAgent.autoPair.result";
const AUTO_PAIR_CONNECT_TIMEOUT_MS = 12_000;
const AUTO_PAIR_CONTENT_SCRIPT_TIMEOUT_MS = 1_500;
const AUTO_PAIR_POLL_INTERVAL_MS = 250;

interface BrowserAgentListClient {
  readonly browserAgents: {
    readonly list: () => Promise<BrowserAgentListResult>;
  };
}

interface WaitForBrowserAgentConnectionOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface AutoPairContentScriptResult {
  readonly ok: boolean;
  readonly error?: string;
}

export class BrowserAgentExtensionUnavailableError extends Error {
  readonly downloadUrl: string;

  constructor(input: { readonly downloadUrl: string; readonly cause?: unknown }) {
    super(
      "The T3 Code Browser Agent Chrome extension is not installed or is not running in this browser.",
    );
    this.name = "BrowserAgentExtensionUnavailableError";
    this.downloadUrl = input.downloadUrl;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function randomRequestId(): string {
  return `browser-agent-auto-pair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sameOriginAsCurrentPage(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

export async function resolveBrowserAgentBackendBaseUrl(): Promise<string> {
  const getAdvertisedEndpoints = window.desktopBridge?.getAdvertisedEndpoints;
  const advertisedEndpoints = getAdvertisedEndpoints
    ? await getAdvertisedEndpoints().catch(() => [])
    : undefined;
  if (advertisedEndpoints && advertisedEndpoints.length > 0) {
    const endpoint = selectPairingEndpoint(
      advertisedEndpoints,
      useUiStateStore.getState().defaultAdvertisedEndpointKey,
    );
    if (endpoint) {
      return normalizeBaseUrl(endpoint.httpBaseUrl);
    }
  }

  const target = readPrimaryEnvironmentTarget();
  if (!target) {
    throw new Error("Unable to resolve the primary environment URL for browser pairing.");
  }
  return normalizeBaseUrl(target.target.httpBaseUrl);
}

export function buildBrowserAgentAutoPairUrl(input: {
  readonly baseUrl: string;
  readonly sessionToken: string;
}): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const url = new URL(BROWSER_AGENT_AUTO_PAIR_PATH, baseUrl);
  url.searchParams.set("t3BrowserAgentPair", "1");
  url.searchParams.set("t3BrowserAgentBaseUrl", baseUrl);
  url.searchParams.set("t3BrowserAgentClose", "1");
  url.hash = new URLSearchParams([["t3BrowserAgentSessionToken", input.sessionToken]]).toString();
  return url.toString();
}

export function buildBrowserAgentExtensionDownloadUrl(input: { readonly baseUrl: string }): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const url = new URL(BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH, baseUrl);
  return url.toString();
}

export function isBrowserAgentExtensionUnavailableError(
  error: unknown,
): error is BrowserAgentExtensionUnavailableError {
  return error instanceof BrowserAgentExtensionUnavailableError;
}

export function isNoBrowserAgentConnectedError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "no-agent-connected"
  ) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /no paired browser extension is connected/i.test(message);
}

async function requestContentScriptPair(input: {
  readonly baseUrl: string;
  readonly sessionToken: string;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  if (!sameOriginAsCurrentPage(input.baseUrl)) {
    return false;
  }

  const requestId = randomRequestId();
  const timeoutMs = input.timeoutMs ?? AUTO_PAIR_CONTENT_SCRIPT_TIMEOUT_MS;

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
    };
    const finish = (result: AutoPairContentScriptResult | null) => {
      if (settled) return;
      cleanup();
      if (!result) {
        resolve(false);
        return;
      }
      if (result.ok) {
        resolve(true);
        return;
      }
      reject(new Error(result.error ?? "The browser extension rejected the pairing request."));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | {
            readonly type?: unknown;
            readonly requestId?: unknown;
            readonly ok?: unknown;
            readonly error?: unknown;
          }
        | undefined;
      if (data?.type !== AUTO_PAIR_RESULT_TYPE || data.requestId !== requestId) {
        return;
      }
      finish({
        ok: data.ok === true,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      });
    };
    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        type: AUTO_PAIR_REQUEST_TYPE,
        requestId,
        baseUrl: input.baseUrl,
        sessionToken: input.sessionToken,
      },
      window.location.origin,
    );
  });
}

export async function waitForBrowserAgentConnection(
  client: BrowserAgentListClient,
  options?: WaitForBrowserAgentConnectionOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? AUTO_PAIR_CONNECT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? AUTO_PAIR_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  do {
    try {
      const snapshot = await client.browserAgents.list();
      if (snapshot.agents.some((agent) => agent.connected)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);

  if (lastError instanceof Error) {
    throw new Error(`Browser extension did not connect after pairing: ${lastError.message}`);
  }
  throw new Error(
    "Browser extension did not connect after pairing. Reload the T3 Code Browser Agent extension and try again.",
  );
}

export async function autoPairBrowserAgent(client: BrowserAgentListClient): Promise<void> {
  const baseUrl = await resolveBrowserAgentBackendBaseUrl();
  const downloadUrl = buildBrowserAgentExtensionDownloadUrl({ baseUrl });
  const session = await createServerSessionBearerToken();
  const pairedInCurrentPage = await requestContentScriptPair({
    baseUrl,
    sessionToken: session.sessionToken,
  });

  if (!pairedInCurrentPage) {
    if (!window.desktopBridge && sameOriginAsCurrentPage(baseUrl)) {
      throw new BrowserAgentExtensionUnavailableError({ downloadUrl });
    }

    await ensureLocalApi().shell.openExternal(
      buildBrowserAgentAutoPairUrl({
        baseUrl,
        sessionToken: session.sessionToken,
      }),
    );
  }

  try {
    await waitForBrowserAgentConnection(client);
  } catch (error) {
    if (!window.desktopBridge && !pairedInCurrentPage) {
      throw new BrowserAgentExtensionUnavailableError({ downloadUrl, cause: error });
    }
    throw error;
  }
}
