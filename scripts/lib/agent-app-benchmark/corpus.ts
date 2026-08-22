// @effect-diagnostics nodeBuiltinImport:off - contributor CLI materializes a deterministic local artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  type AgentAppCorpus,
  type AgentAppCorpusCounts,
  type AgentAppCorpusGeneratorConfig,
  type AgentAppCorpusManifest,
  type CorpusLifecycleEvent,
  type CorpusPart,
  type CorpusSession,
  decodeAgentAppCorpus,
  decodeCorpusGeneratorConfig,
} from "./contracts.ts";

type CorpusWithoutManifest = Omit<AgentAppCorpus, "manifest"> & { readonly manifest?: undefined };
type MutableCounts = { -readonly [Key in keyof AgentAppCorpusCounts]: number };

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(sortJson(value));
export const sha256 = (value: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

function partRenderableText(part: CorpusPart): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    case "markdown":
      return part.markdown;
    case "code":
      return `${part.language}\n${part.code}`;
    case "table":
      return [...part.headers, ...part.rows.flat()].join("\n");
    case "diff":
      return `${part.path}\n${part.oldText}\n${part.newText}\n${part.patch}`;
    case "attachment":
      return `${part.name}\n${part.mediaType}\n${part.sizeBytes}\n${part.sha256}`;
    case "tool":
      return `${part.toolName}\n${part.state}\n${part.inputJson}\n${part.outputText}`;
  }
}

function emptyCounts(): MutableCounts {
  return {
    sessions: 0,
    turns: 0,
    messages: 0,
    parts: 0,
    textParts: 0,
    markdownParts: 0,
    codeParts: 0,
    tableParts: 0,
    diffParts: 0,
    toolParts: 0,
    reasoningParts: 0,
    attachments: 0,
    lifecycleEvents: 0,
    terminalStreams: 0,
    terminalBytes: 0,
    renderableBytes: 0,
  };
}

function semanticPayload(sessions: ReadonlyArray<CorpusSession>): unknown {
  return sessions.map((session) => ({
    order: session.order,
    turns: session.turns.map((turn) => ({
      index: turn.index,
      anchor: turn.anchor,
      messages: turn.messages.map((message) => ({
        order: message.order,
        role: message.role,
        parts: message.parts.map((part) => ({
          order: part.order,
          type: part.type,
          content: partRenderableText(part),
        })),
      })),
    })),
    events: session.events,
  }));
}

function terminalBytes(sessions: ReadonlyArray<CorpusSession>): Buffer {
  const buffers = sessions.flatMap((session) =>
    session.terminalStreams.flatMap((stream) =>
      stream.chunks.map((chunk) => Buffer.from(chunk.bytesBase64, "base64")),
    ),
  );
  return Buffer.concat(buffers);
}

export function computeCorpusManifest(corpus: CorpusWithoutManifest): AgentAppCorpusManifest {
  const counts = emptyCounts();
  counts.sessions = corpus.sessions.length;
  for (const session of corpus.sessions) {
    counts.turns += session.turns.length;
    counts.lifecycleEvents += session.events.length;
    counts.terminalStreams += session.terminalStreams.length;
    for (const stream of session.terminalStreams) counts.terminalBytes += stream.expectedBytes;
    for (const turn of session.turns) {
      counts.messages += turn.messages.length;
      for (const message of turn.messages) {
        counts.parts += message.parts.length;
        for (const part of message.parts) {
          counts.renderableBytes += Buffer.byteLength(partRenderableText(part));
          switch (part.type) {
            case "text":
              counts.textParts += 1;
              break;
            case "markdown":
              counts.markdownParts += 1;
              break;
            case "code":
              counts.codeParts += 1;
              break;
            case "table":
              counts.tableParts += 1;
              break;
            case "diff":
              counts.diffParts += 1;
              break;
            case "tool":
              counts.toolParts += 1;
              break;
            case "reasoning":
              counts.reasoningParts += 1;
              break;
            case "attachment":
              counts.attachments += 1;
              break;
          }
        }
      }
    }
  }

  const payload = {
    schemaVersion: corpus.schemaVersion,
    kind: corpus.kind,
    corpusId: corpus.corpusId,
    source: corpus.source,
    seed: corpus.seed,
    sessions: corpus.sessions,
  };
  return {
    counts,
    hashes: {
      corpusSha256: sha256(canonicalJson(payload)),
      semanticSha256: sha256(canonicalJson(semanticPayload(corpus.sessions))),
      terminalSha256: sha256(terminalBytes(corpus.sessions)),
    },
  };
}

