import { Clerk } from "@clerk/clerk-js";
import {
  buildClerkUIScriptAttributes,
  clerkUIScriptUrl,
  InternalClerkProvider,
} from "@clerk/react/internal";
import type { ClerkProviderProps } from "@clerk/react";
import {
  clerkFrontendApiHostnameFromPublishableKey,
  isAllowedClerkFrontendApiHostname,
} from "@t3tools/shared/relayAuth";
import React, { useEffect, useState } from "react";

import {
  makeDesktopClerkExternalAccountAdapter,
  type DesktopClerkUser,
} from "./desktopClerkExternalAccounts";

type DesktopClerkUiCtor = NonNullable<Window["__internal_ClerkUICtor"]>;

interface ClerkFrontendApiRequest {
  credentials?: RequestCredentials;
  headers?: Headers;
  url?: URL;
}

interface ClerkFrontendApiResponse {
  headers: Headers;
  payload?: {
    errors?: readonly {
      code?: string;
    }[];
  };
}

interface NativeRequestClerk {
  readonly publishableKey?: string;
  __internal_onBeforeRequest?: (
    listener: (request: ClerkFrontendApiRequest) => void | Promise<void>,
  ) => void;
  __internal_onAfterResponse?: (
    listener: (
      request: ClerkFrontendApiRequest,
      response?: ClerkFrontendApiResponse,
    ) => void | Promise<void>,
  ) => void;
  __unstable__onBeforeRequest?: (
    listener: (request: ClerkFrontendApiRequest) => void | Promise<void>,
  ) => void;
  __unstable__onAfterResponse?: (
    listener: (
      request: ClerkFrontendApiRequest,
      response?: ClerkFrontendApiResponse,
    ) => void | Promise<void>,
  ) => void;
}

interface DesktopClerkProviderProps {
  readonly children: React.ReactNode;
  readonly publishableKey: string;
}

let desktopClerk: Clerk | null = null;
let desktopClerkFetchInstalled = false;
let desktopClerkUiLoad: Promise<DesktopClerkUiCtor> | null = null;
let desktopClerkFrontendApiHostname: string | null = null;
let desktopClerkExternalAccountCleanup: (() => void) | null = null;

const isNativeRequestClerk = (value: unknown): value is NativeRequestClerk => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    __internal_onBeforeRequest?: unknown;
    __internal_onAfterResponse?: unknown;
    __unstable__onBeforeRequest?: unknown;
    __unstable__onAfterResponse?: unknown;
  };
  return (
    (typeof candidate.__internal_onBeforeRequest === "function" ||
      typeof candidate.__unstable__onBeforeRequest === "function") &&
    (typeof candidate.__internal_onAfterResponse === "function" ||
      typeof candidate.__unstable__onAfterResponse === "function")
  );
};

const getStoredClientJwt = (): Promise<string | null> =>
  window.desktopBridge?.getCloudAuthToken() ?? Promise.resolve(null);

const setStoredClientJwt = (token: string): Promise<boolean> =>
  window.desktopBridge?.setCloudAuthToken(token) ?? Promise.resolve(false);

const clearStoredClientJwt = (): Promise<void> =>
  window.desktopBridge?.clearCloudAuthToken() ?? Promise.resolve();

const isClerkFrontendApiUrl = (url: URL): boolean =>
  url.protocol === "https:" &&
  isAllowedClerkFrontendApiHostname(url.hostname, desktopClerkFrontendApiHostname);

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

function installDesktopClerkFetchProxy(publishableKey: string): void {
  desktopClerkFrontendApiHostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
  if (desktopClerkFetchInstalled) return;
  const bridge = window.desktopBridge;
  if (!bridge) return;

  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!isClerkFrontendApiUrl(url)) {
      return browserFetch(input, init);
    }

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().text();
    const result = await bridge.fetchCloudAuth({
      url: request.url,
      method: request.method,
      headers: headersToRecord(request.headers),
      ...(body === undefined ? {} : { body }),
    });

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
  desktopClerkFetchInstalled = true;
}

function installDesktopClerkExternalAccounts(clerk: Clerk): void {
  desktopClerkExternalAccountCleanup?.();
  desktopClerkExternalAccountCleanup = null;

  const bridge = window.desktopBridge;
  if (!bridge) return;

  const adapter = makeDesktopClerkExternalAccountAdapter({ bridge });
  const unsubscribe = clerk.addListener(({ user }) => {
    if (user) {
      adapter.installUser(user as DesktopClerkUser);
    }
  });
  desktopClerkExternalAccountCleanup = () => {
    unsubscribe();
    adapter.dispose();
  };
}

