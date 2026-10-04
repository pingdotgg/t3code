import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../../../packages/protocol/src/index.ts";

/** Atomic serialized writes keep disconnect/restart recovery independent of the UI. */
export class SessionStore {
  private directory: string;
  private pending = Promise.resolve();
  constructor(directory: string) { this.directory = directory; }
  async load(): Promise<Session[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, "sessions.json"), "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid session store");
      return value.map((raw: Session) => {
        if (!raw || typeof raw.id !== "string" || typeof raw.cwd !== "string" || !Array.isArray(raw.messages) || !Array.isArray(raw.tools)) throw new Error("Invalid stored session");
        return { ...raw, threadId: raw.threadId ?? raw.id, approvals: [], questions: [], turnId: null,
          status: raw.status === "running" ? "interrupted" : raw.status,
          error: raw.status === "running" ? "Backend restarted during this turn. Send another prompt to continue." : raw.error };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  save(sessions: Session[]): Promise<void> {
    const text = JSON.stringify(sessions);
    // A previous error must not poison every later attempt.
    this.pending = this.pending.catch(() => {}).then(async () => {
      const temporary = join(this.directory, "sessions.json.tmp");
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, join(this.directory, "sessions.json"));
    });
    return this.pending;
  }
}
