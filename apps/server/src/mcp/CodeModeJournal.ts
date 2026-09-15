// @effect-diagnostics nodeBuiltinImport:off -- Native async snapshots are shared with the process supervisor outside Effect fibers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  CodeModeExecutionResult,
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

const Record = Schema.Struct({
  state: CodeModeExecutionResult,
  scope: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    providerSessionId: Schema.String,
  }),
  runId: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  codeHash: Schema.String,
  createdAt: Schema.Finite,
});
export type JournalRecord = typeof Record.Type;
const decode = Schema.decodeUnknownSync(Record);

/** Bounded atomic snapshots. Saving a result precedes delivery to the guest. No script is persisted. */
export class CodeModeJournal {
  private readonly directory: string;
  private readonly platform: NodeJS.Platform;
  constructor(directory: string, platform: NodeJS.Platform) {
    this.directory = directory;
    this.platform = platform;
  }

  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid code execution id.");
    return NodePath.join(this.directory, `${id}.json`);
  }

  async read() {
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await NodeFSP.readdir(this.directory);
    // A crash before rename leaves a partial snapshot, not a recoverable execution.
    for (const name of files) {
      if (/^[0-9a-f-]{36}\.json\.tmp$/.test(name))
        await NodeFSP.rm(NodePath.join(this.directory, name), { force: true });
    }
    const names = files.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
    const records: Array<JournalRecord> = [];
    if (names.length > 32) throw new Error("Too many code execution journals.");
    for (const name of names) {
      const path = NodePath.join(this.directory, name);
      const stat = await NodeFSP.stat(path);
      if (stat.size > 512 * 1024) throw new Error("Code execution journal exceeds its bound.");
      records.push(decode(JSON.parse(await NodeFSP.readFile(path, "utf8"))));
    }
    // File insertion order is not stable across server restarts.
    records.sort((a, b) => a.createdAt - b.createdAt);
    return records;
  }

  async write(record: JournalRecord) {
    const path = this.path(record.state.executionId);
    const temporary = path + ".tmp";
    const file = await NodeFSP.open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporary, path);
    if (this.platform !== "win32") {
      const directory = await NodeFSP.open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  async remove(id: string) {
    await NodeFSP.rm(this.path(id), { force: true });
    await NodeFSP.rm(this.path(id) + ".tmp", { force: true });
  }
}
