import { SharedMcpServer, sharedMcpServerKey } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const decodeSharedMcpServer = Schema.decodeUnknownExit(SharedMcpServer);

/**
 * A new server's id: its name, or the name with a suffix when that key is
 * still held by a renamed server. Unique within the list, which is all the
 * secret store needs.
 */
function newSharedMcpServerId(saved: ReadonlyArray<SharedMcpServer>, name: string): string {
  const taken = new Set(saved.map(sharedMcpServerKey));
  let id = name;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${name}-${suffix}`;
  return id;
}

/** The add/edit form for one shared MCP server, as typed by the user. */
export interface SharedMcpServerDraft {
  readonly name: string;
  readonly url: string;
  /** One `Name: value` header per line. */
  readonly headers: string;
}

/**
 * Headers as editable text. Saved values arrive redacted; leaving a line
 * untouched sends the marker back, which keeps the stored value.
 */
function formatSharedMcpServerHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** Draft for editing a saved server. */
export function sharedMcpServerDraft(server: SharedMcpServer): SharedMcpServerDraft {
  return {
    name: server.name,
    url: server.url,
    headers: formatSharedMcpServerHeaders(server.headers),
  };
}

/**
 * Validate a draft against the settings schema and the other saved servers.
 * `editing` names the server being replaced, so it may keep its own name.
 */
export function parseSharedMcpServerDraft(
  saved: ReadonlyArray<SharedMcpServer>,
  draft: SharedMcpServerDraft,
  editing?: SharedMcpServer,
): { readonly server: SharedMcpServer } | { readonly error: string } {
  const name = draft.name.trim();
  if (name === "t3-code") return { error: "t3-code is T3 Code's own server." };
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
    return { error: "Use up to 24 letters, numbers, dashes, or underscores for the name." };
  }
  if (saved.some((server) => server.name === name && server.name !== editing?.name)) {
    return { error: `A server named ${name} already exists.` };
  }
  const headers: Record<string, string> = {};
  for (const line of draft.headers.split("\n")) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    const headerName = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
      return { error: `Write each header as "Name: value" (got "${line.trim()}").` };
    }
    if (Object.keys(headers).some((name) => name.toLowerCase() === headerName.toLowerCase())) {
      return { error: `The ${headerName} header is listed twice.` };
    }
    headers[headerName] = line.slice(separator + 1).trim();
  }
  const decoded = decodeSharedMcpServer({
    // Header secrets are stored under the id, so an edit keeps the saved
    // server's (or its name, for an entry saved without one) through a rename.
    id: editing === undefined ? newSharedMcpServerId(saved, name) : sharedMcpServerKey(editing),
    name,
    url: draft.url.trim(),
    enabled: editing?.enabled ?? true,
    headers,
  });
  if (Exit.isFailure(decoded)) return { error: "Enter an http:// or https:// URL." };
  return { server: decoded.value };
}

/** Replace `editing` (or append) and return the next saved list. */
export function upsertSharedMcpServer(
  saved: ReadonlyArray<SharedMcpServer>,
  server: SharedMcpServer,
  editing?: SharedMcpServer,
): ReadonlyArray<SharedMcpServer> {
  if (editing === undefined) return [...saved, server];
  return saved.map((entry) => (entry.name === editing.name ? server : entry));
}