function repeatToByteLength(value: string, byteLength: number): Buffer {
  const source = Buffer.from(value);
  const output = Buffer.allocUnsafe(byteLength);
  for (let offset = 0; offset < output.length; offset += source.length) {
    source.copy(output, offset, 0, Math.min(source.length, output.length - offset));
  }
  return output;
}

function makeTerminalStream(
  sessionIndex: number,
  chunkCount: number,
  chunkBytes: number,
): CorpusSession["terminalStreams"][number] {
  const chunks = Array.from({ length: chunkCount }, (_, sequence) => {
    const prefix = `\u001b[3${sequence % 8}m[${sessionIndex.toString().padStart(2, "0")}:${sequence
      .toString()
      .padStart(3, "0")}]\u001b[0m `;
    return {
      sequence,
      atMs: sequence * 4,
      bytesBase64: repeatToByteLength(
        `${prefix}agent-app terminal output · | +- ascii payload\r\n`,
        chunkBytes,
      ).toString("base64"),
    };
  });
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytesBase64, "base64")));
  return {
    id: `terminal-${sessionIndex.toString().padStart(2, "0")}`,
    columns: 120,
    rows: 36,
    chunks,
    inputSentinels: [
      `INPUT-${sessionIndex.toString().padStart(2, "0")}-A`,
      `INPUT-${sessionIndex}-B`,
    ],
    expectedBytes: bytes.length,
    expectedSha256: sha256(bytes),
  };
}

