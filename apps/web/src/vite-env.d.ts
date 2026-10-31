/// <reference types="vite-plus/client" />

import type { DesktopBridge, ThreadId } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_RELEASE_CHANNEL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_CLERK_JWT_TEMPLATE: string;
  readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID: string;
  readonly VITE_RELAY_OTLP_TRACES_URL: string;
  readonly VITE_RELAY_OTLP_TRACES_DATASET: string;
  readonly VITE_RELAY_OTLP_TRACES_TOKEN: string;
  readonly T3CODE_DESKTOP_UPDATE_REPOSITORY: string;
  readonly T3CODE_FEATURE_SECRETS: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
    /** Dev builds only, from DevReplayHost. Agents call these from the browser console. */
    t3dev?: {
      readonly replayScenarios: () => ReadonlyArray<string>;
      readonly replay: (scenario?: string) => Promise<ThreadId>;
    };
  }
}
