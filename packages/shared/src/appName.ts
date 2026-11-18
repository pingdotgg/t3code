// Conn: UI copy names the product as `{appName}` filled from `appName()`, never as a literal
// (lint rule t3code/no-hardcoded-app-name). See FORK.md, "i18n and the app name".
const DEFAULT_APP_NAME = "T3 Code";

let current: string | null = null;

interface BrandingBridge {
  readonly desktopBridge?: {
    readonly getAppBranding?: () => { readonly baseName?: string } | null;
  };
}

/** Mobile sets the name from its Expo config before any screen module loads. */
export function setAppName(name: string | null | undefined): void {
  const trimmed = name?.trim();
  current = trimmed ? trimmed : null;
}

/** The desktop renderer reads the bridge directly, so module-level messages get it too. */
export function appName(): string {
  if (current !== null) return current;
  const injected = (globalThis as BrandingBridge).desktopBridge
    ?.getAppBranding?.()
    ?.baseName?.trim();
  return injected ? injected : DEFAULT_APP_NAME;
}
