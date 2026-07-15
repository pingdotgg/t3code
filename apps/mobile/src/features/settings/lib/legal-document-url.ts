const DEFAULT_MARKETING_SITE_URL = "https://t3.codes";

function resolveMarketingSiteUrl(override: string | undefined): URL {
  try {
    const url = new URL(override?.trim() || DEFAULT_MARKETING_SITE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return new URL(DEFAULT_MARKETING_SITE_URL);
    }

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return new URL(DEFAULT_MARKETING_SITE_URL);
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function marketingSiteDocumentUrl(path: string): string {
  return new URL(path, MARKETING_SITE_URL).toString();
}

export const PRIVACY_POLICY_URL = marketingSiteDocumentUrl("privacy-policy");
export const SECURITY_POLICY_URL = marketingSiteDocumentUrl("security-policy");
export const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("terms-of-service");
export const LEGAL_URL = marketingSiteDocumentUrl("legal");
