/**
 * The desktop app's identity: name, app id, link scheme and user-data folder. Upstream's is the
 * default; a fork passes its own to `resolveAppBrand` (Conn: `forkBrand.json`), and env vars below
 * override single values. The main process uses `appBrand`, baked in at build time
 * (`__T3CODE_APP_BRAND__`); unit tests get upstream's identity.
 */

export type AppBrandStage = "Alpha" | "Beta" | "Dev" | "Nightly";

/** Repo-relative paths of the app icon files one channel (dev or packaged) uses. */
export interface AppBrandIconSet {
  readonly macPng: string;
  readonly universalPng: string;
  readonly windowsIco: string;
  /** The web client's splash logo in a packaged build (the stable channel only). */
  readonly appleTouchPng: string;
}

export interface AppBrandIcons {
  readonly dev: AppBrandIconSet;
  readonly prod: AppBrandIconSet;
}

/** The values a fork file or the environment may set. */
export interface AppBrandSource {
  readonly name?: string;
  readonly appId?: string;
  readonly scheme?: string;
  readonly appleTeamId?: string;
  /** A stage label that is left out of the app name, such as "Beta" for a packaged "Conn". */
  readonly omitStageLabel?: AppBrandStage;
  /** Icon files that replace upstream's; a missing file keeps upstream's. */
  readonly icons?: {
    readonly dev?: Partial<AppBrandIconSet>;
    readonly prod?: Partial<AppBrandIconSet>;
  };
}

/** Where an earlier build of the same app kept its data and links. */
export interface AppBrandPrevious {
  readonly scheme: string;
  readonly devScheme: string;
  readonly userDataDirName: string;
  readonly devUserDataDirName: string;
}

export interface AppBrand {
  readonly name: string;
  readonly appId: string;
  readonly devAppId: string;
  readonly scheme: string;
  readonly devScheme: string;
  readonly userDataDirName: string;
  readonly devUserDataDirName: string;
  readonly appleTeamId: string | null;
  readonly omitStageLabel: AppBrandStage | null;
  readonly icons: AppBrandIcons;
  /** Set when the brand replaces upstream's identity: data is copied over on first launch. */
  readonly previous: AppBrandPrevious | null;
}

export const UPSTREAM_APP_BRAND: AppBrand = {
  // oxlint-disable-next-line t3code/no-hardcoded-app-name -- upstream's default brand name; Conn's build sets its own
  name: "T3 Code",
  appId: "com.t3tools.t3code",
  devAppId: "com.t3tools.t3code.dev",
  scheme: "t3code",
  devScheme: "t3code-dev",
  userDataDirName: "t3code",
  devUserDataDirName: "t3code-dev",
  appleTeamId: null,
  omitStageLabel: null,
  icons: {
    dev: {
      macPng: "assets/dev/blueprint-macos-1024.png",
      universalPng: "assets/dev/blueprint-universal-1024.png",
      windowsIco: "assets/dev/blueprint-windows.ico",
      appleTouchPng: "assets/dev/blueprint-web-apple-touch-180.png",
    },
    prod: {
      macPng: "assets/prod/black-macos-1024.png",
      universalPng: "assets/prod/black-universal-1024.png",
      windowsIco: "assets/prod/t3-black-windows.ico",
      appleTouchPng: "assets/prod/t3-black-web-apple-touch-180.png",
    },
  },
  previous: null,
};

const SCHEME_PATTERN = /^[a-z][a-z0-9]*$/;
const APP_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

type Environment = Readonly<Record<string, string | undefined>>;

