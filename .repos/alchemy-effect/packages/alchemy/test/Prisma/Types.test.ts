import type {
  DatabaseCreateResult,
  ProjectCreateResult,
} from "@/Prisma/Client";
import type {
  Database,
  DatabaseConnectionWithOptionalSecrets,
  DatabaseSourceInput,
} from "@/Prisma/Types";
import { describe, expect, it } from "alchemy-test";

const nullableDatabaseSource: Database["source"] = null;
const endpointSecretMayBeAbsent: DatabaseConnectionWithOptionalSecrets["endpoints"] =
  {
    direct: {
      host: "db.prisma.test",
      port: 5432,
    },
  };
const validDatabaseSourceInput: DatabaseSourceInput = {
  type: "backup",
  databaseId: "db_source",
  backupId: "backup_1",
};
// @ts-expect-error Prisma only accepts the documented source discriminator.
const invalidDatabaseSourceInput: DatabaseSourceInput = { type: "snapshot" };
const projectCreateDatabaseWithoutProject: NonNullable<
  ProjectCreateResult["database"]
> = {
  id: "db_1",
  type: "database",
  url: "https://api.prisma.test/v1/databases/db_1",
  name: "main",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: true,
  defaultConnectionId: null,
  connections: [],
  region: {
    id: "us-east-1",
    name: "US East 1",
  },
  source: null,
  branchId: null,
};
const failedFlatDatabaseWithUnknownRegion: DatabaseCreateResult = {
  ...projectCreateDatabaseWithoutProject,
  project: {
    id: "proj_1",
    url: "https://api.prisma.test/v1/projects/proj_1",
    name: "app",
  },
  status: "failure",
  region: null,
};

describe("Prisma API types", () => {
  it("mirror nullable database sources and optional create-time secrets", () => {
    expect(nullableDatabaseSource).toBeNull();
    expect(endpointSecretMayBeAbsent.direct?.connectionString).toBeUndefined();
    expect(validDatabaseSourceInput.type).toBe("backup");
    expect(invalidDatabaseSourceInput.type).toBe("snapshot");
    expect("project" in projectCreateDatabaseWithoutProject).toBe(false);
    expect(failedFlatDatabaseWithUnknownRegion.status).toBe("failure");
    expect(failedFlatDatabaseWithUnknownRegion.region).toBeNull();
  });
});
