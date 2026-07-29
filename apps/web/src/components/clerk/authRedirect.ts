export function resolveClerkAuthRedirectUrl(href: string, isElectron: boolean): string {
  if (!isElectron) return href;
  return new URL("/", href).toString();
}
