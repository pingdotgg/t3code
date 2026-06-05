export type RelayDatabaseMode = "shared-database" | "stage-branch";

export function relayDatabaseMode(stage: string): RelayDatabaseMode {
  return stage === "prod" ? "shared-database" : "stage-branch";
}
