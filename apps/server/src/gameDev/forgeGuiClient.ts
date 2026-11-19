// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
/**
 * ForgeGUI's supported connection: its hosted MCP server over Streamable HTTP, authenticated with
 * the user's scoped ForgeGUI API key. Continuum keeps the key on the server and calls the tools on
 * the agent's behalf, so the key never reaches the agent, the transcript, or logs.
 * See https://github.com/elwinhe/forgegui-plugins (SETUP.md) for the endpoint and scopes.
 */

export const FORGEGUI_MCP_URL = "https://azyjlkhpdgafuobyxoax.supabase.co/functions/v1/forgegui-mcp";
const PROTOCOL_VERSION = "2025-06-18";

/** Tools that spend credits or upload to Roblox; Continuum asks before each call. */
export const FORGEGUI_PAID_TOOLS: ReadonlySet<string> = new Set([
  "generation_gui",
  "generation_image",
  "generation_model_3d",
  "generation_retry",
  "generation_rig_3d",
]);
export const FORGEGUI_PUBLISH_TOOLS: ReadonlySet<string> = new Set(["artifact_publish"]);

export interface ForgeGuiToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: unknown;
}

export class ForgeGuiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

type Fetch = typeof fetch;

/** JSON-RPC responses arrive as JSON or as a server-sent event stream. */
async function readRpcResponse(response: Response, id: number): Promise<{ result?: unknown; error?: { message?: string } }> {
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (type.includes("text/event-stream")) {
    for (const block of body.split(/\n\n/)) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data === "") continue;
      const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id === id) return message;
    }
    throw new ForgeGuiError("ForgeGUI ended the stream without a reply.");
  }
  return body === "" ? {} : (JSON.parse(body) as { result?: unknown; error?: { message?: string } });
}

export class ForgeGuiClient {
  #sessionId: string | null = null;
  #nextId = 1;
  #initialized: Promise<void> | null = null;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(apiKey: string, endpoint: string = FORGEGUI_MCP_URL, fetchImpl: Fetch = fetch, timeoutMs = 120_000) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    if (apiKey.trim() !== apiKey || apiKey === "" || /[\r\n]/.test(apiKey)) {
      throw new ForgeGuiError("The ForgeGUI API key is empty or has whitespace.");
    }
  }

  async #post(body: unknown, expectReply: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "x-forgegui-plugin-client": "continuum-ide",
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401) throw new ForgeGuiError("ForgeGUI rejected the API key. Create a new key under Profile → MCP API keys and save it in Settings.", 401);
    if (response.status === 403) throw new ForgeGuiError("ForgeGUI denied access. The key may be missing a scope this needs.", 403);
    if (!response.ok && response.status !== 202) throw new ForgeGuiError(`ForgeGUI answered HTTP ${response.status}. The outcome may be unknown; check job status before retrying paid work.`, response.status);
    const session = response.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;
    if (!expectReply) await response.body?.cancel();
    return response;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, true);
    const reply = await readRpcResponse(response, id);
    if (reply.error) throw new ForgeGuiError(reply.error.message ?? "ForgeGUI returned an error.");
    return reply.result;
  }

  #initialize(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "continuum-ide", version: "1.0.0" },
      });
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    })().catch((error: unknown) => {
      this.#initialized = null;
      throw error;
    });
    return this.#initialized;
  }

  async listTools(): Promise<ReadonlyArray<{ readonly name: string; readonly description: string }>> {
    await this.#initialize();
    const result = (await this.#request("tools/list", {})) as { tools?: Array<{ name: string; description?: string }> };
    return (result.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ForgeGuiToolResult> {
    await this.#initialize();
    const result = (await this.#request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
    let structured = result.structuredContent ?? null;
    if (structured === null) {
      try {
        structured = JSON.parse(text);
      } catch {
        structured = null;
      }
    }
    return { isError: result.isError === true, text, structured };
  }
}

/** Credits only as ForgeGUI reports them; never estimated. */
export function reportedCredits(value: unknown): { readonly charged: number | null; readonly note: string | null } {
  let charged: number | null = null;
  let deferred = false;
  let outOfCredits = false;
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (/^(credits?_?(charged|used|spent|cost)|cost_credits|credit_cost)$/i.test(key) && typeof entry === "number") charged = (charged ?? 0) + entry;
      if (/commitDeferred/i.test(key) || entry === "commitDeferred") deferred = true;
      if (key === "error_code" && entry === "insufficient_credits") outOfCredits = true;
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  if (outOfCredits) return { charged: null, note: "ForgeGUI says the account is out of credits. Add credits at https://forgegui.com/plans." };
  if (charged !== null) return { charged, note: null };
  return { charged: null, note: deferred ? "ForgeGUI deferred billing and reported no amount." : "ForgeGUI did not report a cost for this call." };
}

/** The first https preview or artifact URL in a result, for showing the artwork. */
export function previewUrlOf(value: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown, depth: number) => {
    if (found !== null || depth > 6 || node === null || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (typeof entry === "string" && /^https:\/\//.test(entry) && /(preview|thumbnail|image|png|url)/i.test(key) && /\.(png|jpe?g|webp)(\?|$)|preview|thumbnail/i.test(entry)) {
        found = entry;
        return;
      }
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

/** Status fields ForgeGUI documents for generation jobs and publications. */
export function publicationStatus(value: unknown): { readonly status: string | null; readonly assetId: string | null; readonly publicationId: string | null } {
  const record = (value ?? {}) as Record<string, unknown>;
  const delivery = (record.delivery ?? record.publication ?? record) as Record<string, unknown>;
  const status = typeof delivery.status === "string" ? delivery.status : typeof record.status === "string" ? record.status : null;
  const rawAsset = delivery.roblox_asset_id ?? delivery.asset_id ?? record.roblox_asset_id;
  const assetId = typeof rawAsset === "string" || typeof rawAsset === "number" ? String(rawAsset) : null;
  const rawPublication = delivery.publication_id ?? record.publication_id;
  return { status, assetId, publicationId: typeof rawPublication === "string" ? rawPublication : null };
}
