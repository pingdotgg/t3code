interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

const SEMVER_NUMBER_SEGMENT = /^\d+$/;

// Build metadata ("+...") never affects precedence. Strip it when it is a
// nonempty dot-separated sequence of valid identifiers; a malformed suffix
// keeps the version unparseable downstream, as before.
const SEMVER_BUILD_IDENTIFIER = /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/;

function splitMainPrerelease(version: string): [main: string, prerelease: string | undefined] {
  const plus = version.indexOf("+");
  if (plus >= 0 && !SEMVER_BUILD_IDENTIFIER.test(version.slice(plus + 1))) {
    return [version, undefined];
  }
  const core = plus < 0 ? version : version.slice(0, plus);
  const dash = core.indexOf("-");
  if (dash < 0) {
    return [core, undefined];
  }
  if (dash === core.length - 1) {
    // An empty prerelease ("1.2.3-...") is invalid: keep the version
    // unparseable instead of normalizing into the core version.
    return [version, undefined];
  }
  return [core.slice(0, dash), core.slice(dash + 1)];
}

export function normalizeSemverVersion(version: string): string {
  const trimmed = version.trim();
  const [main, prerelease] = splitMainPrerelease(trimmed);
  // A malformed build suffix stays unparseable: pass it through untouched so
  // empty-segment filtering below cannot repair it into a valid suffix.
  if (main.includes("+")) {
    return trimmed;
  }
  const segments: string[] = [];
  for (const segment of (main ?? "").split(".")) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }

  // Pad shorthand versions ("20" or "20.1") up to three segments so major-only
  // and minor-only inputs parse and compare numerically. This matches
  // satisfiesSemverRange, which already treats a missing minor/patch as 0. The
  // length > 0 guard keeps empty/garbage input empty (parseSemver still
  // rejects it), and inputs with more than three segments are left untouched.
  while (segments.length > 0 && segments.length < 3) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

export function parseSemver(value: string): ParsedSemver | null {
  const normalized = normalizeSemverVersion(value).replace(/^v/, "");
  const [main = "", prerelease] = splitMainPrerelease(normalized);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  if (
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: parsePrereleaseSegments(prerelease),
  };
}

function parsePrereleaseSegments(prerelease: string | undefined): ReadonlyArray<string> {
  if (prerelease === undefined) {
    return [];
  }
  const segments: string[] = [];
  for (const segment of prerelease.split(".")) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  return segments;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  // Semver identifiers compare lexically in ASCII order, not locale
  // collation: "Z" precedes "a". Matches compareExactServiceVersions.
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

/**
 * Small semver range checker for CLI/runtime gates.
 *
 * Keep the function body valid plain JavaScript: SSH startup stringifies this
 * function and runs it on remote Node versions before TypeScript support is known.
 *
 * @param rawVersion Version string, with or without a leading `v`.
 * @param range Space-separated comparators, with `||` range groups.
 * @returns Whether `rawVersion` satisfies the supported range syntax.
 */
export const satisfiesSemverRange: (rawVersion: string, range: string) => boolean =
  function satisfiesSemverRange(rawVersion, range) {
    const normalizedVersion = String(rawVersion).trim().replace(/^v/, "");
    const versionMatch = normalizedVersion.match(
      /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/,
    );
    if (!versionMatch) {
      return false;
    }

    const version = {
      major: Number(versionMatch[1]),
      minor: Number(versionMatch[2] || 0),
      patch: Number(versionMatch[3] || 0),
    };

    return range.split("||").some((group) => {
      const comparators = group.trim().split(/\s+/).filter(Boolean);
      if (comparators.length === 0) {
        return false;
      }
      return comparators.every((comparator) => {
        const match = comparator.trim().match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
        if (!match) {
          return false;
        }
        const targetVersion = match[2];
        if (targetVersion === undefined) {
          return false;
        }
        const targetMatch = targetVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
        if (!targetMatch) {
          return false;
        }
        const target = {
          major: Number(targetMatch[1]),
          minor: Number(targetMatch[2] || 0),
          patch: Number(targetMatch[3] || 0),
        };
        const compared =
          version.major !== target.major
            ? version.major > target.major
              ? 1
              : -1
            : version.minor !== target.minor
              ? version.minor > target.minor
                ? 1
                : -1
              : version.patch !== target.patch
                ? version.patch > target.patch
                  ? 1
                  : -1
                : 0;
        const operator = match[1] || "=";
        switch (operator) {
          case "^":
            if (compared < 0) {
              return false;
            }
            if (target.major > 0) {
              return version.major === target.major;
            }
            if (target.minor > 0) {
              return version.major === 0 && version.minor === target.minor;
            }
            return version.major === 0 && version.minor === 0 && version.patch === target.patch;
          case ">=":
            return compared >= 0;
          case ">":
            return compared > 0;
          case "<=":
            return compared <= 0;
          case "<":
            return compared < 0;
          case "=":
            return compared === 0;
          default:
            return false;
        }
      });
    });
  };
