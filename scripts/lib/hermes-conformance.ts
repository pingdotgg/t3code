// @effect-diagnostics nodeBuiltinImport:off - This disposable harness runs before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const HERMES_PINNED_REVISION = "2c1a38a3cc4b5727c817f007a46c377cafddde4c";

export type ProbeStatus = "passed" | "failed" | "blocked" | "indeterminate";
export type ProbeSafety = "read" | "disposable-write" | "live" | "destructive";

export interface ProbeResult {
  readonly id: string;
  readonly area: string;
  readonly status: ProbeStatus;
  readonly safety: ProbeSafety;
  readonly summary: string;
  readonly critical?: boolean;
  readonly evidence?: ReadonlyArray<number>;
}

export interface RevisionEvidence {
  readonly expected: string;
  readonly actual: string | undefined;
  readonly clean: boolean | undefined;
  readonly sourcePath: string | undefined;
  readonly verified: boolean;
  readonly reason: string;
}

export interface CaptureRecord {
  readonly sequence: number;
  readonly direction: "client" | "server" | "harness";
  readonly frame: unknown;
}

const SECRET_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|session[_-]?token)/i;
const PATH_KEY = /(?:^|_)(?:cwd|home|path|root|directory|filename)$/i;
const CONTENT_KEY =
  /(?:arguments|body|command|content|description|error|input|message|output|preview|prompt|query|result|text|title|url|value)/i;
const ID_KEY = /(?:^|_)(?:id|key|sha|revision)$/i;
const DATA_URL = /^data:[^;,]+(?:;[^;,=]+=[^;,]+)*;base64,/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
const SAFE_FIELD_KEY =
  /^(?:action|attached|bytes|capabilities|code|cols|count|critical|direction|enabled|error|evidence|explicit_only|first_page|frame|height|id|include_unconfigured|jsonrpc|kind|last_page|method|mode|page|pages|pages_attached|params|remainder|result|resumed|revision|role|rows|sequence|session_id|skin|state|status|stored_session_id|success|type|uploaded|width)$/;
const SAFE_STRING_KEY =
  /^(?:action|direction|jsonrpc|kind|method|mode|role|skin|state|status|type)$/;
const SAFE_STRING_VALUE = /^[A-Za-z0-9_.:/+-]{1,128}$/;
const SAFE_NUMBER_KEY =
  /^(?:bytes|code|cols|count|first_page|height|last_page|page|pages_attached|rows|sequence|width)$/;
const SANITIZER_SALT = NodeCrypto.randomBytes(32);

export function verifyPinnedSource(sourcePath: string | undefined): RevisionEvidence {
  if (!sourcePath) {
    return {
      expected: HERMES_PINNED_REVISION,
      actual: undefined,
      clean: undefined,
      sourcePath: undefined,
      verified: false,
      reason: "No official Hermes source checkout was supplied.",
    };
  }

  const unresolved = NodePath.resolve(sourcePath);
  const resolved = NodeFS.existsSync(unresolved) ? NodeFS.realpathSync(unresolved) : unresolved;
  const actual = runGit(resolved, ["rev-parse", "HEAD"]);
  const status = runGit(resolved, ["status", "--porcelain", "--untracked-files=all"]);
  const ignoredPython =
    runGit(resolved, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "*.py"])
      ?.split("\n")
      .filter((path) => path && !path.startsWith(".venv/")) ?? [];
  const clean = status === "" && ignoredPython.length === 0;
  const hasGateway =
    NodeFS.existsSync(NodePath.join(resolved, "tui_gateway", "server.py")) &&
    NodeFS.existsSync(NodePath.join(resolved, "tui_gateway", "ws.py"));
  const verified = actual === HERMES_PINNED_REVISION && clean && hasGateway;

  return {
    expected: HERMES_PINNED_REVISION,
    actual,
    clean,
    sourcePath: resolved,
    verified,
    reason: !actual
      ? "The supplied path is not a readable Git checkout."
      : actual !== HERMES_PINNED_REVISION
        ? `Checkout revision ${actual} does not match the pin.`
        : !clean
          ? "The pinned checkout has modified/untracked files or ignored Python outside .venv."
          : !hasGateway
            ? "Pinned gateway source files are missing."
            : "Pinned official source revision and source tree verified.",
  };
}

export function sanitizeCapture(value: unknown, key = ""): unknown {
  if (value !== null && SECRET_KEY.test(key)) return "<redacted-secret>";
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return SAFE_NUMBER_KEY.test(key) ? value : "<redacted-number>";
  }
  if (typeof value === "string") {
    if (DATA_URL.test(value)) return `<redacted-data-url:${byteLength(value)}>`;
    if (PATH_KEY.test(key) || ABSOLUTE_PATH.test(value)) return sanitizePath(value);
    if (CONTENT_KEY.test(key)) return `<redacted-content:${byteLength(value)}>`;
    if (ID_KEY.test(key) && value !== HERMES_PINNED_REVISION) {
      return pseudonym(key || "id", value);
    }
    if (
      (key === "revision" && value === HERMES_PINNED_REVISION) ||
      (SAFE_STRING_KEY.test(key) && SAFE_STRING_VALUE.test(value))
    ) {
      return value;
    }
    return `<redacted-string:${byteLength(value)}>`;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeCapture(entry, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => {
        const safeChildKey = SAFE_FIELD_KEY.test(childKey)
          ? childKey
          : pseudonym("field", childKey);
        return [safeChildKey, sanitizeCapture(childValue, childKey)];
      }),
    );
  }
  return `<redacted-${typeof value}>`;
}

