export function matchesResourceUri(requested: string, returned: string): boolean {
  if (requested === returned) return true;
  try {
    const route = new URL(requested);
    const tokens = route.searchParams.getAll("__cf_mcp_server_id");
    if (route.protocol !== "ui:" || tokens.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(tokens[0]!))
      return false;
    route.searchParams.delete("__cf_mcp_server_id");
    const envelope: unknown = JSON.parse(Buffer.from(tokens[0]!, "base64url").toString("utf8"));
    return (
      route.href === returned &&
      typeof envelope === "object" &&
      envelope !== null &&
      "v" in envelope &&
      envelope.v === 1 &&
      "serverId" in envelope &&
      typeof envelope.serverId === "string" &&
      envelope.serverId.length > 0 &&
      "uri" in envelope &&
      envelope.uri === returned
    );
  } catch {
    return false;
  }
}
