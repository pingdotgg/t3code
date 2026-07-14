// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap validates Android push credentials before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

type Environment = Readonly<Record<string, string | undefined>>;

// Resolved from this module's location (scripts/lib/ -> repo root) rather than
// in app.config.ts: Expo's config loader compiles the entry app.config.ts to
// CJS, where import.meta is unavailable, but imported modules keep it.
const MOBILE_APP_ROOT = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)))),
  "apps",
  "mobile",
);

export const ANDROID_GOOGLE_SERVICES_ENV_VAR = "T3CODE_ANDROID_GOOGLE_SERVICES_FILE";

// Without google-services.json in the APK, expo-notifications cannot mint an
// Android push token, so T3 Connect device registration silently degrades to
// notificationsEnabled=false. Preview is the distributed internal build where
// that regression already shipped once, so its Android EAS builds must fail
// fast instead. Development stays optional (no FCM app is registered for the
// .dev package), and production is enforced once its Firebase app exists.
const VARIANTS_REQUIRING_ANDROID_PUSH: ReadonlySet<string> = new Set(["preview"]);

export interface ResolveAndroidGoogleServicesFileInput {
  readonly env: Environment;
  readonly appVariant: string;
  readonly androidPackage: string;
  /** Directory that relative T3CODE_ANDROID_GOOGLE_SERVICES_FILE values resolve against. */
  readonly appRoot?: string;
}

/**
 * Resolves the google-services.json path for the Expo config's
 * `android.googleServicesFile` from T3CODE_ANDROID_GOOGLE_SERVICES_FILE.
 *
 * The variable is an EAS "file" environment variable with sensitive
 * visibility: EAS build workers inject it as an absolute path, and
 * `eas env:pull` downloads it for the CI fingerprint check. Returns undefined
 * when unset, except for Android EAS builds of variants that require push,
 * which fail fast so a preview APK can never build with broken notifications.
 */
export function resolveAndroidGoogleServicesFile({
  env,
  appVariant,
  androidPackage,
  appRoot = MOBILE_APP_ROOT,
}: ResolveAndroidGoogleServicesFileInput): string | undefined {
  const configuredPath = env[ANDROID_GOOGLE_SERVICES_ENV_VAR]?.trim();

  if (!configuredPath) {
    const isEasAndroidBuild = env.EAS_BUILD === "true" && env.EAS_BUILD_PLATFORM === "android";
    if (VARIANTS_REQUIRING_ANDROID_PUSH.has(appVariant) && isEasAndroidBuild) {
      throw new Error(
        `${ANDROID_GOOGLE_SERVICES_ENV_VAR} is not set, so this ${appVariant} Android build would ship without FCM configuration and Expo push tokens (T3 Connect notifications) would never work. ` +
          `Upload the Firebase google-services.json for ${androidPackage} to the EAS ${appVariant} environment as a file variable with sensitive visibility: ` +
          `eas env:create --environment ${appVariant} --name ${ANDROID_GOOGLE_SERVICES_ENV_VAR} --type file --visibility sensitive --value ./google-services.json`,
      );
    }
    return undefined;
  }

  const googleServicesPath = NodePath.isAbsolute(configuredPath)
    ? configuredPath
    : NodePath.resolve(appRoot, configuredPath);

  if (!NodeFS.existsSync(googleServicesPath)) {
    throw new Error(
      `${ANDROID_GOOGLE_SERVICES_ENV_VAR} points to '${googleServicesPath}', but no file exists there. ` +
        `On EAS the variable must be a file-type environment variable; locally it must point at a downloaded google-services.json (try 'eas env:pull ${appVariant}' from apps/mobile).`,
    );
  }

  const registeredPackages = readRegisteredAndroidPackages(googleServicesPath);
  if (!registeredPackages.includes(androidPackage)) {
    const found = registeredPackages.length > 0 ? registeredPackages.join(", ") : "none";
    throw new Error(
      `The google-services.json at '${googleServicesPath}' does not register the Android package '${androidPackage}' (registered packages: ${found}). ` +
        `Add an Android app with package name ${androidPackage} to the Firebase project and upload its regenerated google-services.json.`,
    );
  }

  return googleServicesPath;
}

function readRegisteredAndroidPackages(googleServicesPath: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(googleServicesPath, "utf8"));
  } catch (error) {
    throw new Error(
      `The google-services.json at '${googleServicesPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const clients = (parsed as { client?: unknown }).client;
  if (!Array.isArray(clients)) {
    return [];
  }

  const packages: Array<string> = [];
  for (const client of clients) {
    if (typeof client !== "object" || client === null) {
      continue;
    }
    const clientInfo = (client as { client_info?: unknown }).client_info;
    if (typeof clientInfo !== "object" || clientInfo === null) {
      continue;
    }
    const androidClientInfo = (clientInfo as { android_client_info?: unknown }).android_client_info;
    if (typeof androidClientInfo !== "object" || androidClientInfo === null) {
      continue;
    }
    const packageName = (androidClientInfo as { package_name?: unknown }).package_name;
    if (typeof packageName === "string" && packageName.trim()) {
      packages.push(packageName.trim());
    }
  }
  return packages;
}
