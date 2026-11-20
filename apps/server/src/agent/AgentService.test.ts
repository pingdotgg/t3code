import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentDefinition,
  AgentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { getAgentDefinition, listAgentSummaries, resolveModelForAgent } from "./AgentService.ts";

/** An agent file: frontmatter lines, then the body that becomes its instructions. */
const agentFile = (frontmatter: ReadonlyArray<string>, body: string) =>
  ["---", ...frontmatter, "---", "", body].join("\n");

const writeFiles = Effect.fn("writeFiles")(function* (root: string, files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
});

const decodeAgentDefinition = Schema.decodeUnknownSync(AgentDefinition);

const definition = (fields: Record<string, unknown>) =>
  decodeAgentDefinition({
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews diffs.",
    instructions: "Review the diff.",
    ...fields,
  });

const provider = (
  instanceId: string,
  driver: string,
  slugs: ReadonlyArray<string>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

it.layer(NodeServices.layer)("agent discovery", (it) => {
  it.effect("discovers agents from every agent location and AGENTS.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-locations-" });
      yield* writeFiles(root, {
        ".agents/planner.agent.md": agentFile(
          ["id: planner", "name: Planner", "description: Plans work."],
          "Plan it.",
        ),
        ".agents/reviewer.md": agentFile(
          ["id: reviewer", "name: Reviewer", "description: Reviews work."],
          "Review it.",
        ),
        ".github/agents/tester.agent.md": agentFile(
          ["id: tester", "name: Tester", "description: Tests work."],
          "Test it.",
        ),
        ".github/agents/docs.md": agentFile(
          ["id: docs", "name: Docs", "description: Writes docs."],
          "Document it.",
        ),
        "AGENTS.md": agentFile(
          ["id: coordinator", "name: Coordinator", "description: Coordinates work."],
          "Coordinate it.",
        ),
      });

      const agents = yield* listAgentSummaries(root);

      assert.deepEqual(agents.map((agent) => agent.id).toSorted(), [
        "coordinator",
        "docs",
        "planner",
        "reviewer",
        "tester",
      ]);
    }),
  );

  it.effect("parses every frontmatter field and keeps the body as instructions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-fields-" });
      yield* writeFiles(root, {
        ".agents/full.agent.md": agentFile(
          [
            "id: full",
            "name: Full agent",
            "description: Uses every field.",
            "model:",
            "  provider: claudeAgent",
            "  model: claude-haiku-4-5",
            "tier: economy",
            "tools:",
            "  allow: [read, search]",
            "  deny: [shell]",
            "canDelegateTo: [planner]",
          ],
          "Be exhaustive.\n\nKeep it short.",
        ),
      });

      const agent = Option.getOrUndefined(yield* getAgentDefinition(AgentId.make("full"), root));

      assert.deepEqual(agent, {
        id: AgentId.make("full"),
        name: "Full agent",
        description: "Uses every field.",
        model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
        tier: "economy",
        canDelegateTo: [AgentId.make("planner")],
        instructions: "Be exhaustive.\n\nKeep it short.",
      });
      assert.deepEqual(yield* listAgentSummaries(root), [
        {
          id: AgentId.make("full"),
          name: "Full agent",
          description: "Uses every field.",
          tier: "economy",
          model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
        },
      ]);
    }),
  );

  it.effect("leaves the tier unset and defaults delegation to empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-defaults-" });
      yield* writeFiles(root, {
        ".github/agents/minimal.agent.md": agentFile(
          ["id: minimal", "name: Minimal", "description: Bare minimum."],
          "Do the task.",
        ),
      });

      const agent = Option.getOrUndefined(yield* getAgentDefinition(AgentId.make("minimal"), root));

      assert.deepEqual(agent, {
        id: AgentId.make("minimal"),
        name: "Minimal",
        description: "Bare minimum.",
        canDelegateTo: [],
        instructions: "Do the task.",
      });
    }),
  );

  it.effect("skips guidance and invalid definitions without hiding valid agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-invalid-" });
      yield* writeFiles(root, {
        "AGENTS.md": "# Project guidance\n\nNo frontmatter here.",
        ".agents/notes.md": "Just notes.",
        ".agents/bad-id.agent.md": agentFile(
          ["id: Bad Id", "name: Bad id", "description: Not kebab case."],
          "Body.",
        ),
        ".agents/bad-tier.agent.md": agentFile(
          ["id: bad-tier", "name: Bad tier", "description: Unknown tier.", "tier: fast"],
          "Body.",
        ),
        ".agents/empty-body.agent.md": agentFile(
          ["id: empty-body", "name: Empty body", "description: No instructions."],
          "",
        ),
        ".agents/broken.agent.md": "---\nid: [unclosed\n---\n\nBody.",
        ".agents/valid.agent.md": agentFile(
          ["id: valid", "name: Valid", "description: Parses fine."],
          "Body.",
        ),
      });

      const agents = yield* listAgentSummaries(root);

      assert.deepEqual(
        agents.map((agent) => agent.id),
        ["valid"],
      );
    }),
  );

  it.effect("keeps the first definition when two locations define the same id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-duplicate-" });
      yield* writeFiles(root, {
        ".agents/reviewer.agent.md": agentFile(
          ["id: reviewer", "name: Local reviewer", "description: Local copy."],
          "Local.",
        ),
        "AGENTS.md": agentFile(
          ["id: reviewer", "name: Root reviewer", "description: Root copy."],
          "Root.",
        ),
      });

      const agent = Option.getOrUndefined(
        yield* getAgentDefinition(AgentId.make("reviewer"), root),
      );

      assert.equal(agent?.name, "Local reviewer");
      assert.lengthOf(yield* listAgentSummaries(root), 1);
    }),
  );

  it.effect("finds nothing without a workspace root, in an empty one, or for an unknown id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-none-" });
      const emptyRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agents-empty-" });
      yield* writeFiles(root, {
        ".agents/reviewer.agent.md": agentFile(
          ["id: reviewer", "name: Reviewer", "description: Reviews."],
          "Review.",
        ),
      });

      assert.deepEqual(yield* listAgentSummaries(null), []);
      assert.deepEqual(yield* listAgentSummaries(emptyRoot), []);
      assert.isTrue(Option.isNone(yield* getAgentDefinition(AgentId.make("reviewer"), null)));
      assert.isTrue(Option.isNone(yield* getAgentDefinition(AgentId.make("missing"), root)));
    }),
  );
});

