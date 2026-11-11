// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface DownloadAuditContext {
  readonly stateDir: string;
  readonly threadId?: string | null;
  readonly courseId?: string | null;
}
export interface DownloadAuditAttempt {
  readonly url: string;
  readonly hops?: ReadonlyArray<{
    readonly url: string;
    readonly status: number | null;
    readonly ips: ReadonlyArray<string>;
  }>;
  readonly status?: number | null;
  readonly bytes?: number;
  readonly contentType?: string | null;
  readonly body?: Uint8Array;
  readonly sha256?: string | null;
  readonly blocked?: string;
  readonly error?: string;
}
const SECRET = /token|key|sig|secret|pass|pw|pwd|auth|session|code|cred|jwt|access/i;
const redactUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of url.searchParams.keys())
      if (SECRET.test(key)) url.searchParams.set(key, "REDACTED");
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
};
export const auditDownload = async (
  context: DownloadAuditContext,
  attempt: DownloadAuditAttempt,
) => {
  try {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const directory = NodePath.join(context.stateDir, "audit");
    await NodeFSP.mkdir(directory, { recursive: true });
    const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
    for (const name of await NodeFSP.readdir(directory)) {
      const match = name.match(/^downloads-(\d{4})-(\d{2})\.jsonl$/);
      if (match && currentMonth - (Number(match[1]) * 12 + Number(match[2]) - 1) > 2)
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    }
    const file = NodePath.join(directory, `downloads-${month}.jsonl`);
    const stat = await NodeFSP.stat(file).catch(() => ({ size: 0, mtimeMs: 0 }));
    if (stat.size > 100 * 1024 * 1024) {
      if (now.getTime() - stat.mtimeMs > 60 * 60 * 1000)
        await NodeFSP.appendFile(file, '{"capped":true}\n');
      return;
    }
    const line = {
      at: now.toISOString(),
      url: redactUrl(attempt.url),
      hops: (attempt.hops ?? []).map((hop) => ({ ...hop, url: redactUrl(hop.url) })),
      status: attempt.status ?? null,
      bytes: attempt.bytes ?? attempt.body?.byteLength ?? 0,
      contentType: attempt.contentType ?? null,
      sha256:
        attempt.sha256 ??
        (attempt.body ? NodeCrypto.createHash("sha256").update(attempt.body).digest("hex") : null),
      threadId: context.threadId ?? null,
      courseId: context.courseId ?? null,
      ...(attempt.blocked ? { blocked: attempt.blocked } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
    };
    await NodeFSP.appendFile(file, `${JSON.stringify(line)}\n`);
  } catch (cause) {
    console.warn(`Could not write download audit log: ${String(cause)}`);
  }
};
