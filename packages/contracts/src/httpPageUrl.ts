export function httpPageUrl(value: string): URL | null {
  // React Native's URL has no `canParse`.
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch {
    return null;
  }
}
