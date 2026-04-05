import { makeSqlitePersistenceLive } from "./Sqlite.shared";

export { makeSqlitePersistenceLive };

export const SqlitePersistenceMemory = makeSqlitePersistenceLive(":memory:");
