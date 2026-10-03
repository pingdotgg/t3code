/** Backend paths forwarded by Vite during browser development. */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/attachments",
] as const;

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
