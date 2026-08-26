/**
 * The server announces its startup URL either as a headless `Pairing URL: <url>`
 * line (apps/server/src/startupAccess.ts, also what `t3 pair` prints) or as a
 * `pairingUrl: <url>` log annotation in web mode (serverRuntimeStartup.ts).
 */
export function parsePairingUrlLine(line: string): string | undefined {
  const match = /^\s*(?:Pairing URL|pairingUrl):\s*(\S+)\s*$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const candidate = match[1];
  if (candidate === undefined) {
    return undefined;
  }
  try {
    return new URL(candidate).href;
  } catch {
    return undefined;
  }
}

export function findPairingUrl(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const url = parsePairingUrlLine(line);
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
}
