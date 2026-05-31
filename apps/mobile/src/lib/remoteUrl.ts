import * as Effect from "effect/Effect";

import { normalizeBasePath } from "@t3tools/shared/basePath";

export function resolveRemoteHttpUrl(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly searchParams?: Readonly<Record<string, string | null | undefined>>;
}): string {
  const url = new URL(input.httpBaseUrl);
  const basePath = Effect.runSync(normalizeBasePath(url.pathname));
  const pathname = input.pathname.startsWith("/") ? input.pathname : `/${input.pathname}`;

  url.pathname = `${basePath}${pathname}`;
  url.search = "";
  url.hash = "";

  for (const [key, value] of Object.entries(input.searchParams ?? {})) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}
