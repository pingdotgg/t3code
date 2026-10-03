const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "linux-x64",
  "linux-arm64",
]);

export function isSpeechPlatformSupported(platform: string, architecture: string): boolean {
  return SUPPORTED_PLATFORMS.has(`${platform}-${architecture}`);
}