function makeTurn(
  sessionIndex: number,
  turnIndex: number,
  turnCount: number,
  seedMarker: string,
  // Part-payload multiplier for heavy-tail sessions. 1 keeps the historical
  // corpus byte-identical. Above 1, every turn additionally carries an
  // agent-realistic load: a multi-hunk diff, a bulky tool result, and a shell
  // call with long output — the part mix that dominates real agent
  // transcripts and drives renderer cost (diff viewers, tool cards, ANSI
  // text), which the toy-sized modulo parts never exercise.
  weight = 1,
): CorpusSession["turns"][number] {
  const prefix = `s${sessionIndex.toString().padStart(2, "0")}-t${turnIndex
    .toString()
    .padStart(3, "0")}`;
  const assistantParts: Array<CorpusPart> = [
    {
      id: `${prefix}-answer`,
      order: 0,
      type: "text",
      text: `Completed deterministic task ${turnIndex} in workspace ${sessionIndex}. ${"Result detail. ".repeat(
        8 + (turnIndex % 8),
      )}`,
    },
    {
      id: `${prefix}-markdown`,
      order: 1,
      type: "markdown",
      markdown: `## Result ${turnIndex}\n\n- deterministic\n- reproducible\n\n> Session ${sessionIndex}\n\n${"Paragraph content. ".repeat(
        12 + (turnIndex % 6),
      )}`,
    },
  ];
  if (turnIndex % 2 === 0) {
    assistantParts.push({
      id: `${prefix}-code`,
      order: assistantParts.length,
      type: "code",
      language: "typescript",
      code: `export const fixture${turnIndex} = { session: ${sessionIndex}, lines: [${Array.from(
        { length: 24 },
        (_, index) => index,
      ).join(", ")}] };\n`,
    });
  }
  if (turnIndex % 3 === 0) {
    // Real sessions carry diffs INSIDE completed edit/patch tool calls, which
    // every app renders collapsed — never as inline assistant prose. Emitting
    // them as markdown forced both apps to paint huge synthetic diff blocks no
    // real transcript would show at switch time.
    assistantParts.push({
      id: `${prefix}-diff`,
      order: assistantParts.length,
      type: "tool",
      callId: `${prefix}-patch-call`,
      toolName: "apply_patch",
      state: "completed",
      inputJson: JSON.stringify({ path: `src/generated/fixture-${sessionIndex}-${turnIndex}.ts` }),
      outputText: `@@ -1 +1,2 @@\n-export const value = ${turnIndex};\n+export const value = ${turnIndex + 1};\n+export const verified = true;\n`,
    });
  }
  if (turnIndex % 4 === 0) {
    assistantParts.push({
      id: `${prefix}-tool`,
      order: assistantParts.length,
      type: "tool",
      callId: `${prefix}-call`,
      toolName: "read_fixture",
      state: "completed",
      inputJson: JSON.stringify({ fixture: turnIndex, session: sessionIndex }),
      outputText: `${"line: deterministic tool output\n".repeat(20 + (turnIndex % 10))}`,
    });
  }
  if (turnIndex % 5 === 0) {
    assistantParts.push(
      {
        id: `${prefix}-table`,
        order: assistantParts.length,
        type: "table",
        headers: ["metric", "before", "after"],
        rows: Array.from({ length: 12 }, (_, row) => [
          `case-${row}`,
          `${turnIndex + row}`,
          `${turnIndex + row + 1}`,
        ]),
      },
      {
        id: `${prefix}-reasoning`,
        order: assistantParts.length + 1,
        type: "reasoning",
        text: `Evaluate fixture ${turnIndex}. ${"Check the invariant. ".repeat(18)}`,
      },
    );
  }
  if (weight > 1) {
    const hunkLines = (offset: number) =>
      Array.from(
        { length: 10 * weight },
        (_, line) =>
          `  value_${turnIndex}_${offset + line} = compute(${sessionIndex}, ${offset + line});`,
      );
    assistantParts.push(
      {
        // Heavy diffs ride inside completed patch tool calls (see the light
        // diff above): the bytes stay in the seed data, painted as a collapsed
        // tool card instead of synthetic inline diff prose.
        id: `${prefix}-heavy-diff`,
        order: assistantParts.length,
        type: "tool",
        callId: `${prefix}-heavy-patch-call`,
        toolName: "apply_patch",
        state: "completed",
        inputJson: JSON.stringify({ path: `src/generated/heavy-${sessionIndex}-${turnIndex}.ts` }),
        outputText:
          Array.from(
            { length: 3 },
            (_, hunk) =>
              `@@ -${hunk * 10 * weight + 1},${10 * weight} +${hunk * 10 * weight + 1},${10 * weight + 1} @@\n` +
              hunkLines(hunk)
                .map((line) => `-${line}`)
                .join("\n") +
              "\n" +
              hunkLines(hunk + 1)
                .map((line) => `+${line}`)
                .join("\n"),
          ).join("\n") + "\n",
      },
      {
        id: `${prefix}-heavy-tool`,
        order: assistantParts.length + 1,
        type: "tool",
        callId: `${prefix}-heavy-call`,
        toolName: "search_workspace",
        state: "completed",
        inputJson: JSON.stringify({
          query: `fixture-${turnIndex}`,
          session: sessionIndex,
          limit: 50 * weight,
        }),
        outputText: Array.from(
          { length: 40 * weight },
          (_, line) =>
            `src/module-${line % 23}/file-${line}.ts:${line + 1}: match fixture-${turnIndex} (${seedMarker})`,
        ).join("\n"),
      },
      {
        id: `${prefix}-heavy-shell`,
        order: assistantParts.length + 2,
        type: "tool",
        callId: `${prefix}-shell-call`,
        toolName: "run_shell",
        state: "completed",
        inputJson: JSON.stringify({ command: `pnpm test --filter module-${turnIndex % 23}` }),
        outputText: Array.from({ length: 60 * weight }, (_, line) =>
          line % 7 === 6
            ? `PASS suite-${Math.floor(line / 7)} (${(line % 900) + 100}ms)`
            : ` \u2713 case ${line} deterministic assertion holds (${seedMarker})`,
        ).join("\n"),
      },
    );
  }
  if (turnIndex % 7 === 0) {
    assistantParts.push({
      id: `${prefix}-attachment`,
      order: assistantParts.length,
      type: "attachment",
      name: `fixture-${sessionIndex}-${turnIndex}.png`,
      mediaType: "image/png",
      sizeBytes: 64_000 + turnIndex,
      sha256: sha256(`attachment:${sessionIndex}:${turnIndex}`),
    });
  }

  const anchor =
    turnIndex === 0
      ? "first"
      : turnIndex === Math.floor((turnCount - 1) / 2)
        ? "middle"
        : turnIndex === turnCount - 1
          ? "last"
          : undefined;
  return {
    id: `${prefix}-turn`,
    index: turnIndex,
    ...(anchor === undefined ? {} : { anchor }),
    messages: [
      {
        id: `${prefix}-user`,
        order: 0,
        role: "user",
        parts: [
          {
            id: `${prefix}-prompt`,
            order: 0,
            type: "text",
            text: `Inspect deterministic fixture ${turnIndex} for session ${sessionIndex} (seed ${seedMarker}). ${"Context. ".repeat(
              5 + (turnIndex % 5),
            )}`,
          },
        ],
      },
      { id: `${prefix}-assistant`, order: 1, role: "assistant", parts: assistantParts },
    ],
  };
}

