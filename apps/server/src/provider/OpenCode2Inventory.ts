import type { OpenCodeClient } from "@opencode/client";
import type {
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Native from "./OpenCode2Client.ts";
import { COMPACT_SLASH_COMMAND } from "./providerSnapshot.ts";

export const load = Effect.fn("OpenCode2Inventory.load")(function* (
  client: OpenCodeClient,
  directory: string,
) {
  const location = { directory };
  // Catalog reads expose registrations so far, not a plugin-readiness barrier.
  // A non-running admission waits for location plugins without calling a model.
  // Remove only this probe session; never reload an externally owned server.
  const probe = yield* Effect.acquireRelease(
    Native.request("session.create", (signal) =>
      client.session.create(
        {
          location,
          title: "T3 Code catalog probe",
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
        { signal },
      ),
    ),
    (session) =>
      Native.request("session.remove", (signal) =>
        client.session.remove({ sessionID: session.id }, { signal }),
      ).pipe(Effect.ignore),
  );
  yield* Native.request("session.prompt", (signal) =>
    client.session.prompt(
      {
        sessionID: probe.id,
        text: "Initialize the model catalog. Do not run a model.",
        resume: false,
      },
      { signal },
    ),
  );
  const [models, agents, skills] = yield* Effect.all(
    [
      Native.request("model.list", (signal) => client.model.list({ location }, { signal })),
      Native.request("agent.list", (signal) => client.agent.list({ location }, { signal })),
      Native.request("skill.list", (signal) => client.skill.list({ location }, { signal })),
    ],
    { concurrency: "unbounded" },
  );
  const primaryAgents = agents.data.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  return {
    models: models.data
      .map((model): ServerProviderModel => ({
        slug: `${model.providerID}/${model.id}`,
        name: model.name,
        subProvider: model.providerID,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            ...(model.variants.length
              ? [
                  {
                    id: "variant",
                    label: "Reasoning",
                    type: "select" as const,
                    options: model.variants.map((variant) => ({
                      id: variant.id,
                      label: variant.id,
                    })),
                  },
                ]
              : []),
            ...(primaryAgents.length
              ? [
                  {
                    id: "agent",
                    label: "Agent",
                    type: "select" as const,
                    options: primaryAgents.map((agent) => ({ id: agent.id, label: agent.id })),
                  },
                ]
              : []),
          ],
        }),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    skills: skills.data.map((skill): ServerProviderSkill => ({
      name: skill.id,
      path: skill.path,
      ...(skill.description ? { description: skill.description } : {}),
      enabled: true,
    })),
    slashCommands: [COMPACT_SLASH_COMMAND] satisfies ServerProviderSlashCommand[],
    connectedCount: new Set(models.data.map((model) => model.providerID)).size,
  };
}, Effect.scoped);