function loadDesktopClerkUi(publishableKey: string): Promise<DesktopClerkUiCtor> {
  if (window.__internal_ClerkUICtor) {
    return Promise.resolve(window.__internal_ClerkUICtor);
  }
  if (desktopClerkUiLoad) {
    return desktopClerkUiLoad;
  }

  const load = new Promise<DesktopClerkUiCtor>((resolve, reject) => {
    const scriptUrl = clerkUIScriptUrl({ publishableKey });
    const existingScript = document.querySelector<HTMLScriptElement>(
      "script[data-clerk-ui-script]",
    );

    const resolveLoadedUi = () => {
      const ClerkUI = window.__internal_ClerkUICtor;
      if (ClerkUI) {
        resolve(ClerkUI);
        return true;
      }
      return false;
    };
    if (resolveLoadedUi()) {
      return;
    }

    const script = existingScript ?? document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = scriptUrl;
    script.dataset.clerkUiScript = "true";
    const attributes = buildClerkUIScriptAttributes({ publishableKey });
    for (const [name, value] of Object.entries(attributes)) {
      script.setAttribute(name, value);
    }

    const timeoutId = window.setTimeout(() => {
      reject(new Error("Timed out loading Clerk UI for desktop auth."));
    }, 15_000);
    script.addEventListener("load", () => {
      window.clearTimeout(timeoutId);
      if (!resolveLoadedUi()) {
        reject(new Error("Clerk UI loaded without exposing the UI constructor."));
      }
    });
    script.addEventListener("error", () => {
      window.clearTimeout(timeoutId);
      reject(new Error("Failed to load Clerk UI for desktop auth."));
    });
    if (!existingScript) {
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    desktopClerkUiLoad = null;
    throw error;
  });

  desktopClerkUiLoad = load;
  return load;
}

function getDesktopClerkInstance(publishableKey: string): Clerk {
  installDesktopClerkFetchProxy(publishableKey);

  const hasKeyChanged = desktopClerk !== null && desktopClerk.publishableKey !== publishableKey;
  if (hasKeyChanged) {
    void clearStoredClientJwt();
    desktopClerkExternalAccountCleanup?.();
    desktopClerkExternalAccountCleanup = null;
    desktopClerk = null;
  }

  if (desktopClerk !== null) {
    return desktopClerk;
  }

  const nextClerk = new Clerk(publishableKey);
  installDesktopClerkExternalAccounts(nextClerk);
  if (!isNativeRequestClerk(nextClerk)) {
    desktopClerk = nextClerk;
    return nextClerk;
  }

  const onBeforeRequest =
    nextClerk.__internal_onBeforeRequest ?? nextClerk.__unstable__onBeforeRequest;
  const onAfterResponse =
    nextClerk.__internal_onAfterResponse ?? nextClerk.__unstable__onAfterResponse;

  // Keep this aligned with Clerk Expo's native FAPI adapter:
  // https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/expo/src/provider/singleton/createClerkInstance.ts
  onBeforeRequest(async (request) => {
    request.credentials = "omit";
    request.url?.searchParams.append("_is_native", "1");
    const headers = new Headers(request.headers);

    const clientJwt = await getStoredClientJwt();
    headers.set("authorization", clientJwt ?? "");
    headers.set("x-mobile", "1");
    request.headers = headers;
  });

  onAfterResponse(async (_request, response) => {
    const clientJwt = response?.headers.get("authorization");
    if (clientJwt) {
      await setStoredClientJwt(clientJwt);
    }

    const errorCode = response?.payload?.errors?.[0]?.code;
    if (errorCode === "native_api_disabled") {
      console.error(
        "Clerk Native API is disabled. Enable Native applications in the Clerk dashboard for desktop sign-in.",
      );
    }
  });

  desktopClerk = nextClerk;
  return nextClerk;
}

export function DesktopClerkProvider({ children, publishableKey }: DesktopClerkProviderProps) {
  const [clerkUiCtor, setClerkUiCtor] = useState<DesktopClerkUiCtor | undefined>(
    () => window.__internal_ClerkUICtor,
  );
  const [clerkUiError, setClerkUiError] = useState<unknown>(null);

  useEffect(() => {
    let isCurrent = true;
    void loadDesktopClerkUi(publishableKey).then(
      (ClerkUI) => {
        if (isCurrent) {
          setClerkUiCtor(() => ClerkUI);
        }
      },
      (error: unknown) => {
        if (isCurrent) {
          setClerkUiError(error);
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [publishableKey]);

  if (!clerkUiCtor) {
    if (clerkUiError) {
      console.error("Failed to load Clerk UI for desktop auth.", clerkUiError);
    }
    return null;
  }

  const clerk = getDesktopClerkInstance(publishableKey);
  return (
    <InternalClerkProvider
      key={publishableKey}
      publishableKey={publishableKey}
      Clerk={clerk as ClerkProviderProps["Clerk"]}
      ui={{ ClerkUI: clerkUiCtor }}
      standardBrowser={false}
    >
      {children}
    </InternalClerkProvider>
  );
}
