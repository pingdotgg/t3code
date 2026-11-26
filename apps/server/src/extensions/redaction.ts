// Fork: Kaluwa's Extensions page. Keeps secrets out of what the server reports about MCP servers.

const SECRET_NAME = /(token|secret|password|passwd|api[-_]?key|apikey|auth|credential|bearer)/i;
const REDACTED = "***";

/**
 * A heuristic, not a guarantee: an MCP command line is shown to the client, so values that look like
 * credentials are masked. That covers `--token=…`/`--api-key …` style flags, `Bearer …` arguments and
 * `Authorization: …` header arguments, and secret-looking query parameters or userinfo in URLs.
 */
export function redactCommandLine(command: string, args: ReadonlyArray<string>): string {
  const redacted: Array<string> = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      redacted.push(REDACTED);
      maskNext = false;
      continue;
    }
    redacted.push(redactArgument(arg));
    maskNext = /^--?[\w.-]+$/.test(arg) && SECRET_NAME.test(arg);
  }
  return [command, ...redacted].map(quoteForDisplay).join(" ");
}

function redactArgument(arg: string): string {
  const flag = /^(--?[\w.-]+)=(.*)$/s.exec(arg);
  if (flag && SECRET_NAME.test(flag[1] ?? "")) return `${flag[1]}=${REDACTED}`;
  const header = /^([\w-]+)\s*:\s*(.+)$/s.exec(arg);
  if (header && SECRET_NAME.test(header[1] ?? "")) return `${header[1]}: ${REDACTED}`;
  if (/^bearer\s+\S/i.test(arg)) return `Bearer ${REDACTED}`;
  const assignment = /^([A-Za-z_][\w]*)=(.+)$/s.exec(arg);
  if (assignment && SECRET_NAME.test(assignment[1] ?? "")) return `${assignment[1]}=${REDACTED}`;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(arg)) return redactUrl(arg);
  return arg;
}

export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.password) {
    url.password = REDACTED;
    changed = true;
  }
  // Iterates a copy, since setting a parameter while iterating the live one skips entries.
  for (const key of new URLSearchParams(url.search).keys()) {
    if (SECRET_NAME.test(key) || key.toLowerCase() === "key") {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

function quoteForDisplay(part: string): string {
  return part.length > 0 && !/[\s"'\\]/.test(part) ? part : JSON.stringify(part);
}

/** CLI output can echo what it was given; masks every known secret value before it is reported. */
export function scrubSecretValues(text: string, values: Iterable<string>): string {
  let scrubbed = text;
  for (const value of values) {
    if (value.length >= 4) scrubbed = scrubbed.split(value).join(REDACTED);
  }
  return scrubbed;
}
