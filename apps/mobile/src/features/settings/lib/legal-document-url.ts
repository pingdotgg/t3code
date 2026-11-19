import Constants from "expo-constants";

const DEFAULT_MARKETING_SITE_URL = "https://t3.codes";

/** A standalone build shows legal documents only from its own site; T3's describe T3's services. */
export function resolveMarketingSiteUrl(
  override: string | undefined,
  standalone: boolean,
): URL | null {
  const fallback = standalone ? null : new URL(DEFAULT_MARKETING_SITE_URL);
  try {
    const url = new URL(override?.trim() ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return fallback;
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(
  process.env.EXPO_PUBLIC_MARKETING_SITE_URL,
  Constants.expoConfig?.extra?.standalone === true,
);

function marketingSiteDocumentUrl(path: string): string | null {
  return MARKETING_SITE_URL && new URL(path, MARKETING_SITE_URL).toString();
}

const PRIVACY_POLICY_URL = marketingSiteDocumentUrl("privacy-policy");
const SECURITY_POLICY_URL = marketingSiteDocumentUrl("security-policy");
const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("terms-of-service");
/** Null when this build has no legal documents to show. */
export const LEGAL_URL = marketingSiteDocumentUrl("legal");

const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

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

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map((url) => url && webDocumentIdentity(url)).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