describe("resolveModelForAgent", () => {
  const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-haiku-5-5"]);
  const codex = provider("codex", "codex", ["gpt-5.4"]);

  it("prefers an explicit model in the agent file over its tier", () => {
    const agent = definition({ tier: "economy", model: { provider: "codex", model: "gpt-5.4" } });

    assert.deepEqual(resolveModelForAgent(agent, [claude, codex]), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });
  });

  it("maps an explicit tier to the driver's available default model", () => {
    assert.deepEqual(resolveModelForAgent(definition({ tier: "economy" }), [claude]), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-5-5",
    });
    assert.deepEqual(resolveModelForAgent(definition({ tier: "reasoning" }), [claude]), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    });
    assert.isUndefined(resolveModelForAgent(definition({}), [claude]));
  });

  it("picks from the first provider that advertises the tier model", () => {
    assert.deepEqual(resolveModelForAgent(definition({ tier: "economy" }), [codex, claude]), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-5-5",
    });
  });

  it("returns nothing when no provider advertises the tier model", () => {
    assert.isUndefined(resolveModelForAgent(definition({ tier: "economy" }), [codex]));
  });

  it("prefers the current provider instance when it offers the tier model", () => {
    const firstClaude = provider("claude-first", "claudeAgent", ["claude-haiku-5-5"]);
    const currentClaude = provider("claude-current", "claudeAgent", ["claude-haiku-5-5"]);

    assert.deepEqual(
      resolveModelForAgent(
        definition({ tier: "economy" }),
        [firstClaude, currentClaude],
        currentClaude.instanceId,
      ),
      { instanceId: currentClaude.instanceId, model: "claude-haiku-5-5" },
    );
  });

  it("skips providers that are disabled, unavailable, or missing the fixed model", () => {
    const disabled = { ...codex, enabled: false };
    const unavailable = { ...claude, availability: "unavailable" as const };
    assert.isUndefined(
      resolveModelForAgent(
        definition({ model: { instanceId: codex.instanceId, model: "gpt-5.4" } }),
        [disabled],
      ),
    );
    assert.isUndefined(resolveModelForAgent(definition({ tier: "economy" }), [unavailable]));
  });
});
