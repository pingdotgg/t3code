export function matchesResourceUri(requested: string, returned: string): boolean {
  if (requested === returned) return true;
  try {
    const route = new URL(requested);
    const tokens = route.searchParams.getAll("__cf_mcp_server_id");
    if (route.protocol !== "ui:" || tokens.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(tokens[0]!))
      return false;
    // URLSearchParams.delete re-encodes unrelated query parameters.
    const hashIndex = requested.indexOf("#");
    const beforeHash = hashIndex < 0 ? requested : requested.slice(0, hashIndex);
    const fragment = hashIndex < 0 ? "" : requested.slice(hashIndex);
    const queryIndex = beforeHash.indexOf("?");
    if (queryIndex < 0) return false;
    const parameters = beforeHash.slice(queryIndex + 1).split("&");
    const remaining = parameters.filter(
      (parameter) => new URLSearchParams(parameter).keys().next().value !== "__cf_mcp_server_id",
    );
    const original = `${beforeHash.slice(0, queryIndex)}${remaining.length ? `?${remaining.join("&")}` : ""}${fragment}`;
    const envelope: unknown = JSON.parse(Buffer.from(tokens[0]!, "base64url").toString("utf8"));
    return (
      original === returned &&
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
