// @effect-diagnostics nodeBuiltinImport:off -- tests inspect symlinks, NTFS/hard links, and native SQLite WAL files directly.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { AntigravityDriver } from "../Drivers/AntigravityDriver.ts";
import * as AntigravityUsage from "../Drivers/AntigravityUsage.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import {
  resolveAntigravityInstanceDirectories,
  type AntigravityProfile,
} from "../antigravityAuthSupport.ts";
import { makeAntigravityAcpRuntime } from "./AntigravityAcpSupport.ts";
import { readAntigravityChildWork, readAntigravityPendingReply } from "./AntigravityChildWork.ts";
import { autoApproved, CHILD, makeProfile, ROOT } from "./AntigravityChildWork.testkit.ts";
import {
  antigravityProfileRoot,
  ANTIGRAVITY_DISPOSABLE_DIR,
  ANTIGRAVITY_SESSION_SLOTS_DIR,
  ANTIGRAVITY_SESSIONS_DIR,
  readAntigravitySessionSlotId,
} from "./AntigravityProfilePaths.ts";
import {
  migrateLegacyAntigravitySession,
  prepareAntigravitySessionAppDataDir,
} from "./AntigravitySessionSlots.ts";
import { watchAntigravityPromptOutcome } from "./AntigravityTurnOutcome.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const personalAuth = {
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
} as const;

const layerBase = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agy-isolation-cfg-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerDriver = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerBase),
);
const layerUsage = AntigravityUsage.layer.pipe(Layer.provideMerge(layerDriver));

const makeFakeAgyScript = (input: {
  readonly logPath: string;
  readonly version?: string;
  readonly replayText?: string;
  readonly loadSession?: boolean;
  readonly resume?: boolean;
}) =>
  [
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    `const logPath = ${JSON.stringify(input.logPath)};`,
    `const version = ${JSON.stringify(input.version ?? "1.5.18")};`,
    `const replayText = ${JSON.stringify(input.replayText ?? "replayed-history")};`,
    `const loadSession = ${JSON.stringify(input.loadSession ?? true)};`,
    `const resumeCap = ${JSON.stringify(input.resume ?? true)};`,
    "const args = process.argv.slice(2);",
    "const idx = args.indexOf('--app-data-dir');",
    "const appDataDir = idx === -1 ? '' : args[idx + 1];",
    "let activeId = '';",
    "let buf = '';",
    "const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buf += chunk;",
    "  while (true) {",
    "    const nl = buf.indexOf('\\n');",
    "    if (nl === -1) break;",
    "    const line = buf.slice(0, nl).trim();",
    "    buf = buf.slice(nl + 1);",
    "    if (!line) continue;",
    "    const req = JSON.parse(line);",
    "    if (req.method === 'session/new') {",
    "      activeId = crypto.randomUUID();",
    "      fs.appendFileSync(logPath, JSON.stringify({ method: req.method, params: req.params, sessionId: activeId, appDataDir }) + '\\n');",
    "      send({ jsonrpc: '2.0', id: req.id, result: { sessionId: activeId, configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-test-low', options: [{ value: 'gemini-test-low', name: 'Low' }] }] } });",
    "    } else {",
    "      fs.appendFileSync(logPath, JSON.stringify({ method: req.method, params: req.params, appDataDir }) + '\\n');",
    "    }",
    "    if (req.method === 'initialize') {",
    "      const sessionCapabilities = resumeCap ? { resume: {}, fork: {} } : { fork: {} };",
    "      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession, auth: { logout: {} }, sessionCapabilities }, authMethods: [{ id: 'oauth-personal', name: 'Google' }], agentInfo: { name: 'antigravity-acp', version } } });",
    "    } else if (req.method === 'authenticate' || req.method === 'logout') {",
    "      send({ jsonrpc: '2.0', id: req.id, result: {} });",
    "    } else if (req.method === 'session/new') {",
    "      // Handled above so the log records the returned sessionId.",
    "    } else if (req.method === 'session/resume') {",
    "      activeId = req.params.sessionId;",
    "      send({ jsonrpc: '2.0', id: req.id, result: { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-test-low', options: [{ value: 'gemini-test-low', name: 'Low' }] }] } });",
    "    } else if (req.method === 'session/load') {",
    "      activeId = req.params.sessionId;",
    "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: activeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replayText } } } });",
    "      send({ jsonrpc: '2.0', id: req.id, result: { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-test-low', options: [{ value: 'gemini-test-low', name: 'Low' }] }] } });",
    "    } else if (req.method === 'session/set_config_option') {",
    "      send({ jsonrpc: '2.0', id: req.id, result: { configOptions: [] } });",
    "    }",
    "  }",
    "});",
    "",
  ].join("\n");