function makeEvents(session: CorpusSession): ReadonlyArray<CorpusLifecycleEvent> {
  const events: Array<CorpusLifecycleEvent> = [];
  for (const turn of session.turns) {
    const assistant = turn.messages[1];
    const text = assistant?.parts.find((part) => part.type === "text");
    if (assistant && text?.type === "text") {
      const halfway = Math.floor(text.text.length / 2);
      events.push(
        {
          id: `${turn.id}-revision-1`,
          sequence: events.length,
          atMs: turn.index * 50,
          type: "message-part-revision",
          messageId: assistant.id,
          partId: text.id,
          revision: 1,
          content: text.text.slice(0, halfway),
        },
        {
          id: `${turn.id}-revision-2`,
          sequence: events.length + 1,
          atMs: turn.index * 50 + 8,
          type: "message-part-revision",
          messageId: assistant.id,
          partId: text.id,
          revision: 2,
          content: text.text,
        },
      );
    }
    const tool = assistant?.parts.find((part) => part.type === "tool");
    if (tool?.type === "tool") {
      for (const [offset, state] of ["pending", "running", "completed"].entries()) {
        events.push({
          id: `${turn.id}-tool-${state}`,
          sequence: events.length,
          atMs: turn.index * 50 + 12 + offset * 4,
          type: "tool-lifecycle",
          callId: tool.callId,
          toolName: tool.toolName,
          state: state as "pending" | "running" | "completed",
          ...(state === "pending" ? { inputJson: tool.inputJson } : {}),
          ...(state === "completed" ? { outputText: tool.outputText } : {}),
        });
      }
    }
    events.push({
      id: `${turn.id}-complete`,
      sequence: events.length,
      atMs: turn.index * 50 + 32,
      type: "stream-complete",
      turnId: turn.id,
    });
  }
  return events;
}

