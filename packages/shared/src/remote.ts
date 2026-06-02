const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";

const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

const normalizeRemoteBaseUrl = (rawValue: string): URL => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend URL.");
  }

  const normalizedInput =
    /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) || trimmed.startsWith("//")
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(normalizedInput);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  };
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    const url = new URL(pairingUrl);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(hostedPairingRequest.host);
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new Error("Pairing URL is missing its token.");
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new Error("Enter a backend URL.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }

  const normalizedHost = normalizeRemoteBaseUrl(host);
  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};
