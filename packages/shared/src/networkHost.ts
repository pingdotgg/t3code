export const isLoopbackAddress = (host: string | undefined): boolean => {
  if (!host) return false;
  if (host === "::1" || host === "[::1]") return true;

  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number.parseInt(octet, 10) <= 255,
    )
  );
};

export const isLoopbackHost = (host: string | undefined): boolean =>
  host === "localhost" || isLoopbackAddress(host);

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
