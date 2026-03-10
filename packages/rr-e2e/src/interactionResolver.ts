import { matchesPartial, readScopedTemplatePath, resolveTemplate } from "./template.ts";
import type {
  ReplayFixture,
  ReplayInteraction,
  ReplayScopes,
  ResolvedInteraction,
} from "./types.ts";

function findMatchingInteraction(
  interactions: ReadonlyArray<ReplayInteraction>,
  service: string,
  request: unknown,
  state: Record<string, unknown>,
): ReplayInteraction | null {
  for (const interaction of interactions) {
    if (interaction.service !== service) {
      continue;
    }
    const scopes = { request, state };
    if (!matchesPartial(request, resolveTemplate(interaction.match ?? {}, scopes))) {
      continue;
    }
    if (!matchesPartial(state, resolveTemplate(interaction.whenState ?? {}, scopes))) {
      continue;
    }
    return interaction;
  }
  return null;
}

function applyInteractionState(interaction: ReplayInteraction, scopes: ReplayScopes): void {
  for (const [key, pathExpression] of Object.entries(interaction.capture ?? {})) {
    scopes.state[key] = readScopedTemplatePath(pathExpression, scopes);
  }
  for (const [key, value] of Object.entries(interaction.setState ?? {})) {
    scopes.state[key] = resolveTemplate(value, scopes);
  }
}

export function resolveInteraction<T>(
  fixture: ReplayFixture,
  service: string,
  request: unknown,
  state: Record<string, unknown>,
): ResolvedInteraction<T> {
  const interaction = findMatchingInteraction(fixture.interactions, service, request, state);
  if (!interaction) {
    throw new Error(`No replay interaction matched ${service}: ${JSON.stringify(request)}.`);
  }

  const scopes = { request, state };
  applyInteractionState(interaction, scopes);
  if (interaction.error) {
    throw new Error(interaction.error.message);
  }

  return {
    interaction,
    result: resolveTemplate(interaction.result, scopes) as T,
    notifications: resolveTemplate(
      interaction.notifications ?? [],
      scopes,
    ) as ReadonlyArray<unknown>,
  };
}
