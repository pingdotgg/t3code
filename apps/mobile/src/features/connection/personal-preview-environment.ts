import Constants from "expo-constants";

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
    Constants.expoConfig?.extra?.personalPreviewDefaultEnvironmentHost,
  );
}
