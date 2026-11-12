import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;

export class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

export function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

export function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

export function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly phase: "version" | "inventory";
  readonly serverUrl: string;
}): {
  readonly installed: boolean;
  readonly message: string;
  readonly authStatus?: "unauthenticated";
} {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    // Bare auth-code digits can be part of the endpoint's port or path.
    if (
      /(?:^|\s)(?:status(?:\s+code)?(?:\s*[:=]\s*|\s+)|http(?:\/\d(?:\.\d)?)?\s+)(?:401|403)\b/.test(
        lower,
      ) ||
      /\b(?:unauthorized|forbidden)\b/.test(lower)
    ) {
      return {
        installed: true,
        authStatus: "unauthenticated",
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted. Try reinstalling OpenCode.",
    };
  }

  const failureLabel =
    input.phase === "inventory"
      ? "Failed to load OpenCode provider inventory"
      : "Failed to execute OpenCode CLI health check";
  return {
    installed: true,
    message: detail ? `${failureLabel}: ${detail}` : `${failureLabel}.`,
  };
}

// The status check owns the span; keep handled failures visible without adding another span.
export const logDiscoveryFailure = Effect.fnUntraced(function* (input: {
  readonly phase: "version" | "inventory" | "models";
  readonly isExternalServer: boolean;
  readonly version?: string;
  readonly cause?: Cause.Cause<unknown>;
}) {
  const outcome = input.cause ? "failed" : "empty";
  const attributes = {
    provider: "opencode",
    phase: input.phase,
    outcome,
    serverMode: input.isExternalServer ? "external" : "managed",
    ...(input.version === undefined ? {} : { version: input.version }),
  };
  yield* Effect.annotateCurrentSpan({
    "discovery.phase": input.phase,
    "discovery.outcome": outcome,
  });
  yield* (
    input.cause
      ? Effect.logWarning("OpenCode discovery failed", input.cause)
      : Effect.logWarning("OpenCode discovery failed")
  ).pipe(Effect.annotateLogs(attributes));
});

export function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

export function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

export interface OpenCodeRelease {
  readonly providerID: string;
  readonly family?: string | undefined;
  readonly released?: number | undefined;
  readonly deprecated?: boolean | undefined;
}

/**
 * OpenCode catalogs keep every release of a family, such as Claude Opus 4.5
 * through 5.5. Only the newest active release of each family within a
 * sub-provider stays current; older releases and deprecated models are legacy.
 */
export interface OpenCode2Model extends OpenCodeRelease {
  readonly id: string;
  readonly name: string;
  readonly providerName?: string;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

// Sub-provider names distinguish overlapping catalog entries.
export interface OpenCode2Workspace {
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly description?: string | undefined;
  }>;
  readonly commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
  }>;
}

/**
 * A server scans a directory it has not served yet in the background: its first read lists
 * no commands at all (not even the built-ins), and `command.updated` plus `skill.updated`
 * for the directory end the scan. `scanned` must be listening before `read` runs, since
 * the read is what starts the scan.
 */