export function sanitizeRecords(
  records: ReadonlyArray<CaptureRecord>,
): ReadonlyArray<CaptureRecord> {
  return records.map((record) => ({
    sequence: record.sequence,
    direction: record.direction,
    frame: sanitizeCapture(record.frame),
  }));
}

export function canRunProbe(
  safety: ProbeSafety,
  env: Readonly<Record<string, string | undefined>>,
): { readonly allowed: boolean; readonly reason: string } {
  if (safety === "read") return { allowed: true, reason: "read-only" };
  if (env.HERMES_CONFORMANCE_ALLOW_MUTATIONS !== "1") {
    return {
      allowed: false,
      reason: "Set HERMES_CONFORMANCE_ALLOW_MUTATIONS=1 for disposable writes.",
    };
  }
  if (safety === "live" && env.HERMES_CONFORMANCE_ALLOW_LIVE !== "1") {
    return {
      allowed: false,
      reason: "Set HERMES_CONFORMANCE_ALLOW_LIVE=1 for model/tool execution.",
    };
  }
  if (safety === "destructive" && env.HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE !== "1") {
    return {
      allowed: false,
      reason: "Set HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE=1 for destructive probes.",
    };
  }
  return { allowed: true, reason: "explicitly enabled" };
}

export function canRunModeProbe(
  mode: "launch" | "attach",
  safety: ProbeSafety,
  env: Readonly<Record<string, string | undefined>>,
): { readonly allowed: boolean; readonly reason: string } {
  if (mode === "attach" && safety !== "read") {
    return {
      allowed: false,
      reason: "attach mode is strictly read-only; mutation opt-ins are ignored",
    };
  }
  return canRunProbe(safety, env);
}

export function exitCodeFor(results: ReadonlyArray<ProbeResult>): number {
  return results.some(
    (result) =>
      result.status === "failed" || (result.critical === true && result.status !== "passed"),
  )
    ? 1
    : 0;
}

export function summarizeResults(results: ReadonlyArray<ProbeResult>): Record<ProbeStatus, number> {
  const counts: Record<ProbeStatus, number> = {
    passed: 0,
    failed: 0,
    blocked: 0,
    indeterminate: 0,
  };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

export function renderEvidenceReport(options: {
  readonly generatedAt: string;
  readonly mode: "launch" | "attach";
  readonly endpoint: string;
  readonly revision: RevisionEvidence;
  readonly rawCapturePath: string;
  readonly fixturePath: string;
  readonly harnessFingerprint: string;
  readonly invocation: string;
  readonly results: ReadonlyArray<ProbeResult>;
}): string {
  const counts = summarizeResults(options.results);
  const rows = options.results
    .map(
      (result) =>
        `| ${result.id} | ${result.area} | ${result.safety} | ${result.status} | ${result.evidence?.join(", ") || "—"} | ${escapeTable(result.summary)} |`,
    )
    .join("\n");

  return `# Hermes H0 conformance evidence

- Generated: ${options.generatedAt}
- Mode: ${options.mode}
- Endpoint: \`${options.endpoint}\`
- Required revision: \`${options.revision.expected}\`
- Observed source revision: \`${options.revision.actual ?? "unavailable"}\`
- Revision verified: ${options.revision.verified ? "yes" : "no"} — ${options.revision.reason}
- Harness fingerprint: \`sha256:${options.harnessFingerprint}\`
- Invocation: ${options.invocation}
- Raw capture: \`${options.rawCapturePath}\` (outside repository; sensitive)
- Sanitized fixture: \`${options.fixturePath}\`
- Totals: ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.indeterminate} indeterminate

| Probe | Area | Safety | Status | Sequence(s) | Summary |
| --- | --- | --- | --- | --- | --- |
${rows}

## Fail-closed release gate

Exit status is non-zero when any probe fails or when a security-critical probe is blocked or
indeterminate. An ambiguous mutation is never replayed automatically; reconnect performs
\`session.list\` reconciliation only and does not resume the session.
`;
}

function runGit(cwd: string, args: ReadonlyArray<string>): string | undefined {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function pseudonym(kind: string, value: string): string {
  const digest = NodeCrypto.createHmac("sha256", SANITIZER_SALT)
    .update(value)
    .digest("hex")
    .slice(0, 12);
  return `<${kind}:${digest}>`;
}

function sanitizePath(_value: string): string {
  return "<redacted-path>";
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
