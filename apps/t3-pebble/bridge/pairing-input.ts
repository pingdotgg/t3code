export function pairingCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  try {
    let url = new URL(value);
    if (/^t3code(?:-[a-z]+)?:$/.test(url.protocol) && url.hostname === "pair") {
      const nested = url.searchParams.get("pairingUrl");
      if (!nested) return null;
      url = new URL(nested);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return new URLSearchParams(url.hash.slice(1)).get("token")?.trim() || url.searchParams.get("token")?.trim() || null;
  } catch { return null; }
}
