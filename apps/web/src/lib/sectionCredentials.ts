export type SectionCredential =
  | {
      readonly type: "username-password";
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "secret-key";
      readonly key: string;
    };

export type SectionCredentialType = "none" | SectionCredential["type"];

const CREDENTIALS_START = "<!-- morecode-section-credentials:start -->";
const CREDENTIALS_END = "<!-- morecode-section-credentials:end -->";
const CREDENTIALS_INTRO =
  "The following credential is intentionally available to the AI in plain text:";
const CREDENTIALS_PATTERN = new RegExp(
  `(?:\\n\\n)?${CREDENTIALS_START}\\n${CREDENTIALS_INTRO}\\n([\\s\\S]*?)\\n${CREDENTIALS_END}$`,
);

export interface ParsedSectionContext {
  readonly context: string;
  readonly credential: SectionCredential | null;
}

export function makeSectionCredential(input: {
  readonly type: SectionCredentialType;
  readonly username: string;
  readonly password: string;
  readonly secretKey: string;
}): SectionCredential | null {
  switch (input.type) {
    case "username-password":
      return {
        type: "username-password",
        username: input.username,
        password: input.password,
      };
    case "secret-key":
      return { type: "secret-key", key: input.secretKey };
    case "none":
      return null;
  }
}

function parseCredential(value: unknown): SectionCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type === "username-password" &&
    typeof candidate.username === "string" &&
    typeof candidate.password === "string"
  ) {
    return {
      type: "username-password",
      username: candidate.username,
      password: candidate.password,
    };
  }
  if (candidate.type === "secret-key" && typeof candidate.key === "string") {
    return {
      type: "secret-key",
      key: candidate.key,
    };
  }
  return null;
}

export function parseSectionContext(value: string): ParsedSectionContext {
  const match = CREDENTIALS_PATTERN.exec(value);
  if (!match) {
    return { context: value, credential: null };
  }
  try {
    const credential = parseCredential(JSON.parse(match[1] ?? ""));
    if (!credential) {
      return { context: value, credential: null };
    }
    return {
      context: value.slice(0, match.index).trimEnd(),
      credential,
    };
  } catch {
    return { context: value, credential: null };
  }
}

export function formatSectionContext(input: {
  readonly context: string;
  readonly credential: SectionCredential | null;
}): string {
  const context = input.context.trimEnd();
  if (!input.credential) {
    return context;
  }
  const credentialBlock = [
    CREDENTIALS_START,
    CREDENTIALS_INTRO,
    JSON.stringify(input.credential, null, 2),
    CREDENTIALS_END,
  ].join("\n");
  return context.length > 0 ? `${context}\n\n${credentialBlock}` : credentialBlock;
}
