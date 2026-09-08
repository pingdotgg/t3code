/**
 * Header carrying a JSON-serialised `request.cf` object into the runtime.
 * When present on an incoming request, the entry middleware uses it verbatim
 * as the user worker's `request.cf`; it is also set by workerd on loopback
 * requests (via `cfBlobHeader`) so `request.cf` round-trips to Node-side
 * handlers. Named for compatibility with Miniflare's `MF-CF-Blob` header,
 * which tooling (e.g. Wrangler's `getPlatformProxy`) already uses.
 */
export const HEADER_CF_BLOB = "MF-CF-Blob";

/**
 * Default `request.cf` object, matching Miniflare's fallback blob
 * (`workers-sdk/packages/miniflare/src/cf.ts`).
 */
export const fallbackCf: Record<string, unknown> = {
  asOrganization: "",
  asn: 395747,
  colo: "DFW",
  city: "Austin",
  region: "Texas",
  regionCode: "TX",
  metroCode: "635",
  postalCode: "78701",
  country: "US",
  continent: "NA",
  timezone: "America/Chicago",
  latitude: "30.27130",
  longitude: "-97.74260",
  clientTcpRtt: 0,
  httpProtocol: "HTTP/1.1",
  requestPriority: "weight=192;exclusive=0",
  tlsCipher: "AEAD-AES128-GCM-SHA256",
  tlsVersion: "TLSv1.3",
  tlsClientAuth: {
    certPresented: "0",
    certVerified: "NONE",
    certRevoked: "0",
    certIssuerDN: "",
    certSubjectDN: "",
    certIssuerDNRFC2253: "",
    certSubjectDNRFC2253: "",
    certIssuerDNLegacy: "",
    certSubjectDNLegacy: "",
    certSerial: "",
    certIssuerSerial: "",
    certSKI: "",
    certIssuerSKI: "",
    certFingerprintSHA1: "",
    certFingerprintSHA256: "",
    certNotBefore: "",
    certNotAfter: "",
    certRFC9440: "",
    certRFC9440TooLarge: false,
    certChainRFC9440: "",
    certChainRFC9440TooLarge: false,
  },
  edgeRequestKeepAliveStatus: 0,
  hostMetadata: undefined,
  clientTrustScore: 99,
  botManagement: {
    corporateProxy: false,
    verifiedBot: false,
    ja3Hash: "25b4882c2bcb50cd6b469ff28c596742",
    staticResource: false,
    detectionIds: [],
    score: 99,
  },
};
