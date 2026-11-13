// A small MCP client over Streamable HTTP, and the two ways to get a credential for `/mcp`
// from outside a thread. Shared by parity.mjs and probe runs; no dependencies.
import * as NodeCrypto from "node:crypto";

const PROTOCOL = "2025-06-18";

/** Exchanges a startup pairing code for an environment bearer token (`/oauth/token`). */
export async function pairBearer(origin, code) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
  const response = await fetch(`${origin}/oauth/token`, { method: "POST", body });
  const json = await response.json();
  if (!response.ok) throw new Error(`pairing failed ${response.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

/**
 * The TypeScript server's outside-client path: an MCP approval code from
 * `/api/auth/pairing-token`, then OAuth (register, decision, PKCE token exchange).
 */
export async function oauthMcpToken(origin, bearer, access = "full-access") {
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  const approval = await post(
    "/api/auth/pairing-token",
    { label: "conn-mcp parity", access },
    { authorization: `Bearer ${bearer}` },
  );
  const redirectUri = "http://127.0.0.1:9/callback";
  const client = await post("/oauth/mcp/register", {
    client_name: "conn-mcp parity",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  });
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    resource: `${origin}/mcp`,
  };
  const decided = await post("/oauth/mcp/decision", {
    authorization,
    decision: { _tag: "pairing-code", access, code: approval.credential },
  });
  const code = new URL(decided.redirectTo).searchParams.get("code");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  });
  const response = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: form });
  const token = await response.json();
  if (!response.ok) throw new Error(`token ${response.status}: ${JSON.stringify(token)}`);
  return token.access_token;
}

/** Reads one JSON-RPC reply from a JSON or SSE body. */
function readReply(contentType, text) {
  if (contentType?.startsWith("text/event-stream")) {
    const messages = text
      .split("\n")
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "")
      .map((line) => JSON.parse(line.slice(5)));
    return messages.find((m) => "result" in m || "error" in m) ?? messages.at(-1);
  }
  return text.length === 0 ? undefined : JSON.parse(text);
}

export class McpSession {
  constructor(origin, authorization, extraHeaders = {}) {
    this.endpoint = `${origin}/mcp`;
    this.authorization = authorization;
    this.extraHeaders = extraHeaders;
    this.sessionId = null;
    this.nextId = 1;
    this.log = [];
  }

  headers() {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: this.authorization,
      ...(this.sessionId === null ? {} : { "mcp-session-id": this.sessionId }),
      ...(this.sessionId === null ? {} : { "mcp-protocol-version": PROTOCOL }),
      ...this.extraHeaders,
    };
  }

  async raw(message) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type");
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const entry = {
      method: message.method,
      status: response.status,
      contentType,
      sessionHeader: response.headers.get("mcp-session-id") !== null,
      protocolHeader: response.headers.get("mcp-protocol-version"),
    };
    this.log.push(entry);
    return {
      ...entry,
      reply: response.status >= 400 && text === "" ? undefined : readReply(contentType, text),
    };
  }

  async initialize() {
    const { reply } = await this.raw({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "conn-mcp-parity", version: "0" },
      },
    });
    await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
    return reply;
  }

  async request(method, params) {
    const { reply, status } = await this.raw({ jsonrpc: "2.0", id: this.nextId++, method, params });
    if (reply === undefined) throw new Error(`${method}: HTTP ${status} with no body`);
    return reply;
  }

  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    if (this.sessionId === null) return undefined;
    const response = await fetch(this.endpoint, { method: "DELETE", headers: this.headers() });
    return response.status;
  }
}
