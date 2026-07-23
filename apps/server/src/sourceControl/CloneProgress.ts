import type {
  SourceControlCloneProgress,
  SourceControlCloneProgressStage,
} from "@t3tools/contracts";

const PROGRESS_LINE =
  /^(Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s+(.+))?$/;
const TRANSFER_METRICS =
  /^([\d.]+)\s+(B|KB|KiB|MB|MiB|GB|GiB)\s+\|\s+([\d.]+)\s+(B|KB|KiB|MB|MiB|GB|GiB)\/s$/;

const UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
  B: 1,
  KB: 1_000,
  KiB: 1_024,
  MB: 1_000_000,
  MiB: 1_048_576,
  GB: 1_000_000_000,
  GiB: 1_073_741_824,
};

function parseFiniteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBytes(value: string, unit: string): number | null {
  const amount = parseFiniteNumber(value);
  const multiplier = UNIT_MULTIPLIER[unit];
  if (amount === null || multiplier === undefined) {
    return null;
  }
  return Math.round(amount * multiplier);
}

function progressStage(label: string): SourceControlCloneProgressStage {
  switch (label) {
    case "Receiving objects":
      return "receiving";
    case "Resolving deltas":
      return "resolving";
    case "Updating files":
    case "Checking out files":
      return "checkout";
    default:
      return "connecting";
  }
}

export function parseGitCloneProgressLine(line: string): SourceControlCloneProgress | null {
  const match = PROGRESS_LINE.exec(line.trim());
  if (match === null) {
    return null;
  }

  const [, label, percentText, completedText, totalText, transferText] = match;
  if (
    label === undefined ||
    percentText === undefined ||
    completedText === undefined ||
    totalText === undefined
  ) {
    return null;
  }

  const percent = parseFiniteNumber(percentText);
  const completed = parseFiniteNumber(completedText);
  const total = parseFiniteNumber(totalText);
  if (
    percent === null ||
    completed === null ||
    total === null ||
    percent < 0 ||
    percent > 100 ||
    completed < 0 ||
    total < 0
  ) {
    return null;
  }

  const transferMatch = transferText === undefined ? null : TRANSFER_METRICS.exec(transferText);
  const receivedBytes =
    transferMatch?.[1] !== undefined && transferMatch[2] !== undefined
      ? parseBytes(transferMatch[1], transferMatch[2])
      : null;
  const bytesPerSecond =
    transferMatch?.[3] !== undefined && transferMatch[4] !== undefined
      ? parseBytes(transferMatch[3], transferMatch[4])
      : null;

  return {
    type: "progress",
    stage: progressStage(label),
    percent,
    completed,
    total,
    receivedBytes,
    bytesPerSecond,
  };
}
