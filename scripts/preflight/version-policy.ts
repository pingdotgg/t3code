import type { CheckStatus } from "./result";

export type VersionClassification = {
  status: CheckStatus;
  hint?: string;
};

const parseVersionParts = (version: string): number[] => {
  const match = /(\d+(?:\.\d+){0,2})/.exec(version);
  if (!match) {
    return [];
  }

  return (match[1] ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  return 0;
};

export const classifyVersion = (
  present: string | null,
  latestKnown: string,
): VersionClassification => {
  if (present === null || present.trim() === "") {
    return { status: "error", hint: "CLI is missing or not on PATH." };
  }

  if (compareVersions(present, latestKnown) < 0) {
    return {
      status: "warn",
      hint: `Installed version ${present} is below latest-known ${latestKnown}; upgrade recommended.`,
    };
  }

  return { status: "pass" };
};
