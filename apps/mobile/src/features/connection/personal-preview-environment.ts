import Constants from "expo-constants";

const BUILD_DEFAULT_ENVIRONMENT_HOST =
  process.env.EXPO_PUBLIC_T3CODE_PERSONAL_PREVIEW_DEFAULT_ENVIRONMENT_HOST;

export function parsePersonalPreviewDefaultEnvironmentHost(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function personalPreviewDefaultEnvironmentHost(): string {
  return parsePersonalPreviewDefaultEnvironmentHost(
    BUILD_DEFAULT_ENVIRONMENT_HOST ??
      Constants.expoConfig?.extra?.personalPreviewDefaultEnvironmentHost,
  );
}
