import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

let desktopBearerTokenPromise: Promise<string> | null = null;
let desktopBearerTokenConfigKey: string | null = null;
let desktopBearerTokenGeneration = 0;

function readDesktopPrimaryConfigKey(): string {
  const primary = window.desktopBridge
    ?.getLocalEnvironmentBootstraps?.()
    .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  return [
    primary?.httpBaseUrl ?? "",
    primary?.bootstrapToken ?? "",
    primary?.authSessionKey ?? "",
  ].join("\u0000");
}

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  const configKey = readDesktopPrimaryConfigKey();
  if (desktopBearerTokenPromise !== null && desktopBearerTokenConfigKey === configKey) {
    return desktopBearerTokenPromise;
  }

  const generation = desktopBearerTokenGeneration + 1;
  desktopBearerTokenGeneration = generation;
  desktopBearerTokenConfigKey = configKey;
  desktopBearerTokenPromise = bridge.getLocalEnvironmentBearerToken().catch((error) => {
    if (desktopBearerTokenGeneration === generation) {
      desktopBearerTokenPromise = null;
      desktopBearerTokenConfigKey = null;
    }
    throw error;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
  desktopBearerTokenConfigKey = null;
  desktopBearerTokenGeneration += 1;
}
