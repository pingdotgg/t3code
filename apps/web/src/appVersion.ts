export function resolveDisplayedAppVersion(input: {
  buildVersion: string;
  desktopAppVersion: string | null | undefined;
}): string {
  const desktopAppVersion = input.desktopAppVersion?.trim();
  if (desktopAppVersion) {
    return desktopAppVersion;
  }

  return input.buildVersion;
}
