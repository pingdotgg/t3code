// Decides what the board page shows for a hostname, query and framing; the Vite server uses it too.
export type OpenView = "board" | "chat" | "app";

export type PageMode =
  | { kind: "export" }
  | { kind: "embed" }
  | { kind: "redirect"; to: "/chat/" }
  | { kind: "split"; start: "board" | "chat" | "remembered" };

export function pageMode({
  hostname,
  search,
  framed,
  openViews,
}: {
  hostname: string;
  search: string;
  framed: boolean;
  openViews: Record<string, OpenView>;
}): PageMode {
  const params = new URLSearchParams(search);
  if (params.has("export")) return { kind: "export" };
  // At top level an embed link shows the normal page, so a copied panel URL never loses the chat.
  if (params.get("embed") === "panel" && framed) return { kind: "embed" };
  const openView = Object.hasOwn(openViews, hostname) ? openViews[hostname] : undefined;
  if (openView === "app" && params.size === 0) return { kind: "redirect", to: "/chat/" };
  if (openView === "board" || openView === "app") return { kind: "split", start: "board" };
  if (openView === "chat") return { kind: "split", start: "chat" };
  return { kind: "split", start: "remembered" };
}

/** The hostname in a Host header, without its port; IPv6 literals keep their brackets like `location.hostname`. */
export function hostHeaderName(host: string): string {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return name.toLowerCase();
}
