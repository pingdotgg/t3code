import { AuthMcpClientAccess, EnvironmentId, parseMcpApprovalCode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * T3 Connect approval of an app sign-in. The sign-in page on an environment's relay address
 * sends the user to the hosted app, which mints a one-use app approval code there with the
 * account's own access and returns it in the fragment. The nonce stays in the page's tab, and
 * only the tab that asked may use the code.
 */
const APPROVE_AGENT_PATH = "/approve-agent";
const CONNECT_AGENT_PATH = "/connect-agent";
const CODE_PARAM = "t3-connect-code";
const NONCE_PARAM = "t3-connect-nonce";
const PENDING_KEY = "t3code:connect-agent:pending";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const isAccess = Schema.is(AuthMcpClientAccess);

export interface ApproveAgentRequest {
  readonly environmentId: EnvironmentId;
  readonly access: AuthMcpClientAccess;
  readonly nonce: string;
  /** The sign-in page to return to, without a fragment. */
  readonly returnTo: URL;
}

export function approveAgentUrl(
  hostedAppUrl: string,
  request: Omit<ApproveAgentRequest, "returnTo"> & { readonly returnTo: string },
): string {
  const url = new URL(APPROVE_AGENT_PATH, hostedAppUrl);
  url.searchParams.set("environment", request.environmentId);
  url.searchParams.set("access", request.access);
  url.searchParams.set("nonce", request.nonce);
  url.searchParams.set("return_to", request.returnTo);
  return url.toString();
}

/** Null unless every field is present and `return_to` is an https sign-in page. */
export function readApproveAgentRequest(url: URL): ApproveAgentRequest | null {
  const environment = url.searchParams.get("environment");
  const access = url.searchParams.get("access");
  const nonce = url.searchParams.get("nonce");
  const returnTo = parseUrl(url.searchParams.get("return_to"));
  if (
    !environment ||
    !isAccess(access) ||
    nonce === null ||
    !NONCE_PATTERN.test(nonce) ||
    returnTo === null ||
    returnTo.protocol !== "https:" ||
    returnTo.pathname !== CONNECT_AGENT_PATH ||
    returnTo.username !== "" ||
    returnTo.password !== ""
  ) {
    return null;
  }
  returnTo.hash = "";
  return { environmentId: EnvironmentId.make(environment), access, nonce, returnTo };
}

export function approvedReturnUrl(request: ApproveAgentRequest, code: string): string {
  const url = new URL(request.returnTo);
  url.hash = new URLSearchParams({ [CODE_PARAM]: code, [NONCE_PARAM]: request.nonce }).toString();
  return url.toString();
}

export type ConnectApprovalReturn =
  | { readonly status: "none" }
  /** A code this tab did not ask for, as from someone else's link; never used. */
  | { readonly status: "discarded" }
  | { readonly status: "approved"; readonly code: string };

/**
 * A returned code is used only when this tab started the approval for this same sign-in request
 * at the code's own level, so a code minted through someone else's link is never offered.
 */
export function readConnectApprovalReturn(
  hash: string,
  search: string,
  pending: string | null,
): ConnectApprovalReturn {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get(CODE_PARAM)?.trim();
  if (!code) return { status: "none" };
  const nonce = params.get(NONCE_PARAM);
  const access = parseMcpApprovalCode(code)?.access;
  return nonce !== null && access !== undefined && pending === pendingValue(nonce, access, search)
    ? { status: "approved", code }
    : { status: "discarded" };
}

export function pendingValue(nonce: string, access: AuthMcpClientAccess, search: string): string {
  return `${nonce} ${access} ${search}`;
}

export function newApprovalNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Storage can throw in private windows; without it the returned code is discarded.
export function rememberPendingApproval(value: string): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, value);
  } catch {}
}

export function readPendingApproval(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

export function clearPendingApproval(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

function parseUrl(value: string | null): URL | null {
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
