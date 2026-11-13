// Redaction for committed recordings: drop secrets and identities, keep shapes.
import * as NodeOS from "node:os";

const secrets = new Set();
export function addSecret(value) {
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
}

const SECRET_KEY =
  /token|secret|password|passwd|credential|api[-_]?key|ticket|dpop|proof|signature|cookie|authorization|^code$|verifier|clientDevice|deviceId|^(workspace|account|organization|org|user)Id$/i;
// Keys whose string values look secret-ish by name but are not secrets.
const SAFE_KEY =
  /^(tokenUsage|tokenCount|maxTokens|knownProjectIdentities|secretSource|secretReferences|sessionCookieName|token_type|issued_token_type|requested_token_type|subject_token_type|kind|type|_tag)$/i;

export function redactValue(value, key = "") {
  if (typeof value === "string") {
    if (SECRET_KEY.test(key) && !SAFE_KEY.test(key)) {
      // Keep an auth scheme ("Bearer x", "DPoP x") readable; hide only the credential.
      const scheme = /^authorization$/i.test(key) ? value.match(/^(\w+) (.+)$/) : null;
      if (scheme) {
        addSecret(scheme[2]);
        return `${scheme[1]} <redacted:${scheme[2].length}>`;
      }
      addSecret(value);
      return `<redacted:${value.length}>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Header tuples: ["authorization", "Bearer x"].
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      SECRET_KEY.test(value[0])
    ) {
      addSecret(value[1]);
      return [value[0], `<redacted:${value[1].length}>`];
    }
    return value.map((v) => redactValue(v, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

const home = NodeOS.homedir();
const user = NodeOS.userInfo().username;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactText(text) {
  let out = text;
  for (const s of secrets) out = out.split(s).join(`<redacted:${s.length}>`);
  for (const s of secrets) {
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join(`<redacted:${s.length}>`);
  }
  out = out.split(home).join("/Users/user");
  out = out.replace(new RegExp(`\\b${escape(user)}\\b`, "gi"), "user");
  // Also in shell prompts (`host:dir user$`), which follow escapes where `\b` finds no boundary.
  for (const name of new Set(["nick", NodeOS.hostname().split(".")[0]])) {
    out = out.replace(new RegExp(`(\\\\[nrt]|\\b)${escape(name)}\\b`, "gi"), "$1user");
    out = out.replace(new RegExp(`${escape(name)}(?=:)`, "gi"), "user");
  }
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
  // Query params that carry secrets or device identity.
  out = out.replace(
    /([?&#](?:token|ticket|wsTicket|wsToken|access_token|code|clientDevice)=)[^&"\\#\s]+/g,
    "$1<redacted>",
  );
  out = out.replace(/(Bearer |DPoP )[A-Za-z0-9._~+/=-]+/g, "$1<redacted>");
  // JWT-shaped strings.
  out = out.replace(
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "<redacted:jwt>",
  );
  // Anthropic / OpenAI style keys.
  out = out.replace(/sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "<redacted:key>");
  return out;
}
