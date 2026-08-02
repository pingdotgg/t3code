import Constants from "expo-constants";
import { Alert, Linking, Platform } from "react-native";

const RELEASE_TAG_PREFIX = "mark-mobile-preview-v";
const PREVIEW_APK_NAME = "t3-code-preview.apk";
const TRUSTED_REPOSITORY = "Feighery89/t3code";

export interface PersonalPreviewUpdate {
  readonly versionCode: number;
  readonly versionName: string;
  readonly downloadUrl: string;
}

export interface PersonalPreviewUpdateClient {
  readonly isEnabled: boolean;
  readonly checkForUpdateAsync: () => Promise<PersonalPreviewUpdate | null>;
  readonly presentUpdateAsync: (update: PersonalPreviewUpdate) => Promise<boolean>;
}

interface PersonalPreviewUpdateConfig {
  readonly latestReleaseApiUrl: string;
}

interface GithubReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

interface GithubReleasePayload {
  readonly draft?: unknown;
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly assets?: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePersonalPreviewUpdateConfig(
  value: unknown,
): PersonalPreviewUpdateConfig | null {
  if (!isRecord(value) || typeof value.latestReleaseApiUrl !== "string") return null;
  const latestReleaseApiUrl = value.latestReleaseApiUrl.trim();
  try {
    const url = new URL(latestReleaseApiUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.github.com" ||
      url.pathname !== `/repos/${TRUSTED_REPOSITORY}/releases/latest` ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { latestReleaseApiUrl };
}

export function parsePersonalPreviewRelease(payload: unknown): PersonalPreviewUpdate {
  if (!isRecord(payload)) throw new Error("The preview release response was invalid.");
  const release = payload as GithubReleasePayload;
  if (release.draft === true || typeof release.tag_name !== "string") {
    throw new Error("The preview release is unavailable.");
  }

  const versionText = release.tag_name.startsWith(RELEASE_TAG_PREFIX)
    ? release.tag_name.slice(RELEASE_TAG_PREFIX.length)
    : "";
  const versionCode = Number(versionText);
  if (!/^\d+$/.test(versionText) || !Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error("The preview release version was invalid.");
  }

  if (!Array.isArray(release.assets)) {
    throw new Error("The preview release did not include an APK.");
  }
  const asset = (release.assets as ReadonlyArray<GithubReleaseAsset>).find(
    (candidate) => candidate.name === PREVIEW_APK_NAME,
  );
  if (typeof asset?.browser_download_url !== "string") {
    throw new Error("The preview release did not include an APK.");
  }

  const downloadUrl = new URL(asset.browser_download_url);
  const trustedPathPrefix = `/${TRUSTED_REPOSITORY}/releases/download/${release.tag_name}/`;
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== "github.com" ||
    downloadUrl.pathname !== `${trustedPathPrefix}${PREVIEW_APK_NAME}` ||
    downloadUrl.search !== "" ||
    downloadUrl.hash !== ""
  ) {
    throw new Error("The preview APK download URL was invalid.");
  }

  return {
    versionCode,
    versionName:
      typeof release.name === "string" && release.name.trim()
        ? release.name.trim()
        : release.tag_name,
    downloadUrl: downloadUrl.toString(),
  };
}

export function selectNewerPersonalPreviewUpdate(
  currentVersionCode: string | null | undefined,
  release: PersonalPreviewUpdate,
): PersonalPreviewUpdate | null {
  const current = Number(currentVersionCode);
  if (!/^\d+$/.test(currentVersionCode ?? "") || !Number.isSafeInteger(current)) {
    throw new Error("The installed preview version was invalid.");
  }
  return release.versionCode > current ? release : null;
}

export function personalPreviewUpdateConfig(): PersonalPreviewUpdateConfig | null {
  if (Platform.OS !== "android") return null;
  return parsePersonalPreviewUpdateConfig(Constants.expoConfig?.extra?.personalPreviewUpdates);
}

export function isPersonalPreviewUpdatesEnabled(): boolean {
  return personalPreviewUpdateConfig() !== null;
}

async function checkForUpdate(
  config: PersonalPreviewUpdateConfig,
): Promise<PersonalPreviewUpdate | null> {
  const response = await fetch(config.latestReleaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not check preview updates (${response.status}).`);
  }
  const release = parsePersonalPreviewRelease(await response.json());
  return selectNewerPersonalPreviewUpdate(Constants.nativeBuildVersion, release);
}

function confirmUpdate(update: PersonalPreviewUpdate): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };
    Alert.alert(
      "T3 Code Preview update",
      `${update.versionName} is ready. Android will verify the app signature before installing it.`,
      [
        { text: "Later", style: "cancel", onPress: () => finish(false) },
        { text: "Download", onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}

export function createPersonalPreviewUpdateClient(): PersonalPreviewUpdateClient | null {
  const config = personalPreviewUpdateConfig();
  if (config === null) return null;
  return {
    isEnabled: true,
    checkForUpdateAsync: () => checkForUpdate(config),
    presentUpdateAsync: async (update) => {
      if (!(await confirmUpdate(update))) return false;
      await Linking.openURL(update.downloadUrl);
      return true;
    },
  };
}