function pick(...candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Upstream's identity, replaced by the fork's values, replaced by the environment:
 * `T3CODE_APP_NAME`, `T3CODE_DESKTOP_APP_ID`, `T3CODE_DESKTOP_SCHEME` and
 * `T3CODE_APPLE_TEAM_ID`. The dev app id, dev scheme and user-data folders follow
 * from the production values the same way upstream's do.
 */
export function resolveAppBrand(fork: AppBrandSource | undefined, env: Environment = {}): AppBrand {
  const name = pick(env.T3CODE_APP_NAME, fork?.name) ?? UPSTREAM_APP_BRAND.name;
  const appId = pick(env.T3CODE_DESKTOP_APP_ID, fork?.appId) ?? UPSTREAM_APP_BRAND.appId;
  const scheme = pick(env.T3CODE_DESKTOP_SCHEME, fork?.scheme) ?? UPSTREAM_APP_BRAND.scheme;
  const appleTeamId = pick(env.T3CODE_APPLE_TEAM_ID, fork?.appleTeamId)?.toUpperCase() ?? null;

  if (!SCHEME_PATTERN.test(scheme)) {
    throw new Error(`The desktop link scheme "${scheme}" must be lowercase letters and digits.`);
  }
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(`The desktop app id "${appId}" must be a reverse-DNS identifier.`);
  }
  if (appleTeamId !== null && !APPLE_TEAM_ID_PATTERN.test(appleTeamId)) {
    throw new Error(`The Apple team id "${appleTeamId}" must be 10 letters or digits.`);
  }

  const replacesUpstream = scheme !== UPSTREAM_APP_BRAND.scheme;
  return {
    name,
    appId,
    devAppId: `${appId}.dev`,
    scheme,
    devScheme: `${scheme}-dev`,
    userDataDirName: scheme,
    devUserDataDirName: `${scheme}-dev`,
    appleTeamId,
    omitStageLabel: fork?.omitStageLabel ?? null,
    icons: {
      dev: { ...UPSTREAM_APP_BRAND.icons.dev, ...fork?.icons?.dev },
      prod: { ...UPSTREAM_APP_BRAND.icons.prod, ...fork?.icons?.prod },
    },
    previous: replacesUpstream
      ? {
          scheme: UPSTREAM_APP_BRAND.scheme,
          devScheme: UPSTREAM_APP_BRAND.devScheme,
          userDataDirName: UPSTREAM_APP_BRAND.userDataDirName,
          devUserDataDirName: UPSTREAM_APP_BRAND.devUserDataDirName,
        }
      : null,
  };
}

// A dev runner that started before `icons` existed still bakes a brand without it until it restarts.
declare const __T3CODE_APP_BRAND__:
  | (Omit<AppBrand, "icons"> & { icons?: AppBrandIcons })
  | undefined;

/** The identity of the running app. */
export const appBrand: AppBrand =
  typeof __T3CODE_APP_BRAND__ === "undefined"
    ? UPSTREAM_APP_BRAND
    : { ...__T3CODE_APP_BRAND__, icons: __T3CODE_APP_BRAND__.icons ?? UPSTREAM_APP_BRAND.icons };

/** "T3 Code (Alpha)", or "Conn" for a brand that leaves the Alpha label out. */
export function appBrandDisplayName(brand: AppBrand, stage: AppBrandStage): string {
  return stage === brand.omitStageLabel ? brand.name : `${brand.name} (${stage})`;
}

export function appBrandScheme(brand: AppBrand, isDevelopment: boolean): string {
  return isDevelopment ? brand.devScheme : brand.scheme;
}

/**
 * The link scheme this app took over from, in the same channel (dev or packaged).
 * Links in it still reach the app, and its renderer origin holds the old
 * localStorage until the first launch copies it over.
 */
export function appBrandPreviousScheme(brand: AppBrand, isDevelopment: boolean): string | null {
  if (brand.previous === null) return null;
  return isDevelopment ? brand.previous.devScheme : brand.previous.scheme;
}

/** Every scheme whose links this app handles: its own, then the one it took over from. */
export function appBrandHandledSchemes(brand: AppBrand, isDevelopment: boolean): string[] {
  const previous = appBrandPreviousScheme(brand, isDevelopment);
  const own = appBrandScheme(brand, isDevelopment);
  return previous === null ? [own] : [own, previous];
}

/** A link in the scheme this app took over from, moved to the app's own scheme. */
export function appBrandRewritePreviousScheme(
  brand: AppBrand,
  isDevelopment: boolean,
  url: string,
): string {
  const previous = appBrandPreviousScheme(brand, isDevelopment);
  return previous !== null && url.startsWith(`${previous}://`)
    ? `${appBrandScheme(brand, isDevelopment)}://${url.slice(previous.length + 3)}`
    : url;
}
