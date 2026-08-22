// @effect-diagnostics nodeBuiltinImport:off - exercises generated artifacts in temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  computeCorpusManifest,
  generatePublicCorpus,
  readCorpusGeneratorConfig,
  serializeCorpus,
  validateCorpusIntegrity,
} from "./corpus.ts";

const configPath = NodePath.resolve(
  import.meta.dirname,
  "../../../benchmarks/agent-app/corpora/core-v1.json",
);

describe("public agent-app corpus", () => {
  it("generates byte-identical artifacts and the committed manifest from one seed", async () => {
    const config = await readCorpusGeneratorConfig(configPath);
    const first = generatePublicCorpus(config);
    const second = generatePublicCorpus(config);
    assert.equal(serializeCorpus(first), serializeCorpus(second));
    assert.deepStrictEqual(first.manifest, config.expectedManifest);
    assert.deepStrictEqual(validateCorpusIntegrity(first), first.manifest);
  });

  it("changes semantic counts and hashes when content is dropped, reordered, or rewritten", async () => {
    const config = await readCorpusGeneratorConfig(configPath);
    const corpus = generatePublicCorpus(config);
    const session = corpus.sessions[0];
    assert(session);

    const dropped = {
      ...corpus,
      sessions: corpus.sessions.map((entry, sessionIndex) =>
        sessionIndex !== 0
          ? entry
          : {
              ...entry,
              turns: entry.turns.map((turn, turnIndex) =>
                turnIndex !== 0
                  ? turn
                  : {
                      ...turn,
                      messages: turn.messages.map((message, messageIndex) =>
                        messageIndex !== 1
                          ? message
                          : { ...message, parts: message.parts.slice(0, -1) },
                      ),
                    },
              ),
            },
      ),
    };

    const reordered = {
      ...corpus,
      sessions: corpus.sessions.map((entry, index) =>
        index === 0 ? { ...entry, turns: entry.turns.toReversed() } : entry,
      ),
    };

    const rewritten = {
      ...corpus,
      sessions: corpus.sessions.map((entry, sessionIndex) =>
        sessionIndex !== 0
          ? entry
          : {
              ...entry,
              turns: entry.turns.map((turn, turnIndex) =>
                turnIndex !== 0
                  ? turn
                  : {
                      ...turn,
                      messages: turn.messages.map((message, messageIndex) =>
                        messageIndex !== 0
                          ? message
                          : {
                              ...message,
                              parts: message.parts.map((part, partIndex) =>
                                partIndex === 0 && part.type === "text"
                                  ? { ...part, text: `${part.text} changed` }
                                  : part,
                              ),
                            },
                      ),
                    },
              ),
            },
      ),
    };

    for (const changed of [dropped, reordered, rewritten]) {
      const changedManifest = computeCorpusManifest({ ...changed, manifest: undefined });
      assert.notEqual(changedManifest.hashes.semanticSha256, corpus.manifest.hashes.semanticSha256);
    }
    assert.notDeepEqual(
      computeCorpusManifest({ ...dropped, manifest: undefined }).counts,
      corpus.manifest.counts,
    );
  });

  it("rejects malformed generator JSON", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-corpus-test-"));
    const path = NodePath.join(directory, "bad.json");
    await NodeFSP.writeFile(path, "{ definitely not JSON", "utf8");
    await expect(readCorpusGeneratorConfig(path)).rejects.toThrow(
      /invalid corpus generator JSON/iu,
    );
    await NodeFSP.rm(directory, { recursive: true });
  });
});
