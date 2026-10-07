import * as Predicate from "effect/Predicate";

/**
 * MCP Apps (https://github.com/modelcontextprotocol/ext-apps, spec 2026-01-26):
 * an MCP tool can name a `ui://` HTML resource that hosts render as an
 * interactive view of its result. T3 snapshots the resource when the tool call
 * completes, stores it as a thread attachment, and records an `McpAppReference`
 * in the tool item's output; clients host it in an opaque-origin frame and
 * speak the spec's JSON-RPC bridge with it.
 */

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The MCP extension id a client declares to receive UI resources. */
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_RESOURCE_SCHEME = "ui://";
/** Where T3 records the app reference inside a tool item's output object. */
export const MCP_APP_OUTPUT_KEY = "t3McpApp";

const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;
/** Largest app document T3 stores. */
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
// A `ui://` URI can carry a path and query; the compact wire budget still
// bounds the whole reference.
const MAX_RESOURCE_URI_LENGTH = 4096;

/** `_meta.ui.csp` on a UI resource: origins the app needs, by kind. */
export interface McpAppCsp {
  readonly connectDomains?: ReadonlyArray<string>;
  readonly resourceDomains?: ReadonlyArray<string>;
  readonly frameDomains?: ReadonlyArray<string>;
  readonly baseUriDomains?: ReadonlyArray<string>;
}

/** `_meta.ui.permissions` on a UI resource. */
export interface McpAppPermissions {
  readonly camera?: Record<string, never>;
  readonly microphone?: Record<string, never>;
  readonly geolocation?: Record<string, never>;
  readonly clipboardWrite?: Record<string, never>;
}

/** What a tool item's output carries so clients can host the app. */
export interface McpAppReference {
  readonly attachmentId: string;
  /** The MCP server the tool belongs to, as the provider names it. */
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly csp?: McpAppCsp;
  readonly permissions?: McpAppPermissions;
  readonly prefersBorder?: boolean;
}

// Only scheme-qualified origins, optionally with a leading `*.` subdomain
// wildcard, survive. Anything else (keywords, paths, quotes, whitespace) could
// widen or break the generated policy, so it is dropped.
const DOMAIN_PATTERN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

function readDomains(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter(
      (domain): domain is string =>
        typeof domain === "string" &&
        domain.length <= MAX_DOMAIN_LENGTH &&
        DOMAIN_PATTERN.test(domain),
    )
    .slice(0, MAX_DOMAINS);
  return domains.length === 0 ? undefined : domains;
}

/** The well-formed part of a resource's declared `_meta.ui.csp`. */
export function readMcpAppCsp(value: unknown): McpAppCsp | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const csp: {
    connectDomains?: ReadonlyArray<string>;
    resourceDomains?: ReadonlyArray<string>;
    frameDomains?: ReadonlyArray<string>;
    baseUriDomains?: ReadonlyArray<string>;
  } = {};
  for (const key of [
    "connectDomains",
    "resourceDomains",
    "frameDomains",
    "baseUriDomains",
  ] as const) {
    const domains = readDomains(value[key]);
    if (domains !== undefined) csp[key] = domains;
  }
  return Object.keys(csp).length === 0 ? undefined : csp;
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

export function readMcpAppPermissions(value: unknown): McpAppPermissions | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const permissions: Partial<Record<(typeof PERMISSION_KEYS)[number], Record<string, never>>> = {};
  for (const key of PERMISSION_KEYS) {
    if (Predicate.isObject(value[key])) permissions[key] = {};
  }
  return Object.keys(permissions).length === 0 ? undefined : permissions;
}

const boundedName = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH
    ? value
    : undefined;

export function readMcpAppReference(value: unknown): McpAppReference | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const attachmentId = boundedName(value.attachmentId);
  const server = boundedName(value.server);
  const tool = boundedName(value.tool);
  const resourceUri =
    typeof value.resourceUri === "string" && value.resourceUri.length <= MAX_RESOURCE_URI_LENGTH
      ? value.resourceUri
      : undefined;
  if (
    attachmentId === undefined ||
    server === undefined ||
    tool === undefined ||
    resourceUri === undefined ||
    !resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)
  ) {
    return undefined;
  }
  const csp = readMcpAppCsp(value.csp);
  const permissions = readMcpAppPermissions(value.permissions);
  return {
    attachmentId,
    server,
    tool,
    resourceUri,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(typeof value.prefersBorder === "boolean" ? { prefersBorder: value.prefersBorder } : {}),
  };
}

export function mcpAppReferencesEqual(left: McpAppReference, right: McpAppReference): boolean {
  return (
    left.attachmentId === right.attachmentId &&
    left.server === right.server &&
    left.tool === right.tool &&
    left.resourceUri === right.resourceUri
  );
}

/** The tool's `_meta.ui.resourceUri` (or the deprecated flat key), if it names a UI resource. */
export function readMcpAppResourceUri(meta: unknown): string | undefined {
  if (!Predicate.isObject(meta)) return undefined;
  const nested = Predicate.isObject(meta.ui) ? meta.ui.resourceUri : undefined;
  const uri = nested ?? meta["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

/**
 * Whether the tool's `_meta.ui.visibility` lets an app call it. The spec
 * defaults to visible to both the model and apps.
 */
export function mcpAppToolCallableByApp(meta: unknown): boolean {
  const visibility =
    Predicate.isObject(meta) && Predicate.isObject(meta.ui) ? meta.ui.visibility : undefined;
  return !Array.isArray(visibility) || visibility.includes("app");
}

/**
 * The Content-Security-Policy for an app document, per the spec's
 * construction: undeclared origins stay blocked, and nothing loads from the
 * host's own origin ('self' would reach T3's API).
 */
export function mcpAppContentSecurityPolicy(csp: McpAppCsp | undefined): string {
  const resources = csp?.resourceDomains?.join(" ") ?? "";
  const list = (domains: ReadonlyArray<string> | undefined, fallback: string) =>
    domains === undefined || domains.length === 0 ? fallback : domains.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    "object-src 'none'",
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "form-action 'none'",
  ].join("; ");
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Puts the app's policy at the top of its document as a CSP meta tag, ahead of
 * any script. The asset route's `sandbox` header already makes the origin
 * opaque; browsers enforce both policies, so the document can only tighten
 * this one, never widen it.
 */
export function injectMcpAppCsp(html: string, csp: McpAppCsp | undefined): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
    mcpAppContentSecurityPolicy(csp),
  )}">`;
  // After a leading doctype, so the document stays in standards mode; the
  // parser moves the tag into the head it opens.
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}`
    : `<!doctype html>${meta}${html}`;
}

/** The iframe `allow` attribute for the permissions an app declared. */
export function mcpAppAllowAttribute(permissions: McpAppPermissions | undefined): string {
  const features: Array<string> = [];
  if (permissions?.camera) features.push("camera");
  if (permissions?.microphone) features.push("microphone");
  if (permissions?.geolocation) features.push("geolocation");
  if (permissions?.clipboardWrite) features.push("clipboard-write");
  return features.join("; ");
}

export function clampMcpAppHeight(height: number): number {
  if (!Number.isFinite(height)) return MCP_APP_DEFAULT_HEIGHT;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, height)));
}

export function mcpAppFileName(reference: McpAppReference): string {
  const name = reference.tool.replace(/[^\w.-]+/g, "-").slice(0, 80) || "app";
  return `${name}.html`;
}
