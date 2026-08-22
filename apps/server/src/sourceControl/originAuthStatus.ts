export interface OriginAuthStatus {
  readonly parsed: boolean;
  readonly account: string | null;
  readonly host: string | null;
}

function nonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function firstMatch(text: string, patterns: ReadonlyArray<RegExp>): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match;
    }
  }
  return null;
}

export function parseOriginAuthStatus(text: string): OriginAuthStatus {
  const loggedIn = firstMatch(text, [
    /^[ \t]*Logged in to ([^\s]+) as\s+([^\s(]+)[ \t]*$/imu,
    /^[ \t]*Logged in as\s+([^\s(]+)[ \t]*$/imu,
    /^[ \t]*Authenticated as\s+([^\s(]+)[ \t]*$/imu,
    /^[ \t]*account:\s*([^\s(]+)[ \t]*$/imu,
  ]);

  if (!loggedIn) {
    return { parsed: false, account: null, host: null };
  }

  if (loggedIn.length >= 3 && loggedIn[1] && loggedIn[2]) {
    return {
      parsed: true,
      host: nonEmptyString(loggedIn[1])?.toLowerCase() ?? "origin.cursor.com",
      account: nonEmptyString(loggedIn[2]),
    };
  }

  return {
    parsed: true,
    host: "origin.cursor.com",
    account: nonEmptyString(loggedIn[1]),
  };
}