it.layer(layerUsage)("Antigravity session isolation", (it) => {
  it.effect.skipIf(windowsHost)(
    "links shared auth, user-symlinked plugin_data, and dangling MCP symlinks without dropping slot installation_id",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-slot-links-" });
        const geminiHome = path.join(root, "profile");
        const acpDirectory = path.join(geminiHome, "antigravity-acp");
        const cliDirectory = path.join(root, "antigravity-cli");
        const externalPluginData = path.join(cliDirectory, "plugin_data");
        yield* fs.makeDirectory(acpDirectory, { recursive: true });
        yield* fs.makeDirectory(externalPluginData, { recursive: true });

        const canonicalToken = path.join(acpDirectory, "antigravity-oauth-token");
        const externalMcp = path.join(cliDirectory, "mcp_oauth_tokens.json");
        const canonicalMcp = path.join(acpDirectory, "mcp_oauth_tokens.json");
        const canonicalPluginData = path.join(acpDirectory, "plugin_data");
        yield* fs.writeFileString(canonicalToken, "token-v1");
        // Leave externalMcp absent initially to verify dangling user symlinks stay linked.
        yield* Effect.promise(() => NodeFSP.symlink(externalMcp, canonicalMcp, "file"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(externalPluginData, canonicalPluginData, "dir"),
        );

        const profile: AntigravityProfile = {
          platform: hostPlatform,
          geminiHome,
          acpDirectory,
          tokenPath: path.join(acpDirectory, "acp_token.json"),
          tempDirectory: path.join(acpDirectory, "tmp"),
          browserCommand: "noop",
        };
        const slotId = "11111111-1111-4111-8111-111111111111";
        const slot = yield* prepareAntigravitySessionAppDataDir({
          profile,
          auth: personalAuth,
          kind: "session",
          slotId,
        });
        const disposable = yield* prepareAntigravitySessionAppDataDir({
          profile,
          auth: personalAuth,
          kind: "disposable",
          slotId: "22222222-2222-4222-8222-222222222222",
        });

        expect((yield* fs.readLink(canonicalMcp)).length).toBeGreaterThan(0);
        expect(yield* fs.readLink(path.join(slot.directory, "antigravity-oauth-token"))).toBe(
          canonicalToken,
        );
        expect(yield* fs.readLink(path.join(slot.directory, "mcp_oauth_tokens.json"))).toBe(
          canonicalMcp,
        );
        expect(yield* fs.readLink(path.join(slot.directory, "plugin_data"))).toBe(
          canonicalPluginData,
        );

        // In-place writes from inside the slot reach canonical and create external symlink targets.
        yield* fs.writeFileString(path.join(slot.directory, "antigravity-oauth-token"), "token-v2");
        yield* fs.writeFileString(
          path.join(slot.directory, "mcp_oauth_tokens.json"),
          '{"figma":"v2"}\n',
        );
        expect(yield* fs.readFileString(canonicalToken)).toBe("token-v2");
        expect(yield* fs.readFileString(externalMcp)).toBe('{"figma":"v2"}\n');

        // A slot-local installation_id must survive resume when canonical installation_id is absent.
        const slotInstallId = path.join(slot.directory, "installation_id");
        yield* fs.writeFileString(slotInstallId, "slot-install-1");
        yield* prepareAntigravitySessionAppDataDir({
          profile,
          auth: personalAuth,
          kind: "session",
          slotId,
          clearSummaryState: true,
        });
        expect(yield* fs.readFileString(slotInstallId)).toBe("slot-install-1");

        expect(yield* fs.exists(path.join(disposable.directory, "plugin_data"))).toBe(false);
        expect(yield* fs.exists(path.join(disposable.directory, "mcp_oauth_tokens.json"))).toBe(
          false,
        );
        expect(yield* fs.readLink(path.join(disposable.directory, "antigravity-oauth-token"))).toBe(
          canonicalToken,
        );
      }),
  );

  it.effect(
    "hard-links shared auth and MCP files under win32 semantics and keeps updates synchronized",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-win32-links-" });
        const geminiHome = path.join(root, "profile");
        const acpDirectory = path.join(geminiHome, "antigravity-acp");
        yield* fs.makeDirectory(acpDirectory, { recursive: true });

        const canonicalToken = path.join(acpDirectory, "antigravity-oauth-token");
        yield* fs.writeFileString(canonicalToken, "win-token-v1");
        const profile: AntigravityProfile = {
          platform: "win32",
          geminiHome,
          acpDirectory,
          tokenPath: path.join(acpDirectory, "acp_token.json"),
          tempDirectory: path.join(acpDirectory, "tmp"),
          browserCommand: "noop",
        };
        const slotId = "44444444-4444-4444-8444-444444444444";
        const slot = yield* prepareAntigravitySessionAppDataDir({
          profile,
          auth: personalAuth,
          kind: "session",
          slotId,
        });

        const slotToken = path.join(slot.directory, "antigravity-oauth-token");
        const slotMcp = path.join(slot.directory, "mcp_oauth_tokens.json");
        const canonicalMcp = path.join(acpDirectory, "mcp_oauth_tokens.json");
        expect(yield* fs.readFileString(slotToken)).toBe("win-token-v1");
        expect(yield* fs.readFileString(slotMcp)).toBe("{}\n");
        yield* fs.writeFileString(slotToken, "win-token-v2");
        expect(yield* fs.readFileString(canonicalToken)).toBe("win-token-v2");
        yield* fs.writeFileString(slotMcp, '{"srv":"tok"}\n');
        expect(yield* fs.readFileString(canonicalMcp)).toBe('{"srv":"tok"}\n');

        // Re-preparing an already linked slot preserves the link and refreshed contents.
        yield* prepareAntigravitySessionAppDataDir({
          profile,
          auth: personalAuth,
          kind: "session",
          slotId,
        });
        expect(yield* fs.readFileString(slotToken)).toBe("win-token-v2");

        // A cross-volume canonical token cannot be hard-linked; the slot must still share it
        // (or fail explicitly when the Windows host lacks file-symlink privileges).
        const crossSlotId = "55555555-5555-4555-8555-555555555555";
        const fsPromises = NodeFS.promises;
        const realLink = fsPromises.link;
        fsPromises.link = () =>
          Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
        NodeModule.syncBuiltinESMExports();
        const crossResult = yield* Effect.result(
          prepareAntigravitySessionAppDataDir({
            profile,
            auth: personalAuth,
            kind: "session",
            slotId: crossSlotId,
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                fsPromises.link = realLink;
                NodeModule.syncBuiltinESMExports();
              }),
            ),
          ),
        );
        if (crossResult._tag === "Failure") {
          expect(windowsHost).toBe(true);
          expect(crossResult.failure._tag).toBe("AcpTransportError");
        } else {
          const crossSlot = crossResult.success;
          const crossToken = path.join(crossSlot.directory, "antigravity-oauth-token");
          yield* fs.writeFileString(crossToken, "win-token-v3");
          expect(yield* fs.readFileString(canonicalToken)).toBe("win-token-v3");
          yield* prepareAntigravitySessionAppDataDir({
            profile,
            auth: personalAuth,
            kind: "session",
            slotId: crossSlotId,
          });
          expect(yield* fs.readFileString(crossToken)).toBe("win-token-v3");
          expect(yield* fs.readFileString(canonicalToken)).toBe("win-token-v3");
        }
      }),
  );

  it.effect(
    "migrates DB-backed and detached 1.5 legacy sessions (with WAL) and aggregates slots under one AntigravityUsage source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const usage = yield* AntigravityUsage.AntigravityUsage;
        const instanceId = ProviderInstanceId.make("antigravity-legacy-migration");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        const profile = directories.profile;
        const slotId = "33333333-3333-4333-8333-333333333333";
        const detachedSlotId = "55555555-5555-4555-8555-555555555555";
        const detachedRoot = "88888888-8888-4888-8888-888888888888";
        const detachedChild = "99999999-9999-4999-8999-999999999999";

        // 1. Pure DB-backed legacy session (step_type = 127 only, no subagents/*.json).
        const seeded = yield* makeProfile({ profile, steps: autoApproved });
        const acp = path.join(profile, "antigravity-acp");
        const legacyDbPath = path.join(acp, "conversations", `${ROOT}.db`);
        const historicalSec = 1_700_000_000;
        const badGatewayError = Buffer.concat([
          Buffer.from([0x0a, 0x24]),
          Buffer.from(
            "Agent execution terminated due to error.\u0012agent executor error: Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []: Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []\n(1) attached stack trace\n  -- stack trace:\nThe model is currently unreachable.",
          ),
        ]);
        // Stage the WAL writes on a scratch DB so no handle stays open on `legacyDbPath` during migration.
        const scratchDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-wal-stage-" });
        const scratchDbPath = path.join(scratchDir, `${ROOT}.db`);
        yield* Effect.promise(async () => {
          await NodeFSP.copyFile(legacyDbPath, scratchDbPath);
          let scratchReader: NodeSqlite.DatabaseSync | undefined;
          try {
            const db = new NodeSqlite.DatabaseSync(scratchDbPath);
            try {
              db.exec("PRAGMA journal_mode = WAL");
              db.exec("PRAGMA wal_autocheckpoint = 0");
              scratchReader = new NodeSqlite.DatabaseSync(scratchDbPath, { readOnly: true });
              scratchReader.prepare("SELECT count(*) FROM steps").get();
              db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
                99,
                17,
                badGatewayError,
              );
              db.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
              const usageMeta = new Uint8Array([
                0x4a,
                4,
                0x10,
                42,
                0x18,
                13,
                ...Buffer.from("420608a087b7d306", "hex"),
              ]);
              db.prepare("UPDATE steps SET metadata = ? WHERE idx = 99").run(usageMeta);
            } finally {
              db.close();
            }
            await NodeFSP.copyFile(scratchDbPath, legacyDbPath);
            await NodeFSP.copyFile(`${scratchDbPath}-wal`, `${legacyDbPath}-wal`);
          } finally {
            scratchReader?.close();
          }
          await NodeFSP.utimes(legacyDbPath, historicalSec, historicalSec);
          await NodeFSP.utimes(`${legacyDbPath}-wal`, historicalSec, historicalSec);
          await NodeFSP.mkdir(path.join(acp, "annotations"), { recursive: true });
          await NodeFSP.writeFile(path.join(acp, "annotations", `${ROOT}.pbtxt`), "ann");
          const inbox = path.join(acp, "brain", ROOT, ".system_generated", "messages");
          await NodeFSP.mkdir(inbox, { recursive: true });
          await NodeFSP.writeFile(
            path.join(inbox, "wake.json"),
            JSON.stringify({ id: "wake-1", priority: "MESSAGE_PRIORITY_HIGH" }),
          );
        });

        expect(yield* fs.exists(`${legacyDbPath}-wal`)).toBe(true);
        const migrated = yield* migrateLegacyAntigravitySession({
          profileDirectory: profile,
          sessionId: ROOT,
          slotId,
        });
        expect(migrated).toBe(true);
        const profileRoot = yield* Effect.promise(() => antigravityProfileRoot(profile));
        expect(yield* Effect.promise(() => readAntigravitySessionSlotId(profileRoot!, ROOT))).toBe(
          slotId,
        );
        expect(yield* fs.exists(legacyDbPath)).toBe(false);
        expect(yield* fs.exists(`${legacyDbPath}-wal`)).toBe(false);
        expect(yield* fs.exists(seeded.transcriptPath)).toBe(false);

        const migratedSlotDir = path.join(profileRoot!, ANTIGRAVITY_SESSIONS_DIR, slotId);
        const migratedDbPath = path.join(migratedSlotDir, "conversations", `${ROOT}.db`);
        const migratedStat = yield* Effect.promise(() => NodeFSP.stat(migratedDbPath));
        expect(Math.trunc(migratedStat.mtimeMs / 1000)).toBe(historicalSec);
        expect(yield* fs.exists(path.join(migratedSlotDir, "annotations", `${ROOT}.pbtxt`))).toBe(
          true,
        );

        const [dbChild] = yield* readAntigravityChildWork({
          profileDirectory: profile,
          rootSessionId: ROOT,
          nativeTaskId: `${ROOT}:1`,
          launch: { title: null, prompt: "Readme check" },
          siblings: [],
        });
        expect(dbChild?.conversationId).toBe(CHILD);
        expect(dbChild?.steps?.at(-1)?.text).toBe("marker 4242 found");

        expect(
          yield* readAntigravityPendingReply({ profileDirectory: profile, sessionId: ROOT }),
        ).toBe(true);

        const outcomeCheck = yield* watchAntigravityPromptOutcome(profile, ROOT);
        yield* Effect.promise(async () => {
          const db = new NodeSqlite.DatabaseSync(migratedDbPath);
          try {
            db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(
              100,
              17,
              badGatewayError,
            );
          } finally {
            db.close();
          }
        });
        const failure = yield* outcomeCheck({ stopReason: "end_turn" });
        expect(failure?.failure.code).toBe("502 Bad Gateway");

        // 2. Separate realistic detached 1.5 legacy session (subagents/*.json + launch.json, no DB invoke row).
        const detachedDbPath = path.join(acp, "conversations", `${detachedRoot}.db`);
        const detachedTranscriptPath = path.join(
          acp,
          "brain",
          detachedChild,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        yield* Effect.promise(async () => {
          const db = new NodeSqlite.DatabaseSync(detachedDbPath);
          try {
            db.exec(
              "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_format INTEGER DEFAULT 0, step_payload BLOB, metadata BLOB)",
            );
            const usageMeta = new Uint8Array([
              0x4a,
              4,
              0x10,
              77,
              0x18,
              21,
              ...Buffer.from("420608a187b7d306", "hex"),
            ]);
            db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)").run(
              1,
              15,
              usageMeta,
            );
          } finally {
            db.close();
          }
          const subagentsDir = path.join(
            acp,
            "brain",
            detachedRoot,
            ".system_generated",
            "subagents",
          );
          const childMsgsDir = path.join(
            acp,
            "brain",
            detachedChild,
            ".system_generated",
            "messages",
          );
          await NodeFSP.mkdir(subagentsDir, { recursive: true });
          await NodeFSP.mkdir(childMsgsDir, { recursive: true });
          await NodeFSP.mkdir(path.dirname(detachedTranscriptPath), { recursive: true });
          await NodeFSP.writeFile(
            path.join(subagentsDir, `${detachedChild}.json`),
            JSON.stringify({
              conversationId: detachedChild,
              subagentDescriptor: { typeName: "research", role: "Detached Checker" },
              state: "SUBAGENT_STATE_ALIVE",
            }),
          );
          await NodeFSP.writeFile(
            path.join(childMsgsDir, "launch.json"),
            JSON.stringify({
              sender: detachedRoot,
              content: "Inspect detached marker",
              sourceMetadata: {
                tool: {
                  conversationId: detachedRoot,
                  stepIndex: 2,
                  toolCall: {
                    id: "call_detached_1",
                    name: "invoke_subagent",
                    argumentsJson: JSON.stringify({
                      TypeName: "research",
                      Role: "Detached Checker",
                      Prompt: "Inspect detached marker",
                    }),
                  },
                },
              },
            }),
          );
          await NodeFSP.writeFile(
            detachedTranscriptPath,
            `${JSON.stringify({
              step_index: 0,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "detached marker 9001",
            })}\n`,
          );
        });
        expect(
          yield* migrateLegacyAntigravitySession({
            profileDirectory: profile,
            sessionId: detachedRoot,
            slotId: detachedSlotId,
          }),
        ).toBe(true);
        expect(yield* fs.exists(detachedTranscriptPath)).toBe(false);
        const [detachedWork] = yield* readAntigravityChildWork({
          profileDirectory: profile,
          rootSessionId: detachedRoot,
          nativeTaskId: "call_detached_1",
          launch: { title: "Detached Checker", prompt: "Inspect detached marker" },
          siblings: [],
        });
        expect(detachedWork?.conversationId).toBe(detachedChild);
        expect(detachedWork?.steps?.at(-1)?.text).toBe("detached marker 9001");

        // Verify AntigravityUsage aggregates both migrated slots under ONE scan rooted at sessions/.
        const scans = yield* usage.scan({
          instances: [
            {
              instanceId,
              config: AntigravityDriver.defaultConfig(),
              environment: {},
              configured: true,
            },
          ],
          windowStartMs: 0,
        });
        const sessionScans = scans.filter((entry) =>
          entry.dir.includes(`${path.sep}${ANTIGRAVITY_SESSIONS_DIR}`),
        );
        expect(sessionScans).toHaveLength(1);
        expect(sessionScans[0]?.dir.endsWith(`${path.sep}${ANTIGRAVITY_SESSIONS_DIR}`)).toBe(true);
        expect(sessionScans[0]?.status).toBe("ok");
        expect(sessionScans[0]?.files).toHaveLength(2);
        expect(sessionScans[0]?.files?.reduce((sum, file) => sum + file.records.length, 0)).toBe(2);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "isolates concurrent driver sessions, migrates legacy sessions via openSession, cleans failed 1.4.5 slots, and sweeps auth on driver logout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const nodePath = yield* HostProcess.ExecutablePath;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-driver-iso-" });
        const instanceId = ProviderInstanceId.make(path.basename(root));
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        const logPath = path.join(root, "rpc.jsonl");
        const scriptGood = path.join(root, "agy-good.cjs");
        const scriptOld = path.join(root, "agy-old.cjs");
        yield* fs.writeFileString(scriptGood, makeFakeAgyScript({ logPath, version: "1.5.18" }));
        yield* fs.writeFileString(scriptOld, makeFakeAgyScript({ logPath, version: "1.4.5" }));

        let selectedScript = scriptGood;
        let selectedVersion = "1.5.18";
        const driver = yield* AntigravityDriver.create({
          instanceId,
          displayName: "Isolation Test",
          enabled: true,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provide(
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: root,
              compatibility: (version) =>
                Effect.succeed(
                  version === "1.4.5"
                    ? {
                        status: "broken",
                        message: "Update Antigravity",
                        recommendedVersion: "1.5.0",
                        recommendedRange: null,
                      }
                    : undefined,
                ),
              resolve: () =>
                Effect.succeed({
                  executablePath: nodePath,
                  source: "path" as const,
                  version: selectedVersion,
                  managedVersionDirectory: null,
                }),
              acquire: () =>
                Effect.succeed({
                  executablePath: selectedScript,
                  source: "path" as const,
                  version: selectedVersion,
                  managedVersionDirectory: null,
                }),
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (command._tag !== "StandardCommand") return Effect.die("unexpected");
              if (command.command === nodePath) return spawner.spawn(command);
              return spawner.spawn({
                ...command,
                command: nodePath,
                args: [command.command, ...command.args],
              });
            }),
          ),
        );

        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-ws-" });
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;

        // Open two concurrent sessions and assert distinct slots + slot index entries.
        const [threadA, threadB] = yield* Effect.scoped(
          Effect.gen(function* () {
            const [s1, s2] = yield* Effect.all(
              [
                driver.orchestrationAdapter.openSession({
                  threadId: ThreadId.make("thread-a"),
                  providerSessionId: ProviderSessionId.make("ps-a"),
                  modelSelection,
                  runtimePolicy: policy,
                }),
                driver.orchestrationAdapter.openSession({
                  threadId: ThreadId.make("thread-b"),
                  providerSessionId: ProviderSessionId.make("ps-b"),
                  modelSelection,
                  runtimePolicy: policy,
                }),
              ],
              { concurrency: "unbounded" },
            );
            const t1 = yield* s1.ensureThread({
              threadId: ThreadId.make("thread-a"),
              modelSelection,
              runtimePolicy: policy,
            });
            const t2 = yield* s2.ensureThread({
              threadId: ThreadId.make("thread-b"),
              modelSelection,
              runtimePolicy: policy,
            });
            return [t1, t2] as const;
          }),
        );
        const sessionA = threadA.nativeThreadRef?.nativeId ?? null;
        const sessionB = threadB.nativeThreadRef?.nativeId ?? null;
        if (sessionA === null || sessionB === null) {
          throw new Error("Expected native thread IDs.");
        }
        expect(sessionA).not.toBe(sessionB);
        const profileRoot = (yield* Effect.promise(() =>
          antigravityProfileRoot(directories.profile),
        ))!;
        const slotA = yield* Effect.promise(() =>
          readAntigravitySessionSlotId(profileRoot, sessionA),
        );
        const slotB = yield* Effect.promise(() =>
          readAntigravitySessionSlotId(profileRoot, sessionB),
        );
        expect(slotA).toBeDefined();
        expect(slotB).toBeDefined();
        expect(slotA).not.toBe(slotB);
        const newSessionCalls = (yield* fs.readFileString(logPath))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { method: string; sessionId?: string; appDataDir: string },
          )
          .filter((call) => call.method === "session/new");
        expect(newSessionCalls.find((call) => call.sessionId === sessionA)?.appDataDir).toBe(
          `sessions/${slotA}`,
        );
        expect(newSessionCalls.find((call) => call.sessionId === sessionB)?.appDataDir).toBe(
          `sessions/${slotB}`,
        );

        // Resuming sessionA reuses slotA and supports warm session/load for readThreadSnapshot.
        const snapshotText = yield* Effect.scoped(
          Effect.gen(function* () {
            const resumed = yield* driver.orchestrationAdapter.openSession({
              threadId: ThreadId.make("thread-a"),
              providerSessionId: ProviderSessionId.make("ps-a-resume"),
              modelSelection,
              runtimePolicy: policy,
              initialNativeThreadId: sessionA,
            });
            const snap = yield* resumed.readThreadSnapshot({
              providerThread: {
                ...threadA,
                providerSessionId: ProviderSessionId.make("ps-a-resume"),
                status: "idle",
              },
            });
            return snap.messages.map((message) => message.text);
          }),
        );
        expect(snapshotText).toEqual(["replayed-history"]);
        const callsAfterResume = (yield* fs.readFileString(logPath))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string; appDataDir: string });
        const resumeCall = callsAfterResume.find((call) => call.method === "session/resume");
        expect(resumeCall?.appDataDir).toBe(`sessions/${slotA}`);

        // Opening an unmigrated legacy session through the real driver entrypoint migrates it.
        const legacyId = "66666666-6666-4666-8666-666666666666";
        const legacyConvDir = path.join(profileRoot, "antigravity-acp", "conversations");
        yield* fs.makeDirectory(legacyConvDir, { recursive: true });
        yield* Effect.promise(async () => {
          const db = new NodeSqlite.DatabaseSync(path.join(legacyConvDir, `${legacyId}.db`));
          try {
            db.exec(
              "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_format INTEGER NOT NULL DEFAULT 0, step_payload BLOB NOT NULL)",
            );
          } finally {
            db.close();
          }
        });
        yield* Effect.scoped(
          driver.orchestrationAdapter.openSession({
            threadId: ThreadId.make("thread-legacy"),
            providerSessionId: ProviderSessionId.make("ps-legacy"),
            modelSelection,
            runtimePolicy: policy,
            initialNativeThreadId: legacyId,
          }),
        );
        const migratedLegacySlot = yield* Effect.promise(() =>
          readAntigravitySessionSlotId(profileRoot, legacyId),
        );
        expect(migratedLegacySlot).toBeDefined();
        expect(yield* fs.exists(path.join(legacyConvDir, `${legacyId}.db`))).toBe(false);
        expect(
          yield* fs.exists(
            path.join(
              profileRoot,
              ANTIGRAVITY_SESSIONS_DIR,
              migratedLegacySlot!,
              "conversations",
              `${legacyId}.db`,
            ),
          ),
        ).toBe(true);

        // A rejected 1.4.5 startup must clean up the unbound slot directory.
        const slotsBeforeFailed = yield* fs.readDirectory(
          path.join(profileRoot, ANTIGRAVITY_SESSIONS_DIR),
        );
        selectedScript = scriptOld;
        selectedVersion = "1.4.5";
        const failed = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* driver.orchestrationAdapter.openSession({
              threadId: ThreadId.make("thread-old"),
              providerSessionId: ProviderSessionId.make("ps-old"),
              modelSelection,
              runtimePolicy: policy,
            });
            yield* session.ensureThread({
              threadId: ThreadId.make("thread-old"),
              modelSelection,
              runtimePolicy: policy,
            });
          }),
        ).pipe(Effect.flip);
        expect(failed).toMatchObject({ driver: "antigravity" });
        const slotsAfterFailed = yield* fs.readDirectory(
          path.join(profileRoot, ANTIGRAVITY_SESSIONS_DIR),
        );
        expect(slotsAfterFailed.sort()).toEqual(slotsBeforeFailed.sort());

        // Real driver.auth.logout sweeps auth tokens across sessions and disposables while keeping slot index.
        selectedScript = scriptGood;
        selectedVersion = "1.5.18";
        yield* fs.makeDirectory(path.join(profileRoot, ANTIGRAVITY_DISPOSABLE_DIR, "slot-d"), {
          recursive: true,
        });
        yield* fs.makeDirectory(
          path.join(profileRoot, `${ANTIGRAVITY_DISPOSABLE_DIR}.old-retired`, "runtime", "slot-r"),
          { recursive: true },
        );
        yield* fs.writeFileString(
          path.join(profileRoot, ANTIGRAVITY_SESSIONS_DIR, slotA!, "antigravity-oauth-token"),
          "secret",
        );
        yield* fs.writeFileString(
          path.join(profileRoot, ANTIGRAVITY_DISPOSABLE_DIR, "slot-d", "acp_token.json"),
          "secret",
        );
        yield* fs.writeFileString(
          path.join(
            profileRoot,
            `${ANTIGRAVITY_DISPOSABLE_DIR}.old-retired`,
            "runtime",
            "slot-r",
            "acp_token.json",
          ),
          "secret",
        );
        yield* driver.auth!.logout(Effect.void);
        expect(
          yield* fs.exists(
            path.join(profileRoot, ANTIGRAVITY_SESSIONS_DIR, slotA!, "antigravity-oauth-token"),
          ),
        ).toBe(false);
        expect(
          yield* fs.exists(
            path.join(profileRoot, ANTIGRAVITY_DISPOSABLE_DIR, "slot-d", "acp_token.json"),
          ),
        ).toBe(false);
        expect(
          yield* fs.exists(
            path.join(
              profileRoot,
              `${ANTIGRAVITY_DISPOSABLE_DIR}.old-retired`,
              "runtime",
              "slot-r",
              "acp_token.json",
            ),
          ),
        ).toBe(false);
        expect(
          yield* fs.exists(path.join(profileRoot, ANTIGRAVITY_SESSION_SLOTS_DIR, sessionA)),
        ).toBe(true);
      }),
  );

  it.effect(
    "disables native fork, isolates live switches, preserves post-crash load-only replay, and guards snapshot reads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const random = yield* SecureRandom.SecureRandom;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const selfInvocation = yield* resolveSelfInvocation();
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-adapter-iso-" });
        const logPath = path.join(root, "rpc.jsonl");
        const scriptPath = path.join(root, "agy.cjs");
        const scriptNoLoadPath = path.join(root, "agy-noload.cjs");
        const scriptLoadOnlyPath = path.join(root, "agy-loadonly.cjs");
        yield* fs.writeFileString(scriptPath, makeFakeAgyScript({ logPath, version: "1.5.18" }));
        yield* fs.writeFileString(
          scriptNoLoadPath,
          makeFakeAgyScript({ logPath, version: "1.5.18", loadSession: false }),
        );
        yield* fs.writeFileString(
          scriptLoadOnlyPath,
          makeFakeAgyScript({ logPath, version: "1.5.18", loadSession: true, resume: false }),
        );

        const spawns: Array<{ readonly cwd: string; readonly resumeSessionId?: string }> = [];
        let terminateCurrent:
          | ((error: EffectAcpErrors.AcpError) => Effect.Effect<void>)
          | undefined;
        const makeAdapter = (script: string) =>
          makeAntigravityAdapterV2({
            instanceId: ProviderInstanceId.make("antigravity-adapter-iso"),
            selfInvocation,
            withProcess: (_stop, task) => task,
            defaultModel: Effect.undefined,
            makeRuntime: (input) =>
              Effect.gen(function* () {
                spawns.push({
                  cwd: input.cwd,
                  ...(input.resumeSessionId === undefined
                    ? {}
                    : { resumeSessionId: input.resumeSessionId }),
                });
                terminateCurrent = input.onTermination;
                return yield* makeAntigravityAcpRuntime({
                  ...input,
                  childProcessSpawner,
                  spawn: {
                    command: process.execPath,
                    args: [script],
                    cwd: input.cwd,
                  },
                }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
              }),
          });

        const ws1 = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-ws1-" });
        const ws2 = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-ws2-" });
        const policy1 = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: ws1,
        });
        const policy2 = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: ws2,
        });
        const modelSelection = {
          instanceId: ProviderInstanceId.make("antigravity-adapter-iso"),
          model: "gemini-test-low",
        } as const;
        const threadId = ThreadId.make("thread-adapter-iso");

        const adapter = yield* makeAdapter(scriptPath);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("ps-adapter-iso"),
              modelSelection,
              runtimePolicy: policy1,
            });
            expect(session.providerSession.capabilities.threads.canForkThread).toBe(false);
            const firstThread = yield* session.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: policy1,
            });
            const firstId = firstThread.nativeThreadRef!.nativeId!;

            // Fork is rejected before spawning any replacement runtime.
            const forkErr = yield* session
              .forkThread({
                sourceProviderThread: firstThread,
                sourceProviderTurns: [],
                targetThreadId: ThreadId.make("thread-fork"),
                modelSelection,
                runtimePolicy: policy1,
              })
              .pipe(Effect.flip);
            expect(forkErr._tag).toBe("ProviderAdapterForkThreadError");
            expect(spawns).toHaveLength(1);

            // forceNewNativeThread updates latestRuntimePolicy and spawns in ws2 without triggering loadSession on snapshot read.
            const replaced = yield* session.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: policy2,
              existingProviderThread: firstThread,
              forceNewNativeThread: true,
            });
            const secondId = replaced.nativeThreadRef!.nativeId!;
            expect(secondId).not.toBe(firstId);
            expect(spawns).toHaveLength(2);
            expect(spawns[1]).toEqual({ cwd: ws2 });
            const emptySnap = yield* session.readThreadSnapshot({ providerThread: replaced });
            expect(emptySnap.messages).toEqual([]);
            const loadCallsBeforeSwitch = (yield* fs.readFileString(logPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { method: string })
              .filter((call) => call.method === "session/load");
            expect(loadCallsBeforeSwitch).toHaveLength(0);

            // Live session switch (without crash/termination) replaces runtime via startReplacementAcpRuntime.
            yield* session.resumeThread({
              providerThread: firstThread,
              modelSelection,
              runtimePolicy: policy1,
            });
            expect(spawns).toHaveLength(3);
            expect(spawns[2]).toEqual({ cwd: ws1, resumeSessionId: firstId });

            // After crash/termination, resumeThread restarts with updated policy cwd.
            yield* terminateCurrent!(
              new EffectAcpErrors.AcpTransportError({ detail: "crashed", cause: undefined }),
            );
            yield* session.resumeThread({
              providerThread: replaced,
              modelSelection,
              runtimePolicy: policy2,
            });
            expect(spawns).toHaveLength(4);
            expect(spawns[3]).toEqual({ cwd: ws2, resumeSessionId: secondId });
          }),
        );

        // Post-crash readThreadSnapshot on a load-only peer must preserve replayed history instead of wiping it.
        const loadOnlyAdapter = yield* makeAdapter(scriptLoadOnlyPath);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* loadOnlyAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("ps-adapter-loadonly"),
              modelSelection,
              runtimePolicy: policy1,
            });
            const thread = yield* session.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: policy1,
            });
            yield* terminateCurrent!(
              new EffectAcpErrors.AcpTransportError({ detail: "crashed", cause: undefined }),
            );
            const snap = yield* session.readThreadSnapshot({ providerThread: thread });
            expect(snap.messages.map((message) => message.text)).toEqual(["replayed-history"]);
          }),
        );

        // When loadSession is unsupported, readThreadSnapshot for another session rejects without replacing the live runtime.
        const spawnsBeforeNoLoad = spawns.length;
        const noLoadAdapter = yield* makeAdapter(scriptNoLoadPath);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* noLoadAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("ps-adapter-noload"),
              modelSelection,
              runtimePolicy: policy1,
            });
            const thread = yield* session.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: policy1,
            });
            expect(spawns).toHaveLength(spawnsBeforeNoLoad + 1);
            const snapErr = yield* session
              .readThreadSnapshot({
                providerThread: {
                  ...thread,
                  nativeThreadRef: {
                    ...thread.nativeThreadRef!,
                    nativeId: "77777777-7777-4777-8777-777777777777",
                  },
                },
              })
              .pipe(Effect.flip);
            expect(snapErr._tag).toBe("ProviderAdapterReadThreadSnapshotError");
            expect(spawns).toHaveLength(spawnsBeforeNoLoad + 1);
          }),
        );
      }),
  );
});