export function generatePublicCorpus(config: AgentAppCorpusGeneratorConfig): AgentAppCorpus {
  const seedMarker = sha256(config.seed).slice(0, 12);
  const heavyCount = config.scale.heavySessionCount ?? 0;
  const heavyStart = config.scale.sessionCount - heavyCount;
  const gradedTo = config.scale.gradedTurnsTo;
  const lastIndex = Math.max(1, config.scale.sessionCount - 1);
  const sessions = Array.from({ length: config.scale.sessionCount }, (_, sessionIndex) => {
    // The heavy tail occupies the LAST indices so light-session ids/content are
    // byte-identical to a uniform corpus of the same seed — only the tail
    // differs, which keeps cross-corpus debugging sane.
    const isHeavy = heavyCount > 0 && sessionIndex >= heavyStart;
    // Graded ramp: geometric in turns (equal RATIO steps resolve the trend
    // across scales), linear in part weight. Overrides the heavy tail.
    const turnCount =
      gradedTo !== undefined
        ? Math.round(
            config.scale.turnsPerSession *
              (gradedTo / config.scale.turnsPerSession) ** (sessionIndex / lastIndex),
          )
        : isHeavy
          ? (config.scale.heavyTurnsPerSession ?? config.scale.turnsPerSession)
          : config.scale.turnsPerSession;
    const weight =
      gradedTo !== undefined
        ? 1 + Math.round(((config.scale.gradedPartWeightTo ?? 1) - 1) * (sessionIndex / lastIndex))
        : isHeavy
          ? (config.scale.heavyPartWeight ?? 1)
          : 1;
    const workspaceCount = config.scale.workspaceCount ?? 0;
    const partial: CorpusSession = {
      id: `session-${sessionIndex.toString().padStart(2, "0")}`,
      title: `Deterministic workspace ${sessionIndex.toString().padStart(2, "0")}`,
      order: sessionIndex,
      ...(workspaceCount > 0
        ? {
            workspaceId: `workspace-${(sessionIndex % workspaceCount).toString().padStart(2, "0")}`,
          }
        : {}),
      turns: Array.from({ length: turnCount }, (_, turnIndex) =>
        makeTurn(sessionIndex, turnIndex, turnCount, seedMarker, weight),
      ),
      events: [],
      terminalStreams: [
        makeTerminalStream(
          sessionIndex,
          config.scale.terminalChunkCount,
          config.scale.terminalChunkBytes,
        ),
      ],
    };
    return { ...partial, events: makeEvents(partial) };
  });
  const withoutManifest: CorpusWithoutManifest = {
    schemaVersion: 1,
    kind: "agent-app-corpus",
    corpusId: config.corpusId,
    source: "generated-public",
    seed: config.seed,
    sessions,
  };
  return decodeAgentAppCorpus({
    ...withoutManifest,
    manifest: computeCorpusManifest(withoutManifest),
  });
}

export function serializeCorpus(corpus: AgentAppCorpus): string {
  return `${canonicalJson(corpus)}\n`;
}

export function validateCorpusIntegrity(corpus: AgentAppCorpus): AgentAppCorpusManifest {
  const computed = computeCorpusManifest({
    schemaVersion: corpus.schemaVersion,
    kind: corpus.kind,
    corpusId: corpus.corpusId,
    source: corpus.source,
    seed: corpus.seed,
    sessions: corpus.sessions,
  });
  if (canonicalJson(computed) !== canonicalJson(corpus.manifest)) {
    throw new Error(
      `Corpus integrity mismatch: expected ${corpus.manifest.hashes.corpusSha256}, computed ${computed.hashes.corpusSha256}.`,
    );
  }
  return computed;
}

export async function readCorpusGeneratorConfig(
  path: string,
): Promise<AgentAppCorpusGeneratorConfig> {
  const source = await NodeFSP.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid corpus generator JSON at ${path}.`, { cause: error });
  }
  return decodeCorpusGeneratorConfig(parsed);
}

export async function runCorpusGeneratorCli(args: ReadonlyArray<string>): Promise<void> {
  const [configPath, outputPath] = args;
  if (!configPath || !outputPath) {
    throw new Error("Usage: corpus.ts <generator-config.json> <output-corpus.json>");
  }
  const config = await readCorpusGeneratorConfig(configPath);
  const corpus = generatePublicCorpus(config);
  if (canonicalJson(corpus.manifest) !== canonicalJson(config.expectedManifest)) {
    throw new Error(
      `Generated corpus manifest ${corpus.manifest.hashes.corpusSha256} does not match committed manifest ${config.expectedManifest.hashes.corpusSha256}.`,
    );
  }
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  await NodeFSP.writeFile(outputPath, serializeCorpus(corpus), { encoding: "utf8", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  runCorpusGeneratorCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
