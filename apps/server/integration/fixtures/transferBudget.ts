import type { ProviderDriverKind } from "@t3tools/contracts";
export const TRANSFER_HISTORY_TURN_COUNT = 10;
export const TRANSFER_HISTORY_TOOLS_PER_TURN = 5;
export const TRANSFER_MEASURED_TOOLS = 20;
export const TRANSFER_HISTORY_MCP_RESULT_BYTES = 900_000;
export const TRANSFER_MEASURED_MCP_RESULT_BYTES = 1_100_000;

const sourceModules = [
  "connection/session.ts",
  "connection/supervisor.ts",
  "rpc/client.ts",
  "rpc/protocol.ts",
  "state/threads.ts",
  "state/threadReducer.ts",
  "state/threadSnapshotHttp.ts",
  "orchestration/http.ts",
  "orchestration/Normalizer.ts",
  "orchestration/ActivityPayloadProjection.ts",
  "provider/ProviderService.ts",
  "provider/ProviderRuntimeIngestion.ts",
  "persistence/ProjectionSnapshotQuery.ts",
  "persistence/OrchestrationEventStore.ts",
  "checkpointing/CheckpointStore.ts",
  "checkpointing/CheckpointDiffQuery.ts",
  "server.ts",
] as const;

function mix(value: number): number {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function digest(seed: number): string {
  return [0, 1, 2, 3]
    .map((offset) =>
      mix(seed + offset * 0x9e3779b9)
        .toString(16)
        .padStart(8, "0"),
    )
    .join("");
}

/** Produces safe, deterministic output with enough entropy to exercise gzip. */
export function diagnosticOutput(input: {
  readonly provider: ProviderDriverKind;
  readonly turnIndex: number;
  readonly toolIndex: number;
  readonly targetBytes: number;
}): string {
  const chunks: string[] = [];
  const providerSeed = input.provider === "codex" ? 0x43_4f_44_45 : 0x43_4c_41_55;
  let length = 0;
  let lineIndex = 0;

  while (length < input.targetBytes) {
    const modulePath = sourceModules[(input.toolIndex + lineIndex) % sourceModules.length];
    const seed =
      providerSeed + input.turnIndex * 100_003 + input.toolIndex * 10_007 + lineIndex * 101;
    const line =
      `${String(lineIndex + 1).padStart(6, "0")} ${modulePath} ` +
      `operation=project-transfer-${input.turnIndex + 1}-${input.toolIndex + 1} ` +
      `cursor=${mix(seed)} digest=${digest(seed)} status=completed\n`;
    chunks.push(line);
    length += line.length;
    lineIndex += 1;
  }

  return chunks.join("").slice(0, input.targetBytes);
}
