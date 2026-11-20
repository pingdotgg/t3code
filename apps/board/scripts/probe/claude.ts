import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { ProbeContext } from "./connection.ts";
import { clip, short } from "./format.ts";
import {
  awaitRunEnd,
  createProject,
  lastAssistantText,
  launchThread,
  toolOutputs,
} from "./helpers.ts";

const CLAUDE_SETTINGS = NodePath.join(NodeOS.homedir(), ".claude", "settings.json");
const sha256 = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex").slice(0, 12);

const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
);

export async function checkA(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const before = sha256(CLAUDE_SETTINGS);
  const settings = decodeSettings(NodeFS.readFileSync(CLAUDE_SETTINGS, "utf8"));
  const configured = settings.env?.["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"];
  evidence(
    `~/.claude/settings.json env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = ${configured ?? "unset"}`,
  );
  const project = await createProject(ctx, "check-a");
  const threadId = await launchThread(ctx, project, {
    title: "probe A",
    message:
      "Run `printenv CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` with the Bash tool and reply with exactly AUTOCOMPACT=<output>, nothing else.",
  });
  const projection = await awaitRunEnd(ctx, threadId);
  const reply = lastAssistantText(projection);
  const seen = /AUTOCOMPACT=(\d+)/.exec(reply)?.[1];
  const maxTokens =
    projection.providerTurns.findLast((turn) => turn.tokenUsage?.maxTokens != null)?.tokenUsage
      ?.maxTokens ?? null;
  evidence(
    `thread ${short(threadId)} Bash saw CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${seen ?? "nothing"} (reply: ${clip(reply, 80)})`,
  );
  if (seen !== undefined && maxTokens !== null) {
    evidence(
      `observed compaction threshold: ${seen}% of the ${maxTokens}-token window = ${Math.round((Number(seen) / 100) * maxTokens)} tokens [INFERENCE: Claude Code applies the percentage to the window it reports]`,
    );
  }
  const after = sha256(CLAUDE_SETTINGS);
  evidence(
    `settings.json sha256 before ${before}, after ${after}: ${before === after ? "unchanged" : "CHANGED"}`,
  );
  return configured !== undefined && seen === configured && before === after;
}

const MEMORY_WORD = `probe-${NodeCrypto.randomBytes(3).toString("hex")}`;

export const claudeProjectsDir = () =>
  NodePath.join(
    process.env["CLAUDE_CONFIG_DIR"] ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  );
export const claudeProjectKey = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

function memoryFiles(prefix: string): ReadonlyArray<string> {
  const root = claudeProjectsDir();
  if (!NodeFS.existsSync(root)) return [];
  return NodeFS.readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .flatMap((name) => {
      const dir = NodePath.join(root, name, "memory");
      return NodeFS.existsSync(dir)
        ? NodeFS.readdirSync(dir).map((entry) => NodePath.join(dir, entry))
        : [];
    });
}

export async function checkI(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-i");
  const prefix = claudeProjectKey(project.root);
  const first = await launchThread(ctx, project, {
    title: "probe I writer",
    message: `Save a memory in your auto memory for this project: the project's launch codeword is ${MEMORY_WORD}. Write it to your project memory directory, then reply SAVED.`,
  });
  await awaitRunEnd(ctx, first);
  const files = memoryFiles(prefix);
  const holders = files.filter((path) => NodeFS.readFileSync(path, "utf8").includes(MEMORY_WORD));
  evidence(
    `session 1 (thread ${short(first)}) memory files: ${files.length === 0 ? "none" : files.join(", ")}`,
  );
  evidence(
    `memory files holding ${MEMORY_WORD}: ${holders.length === 0 ? "none" : holders.join(", ")}`,
  );
  const second = await launchThread(ctx, project, {
    title: "probe I reader",
    message:
      "This is a new session. Using only your project memory, tell me the project's launch codeword. Reply with exactly CODEWORD=<word>, or CODEWORD=unknown.",
  });
  const reply = lastAssistantText(await awaitRunEnd(ctx, second));
  evidence(`session 2 (thread ${short(second)}) read back: ${clip(reply, 120)}`);
  return holders.length > 0 && reply.includes(MEMORY_WORD);
}

export async function checkJ(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const marker = `probe-marker-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const page = NodeHttp.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>${marker}</title><h1 id="m">${marker}</h1>`);
  });
  const listening = Promise.withResolvers<void>();
  page.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  try {
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = page.address() as NodeNet.AddressInfo;
    const url = `http://127.0.0.1:${port}/`;
    const project = await createProject(ctx, "check-j");
    const threadId = await launchThread(ctx, project, {
      title: "probe J",
      message: `No browser or app window is open. Use the t3-code MCP tools named preview_open (with url ${url}) and then preview_snapshot. Reply with exactly SNAPSHOT: <the page text from the snapshot>, or ERROR: <the tool error text, verbatim> if a tool fails.`,
    });
    const projection = await awaitRunEnd(ctx, threadId);
    const reply = lastAssistantText(projection);
    evidence(`served page ${url} with marker ${marker}`);
    for (const line of await toolOutputs(ctx, threadId, projection, /preview_/)) evidence(line);
    evidence(`thread reply: ${clip(reply, 300)}`);
    return reply.includes(marker) && /^SNAPSHOT/.test(reply.trim());
  } finally {
    page.close();
  }
}
