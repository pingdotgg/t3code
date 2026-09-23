import type { ExtensionInstallSource } from "@t3tools/contracts";

const NAME_PART = "[a-z0-9][a-z0-9-_.]*";
const ID_PATTERN = new RegExp(`^(${NAME_PART})\\.([a-z0-9][a-z0-9-_]*)(?:@([^\\s@/]+))?$`, "i");
const VERSION_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}$/i;

type OpenVsxSource = Extract<ExtensionInstallSource, { type: "openVsx" }>;

function source(namespace: string, name: string, version?: string): OpenVsxSource | null {
  const namePart = new RegExp(`^${NAME_PART}$`, "i");
  if (!namePart.test(namespace) || !namePart.test(name)) return null;
  if (namespace.length > 128 || name.length > 128) return null;
  if (version === undefined) return { type: "openVsx", namespace, name };
  return VERSION_PATTERN.test(version) ? { type: "openVsx", namespace, name, version } : null;
}

function fromId(id: string): OpenVsxSource | null {
  const match = ID_PATTERN.exec(id);
  return match ? source(match[1]!, match[2]!, match[3]) : null;
}

export function parseExtensionReference(input: string): OpenVsxSource | null {
  const text = input.trim();
  if (text.toLowerCase().startsWith("vscode:extension/")) {
    return fromId(text.slice("vscode:extension/".length));
  }
  if (!/^https?:\/\//i.test(text)) return fromId(text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "open-vsx.org" || host === "www.open-vsx.org") {
    const [kind, namespace, name, version, ...rest] = url.pathname.split("/").filter(Boolean);
    if (kind !== "extension" || !namespace || !name || rest.length > 0) return null;
    try {
      return source(decodeURIComponent(namespace), decodeURIComponent(name), version);
    } catch {
      return null;
    }
  }
  if (host === "marketplace.visualstudio.com" && url.pathname.replace(/\/$/, "") === "/items") {
    const itemName = url.searchParams.get("itemName");
    return itemName && !itemName.includes("@") ? fromId(itemName) : null;
  }
  return null;
}
