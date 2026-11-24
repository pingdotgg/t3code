import { FORK_REPOSITORY_URL } from "@t3tools/shared/cliRelease";

export const LEGAL_URL = `${FORK_REPOSITORY_URL}/blob/main/docs/user/telemetry.md`;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const LEGAL_DOCUMENT_IDENTITY = webDocumentIdentity(LEGAL_URL);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && identity === LEGAL_DOCUMENT_IDENTITY;
}
