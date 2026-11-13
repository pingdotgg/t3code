/**
 * Applies OpenCode 2 session configuration: permission rules, titles, MCP servers, instructions.
 */
import { Session } from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  INSTRUCTIONS_KEY,
  INVENTORY_TIMEOUT,
  agentPaths,
  sameRules,
  sessionRules,
} from "./protocol.ts";
import type { Rule, RulesPolicy, ThreadState } from "./types.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeConfig = (
  deps: State & Projections,
) => {
  const {
    host,
    live,
    mcpServerNameFor,
    mcpSessions,
    readModels,
    rootOf,
  } = deps;

  const agentRules = new Map<string, ReadonlyMap<string, ReadonlyArray<Rule>>>();
  const pathsFor = Effect.fnUntraced(function* (
    directory: string,
    agents: ReadonlyArray<string>,
  ) {
    let known = agentRules.get(directory);
    if (known === undefined) {
      // A fresh server lists no agents for its first moments, like its models.
      const listed = yield* live.client.agent.list({ location: { directory } }).pipe(
        Effect.repeat({
          until: (list) => list.data.length > 0,
          schedule: Schedule.spaced("250 millis"),
        }),
        Effect.timeout("5 seconds"),
        Effect.tapCause((cause) =>
          Effect.logWarning(
            "Could not list OpenCode agents; their path rules are skipped.",
            cause,
          ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
        ),
        Effect.option,
      );
      if (listed._tag === "None") return [];
      known = new Map(
        listed.value.data.map((agent) => [agent.id, agentPaths(agent.permissions)]),
      );
      agentRules.set(directory, known);
    }
    const paths = new Map<string, Rule>();
    for (const agent of agents) {
      for (const entry of known.get(agent) ?? []) {
        paths.set(`${entry.action}\u0000${entry.resource}`, entry);
      }
    }
    return [...paths.values()];
  });

  const rulesFor = Effect.fnUntraced(function* (
    thread: Pick<ThreadState, "directory" | "agent" | "grants">,
    policy: RulesPolicy,
    appThreadId: string | null,
  ) {
    const plan = policy.interactionMode === "plan";
    const paths =
      policy.runtimeMode === "full-access" && !plan
        ? []
        : yield* pathsFor(thread.directory, plan ? [thread.agent, "plan"] : [thread.agent]);
    return sessionRules(
      policy,
      paths,
      policy.runtimeMode === "full-access" ? [] : thread.grants,
      appThreadId === null ? null : yield* mcpServerNameFor(appThreadId),
    );
  });

  const writeRules = Effect.fnUntraced(function* (state: ThreadState, policy: RulesPolicy) {
    const rules = yield* rulesFor(state, policy, rootOf(state).providerThread.appThreadId);
    if (!sameRules(state.rules, rules)) {
      yield* live.client.session.update({
        sessionID: Session.ID.make(state.sessionId),
        permissions: rules,
      });
      state.rules = rules;
    }
    state.policy = policy;
  });

  const writeTitle = Effect.fnUntraced(function* (state: ThreadState, title: string) {
    const next = title.trim();
    // An empty title asks OpenCode to generate one.
    if (next === "" || next === state.title) return;
    yield* live.client.session.update({ sessionID: Session.ID.make(state.sessionId), title: next });
    state.title = next;
  });

  const removeMcp = (mcp: { readonly name: string; readonly directory: string }) =>
    Effect.suspend(() =>
      live.client.mcp.remove({ server: mcp.name, location: { directory: mcp.directory } }),
    ).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true }));

  const prepareTurn = Effect.fnUntraced(function* (
    sessionId: string,
    state: ThreadState,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    const mcpSession = yield* mcpSessions.read(turnInput.threadId);
    const directory = turnInput.runtimePolicy.cwd ?? host.paths.cwd;
    const name = yield* mcpServerNameFor(turnInput.threadId);
    // An external server may not reach T3's MCP endpoint, as with 1.x.
    const wanted =
      mcpSession === undefined || live.connection.external
        ? undefined
        : { name, directory, credential: mcpSession.authorizationHeader };
    if (
      state.mcp !== undefined &&
      (wanted === undefined ||
        state.mcp.directory !== wanted.directory ||
        state.mcp.credential !== wanted.credential)
    ) {
      yield* removeMcp(state.mcp);
      state.mcp = undefined;
    }
    // Idle Location eviction drops runtime MCP servers without clearing T3's cache.
    // Re-adding an unchanged config keeps its existing connection.
    let mcpAvailable = false;
    if (wanted !== undefined) {
      mcpAvailable = yield* live.client.mcp
        .add({
          server: name,
          location: { directory },
          config: new Mcp.RemoteConfig({
            type: "remote",
            url: mcpSession!.endpoint,
            headers: { Authorization: wanted.credential },
            oauth: false,
          }),
        })
        .pipe(
          Effect.timeout(INVENTORY_TIMEOUT),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not add T3 Code's MCP server to OpenCode.", cause).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (mcpAvailable) state.mcp = wanted;
    }
    const instructions = [
      buildRuntimeInstructions({ harness: "OpenCode", model: turnInput.modelSelection.model }),
      t3OrchestrationSystemPrompt(mcpAvailable, mcpSession?.capabilities?.has("device") === true),
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join("\n\n");
    if (instructions !== state.instructions) {
      yield* live.client.session.instructions.entry.put({
        sessionID: Session.ID.make(sessionId),
        key: INSTRUCTIONS_KEY,
        value: instructions,
      });
      state.instructions = instructions;
    }
  });

  const listSkills = (location: { readonly directory: string }) =>
    live.client.skill.list({ location }).pipe(
      Effect.timeout(INVENTORY_TIMEOUT),
      Effect.map((list) => new Set<string>(list.data.map((skill) => skill.id))),
      Effect.orElseSucceed(() => new Set<string>()),
    );

  // A directory OpenCode is still scanning lists none or some of its skills.
  // OpenCode 2.2.5 answers its model list only once the scan has ended (observed, not documented).
  const skillsMentioned = Effect.fnUntraced(function* (
    location: { readonly directory: string },
    mentions: ReadonlyArray<string>,
  ) {
    const known = yield* listSkills(location);
    if (mentions.some((name) => !known.has(name))) {
      yield* readModels(location.directory);
      for (const name of yield* listSkills(location)) known.add(name);
    }
    return mentions.filter((name) => known.has(name));
  });

  return {
    agentRules,
    pathsFor,
    rulesFor,
    writeRules,
    writeTitle,
    removeMcp,
    prepareTurn,
    listSkills,
    skillsMentioned,
  };
};

export type Config = ReturnType<typeof makeConfig>;
