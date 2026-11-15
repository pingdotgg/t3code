import {
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { PSTACK_PANEL_ROLES, type PstackRoleDefault } from "@t3tools/pstack";
import {
  delegationProviderConstraints,
  invalidOptionSelections,
  isCapabilityModelVisible,
} from "../provider/orchestrationTargets.ts";

interface Entry {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly error?: string;
}
type Seat =
  | { readonly kind: "inherit" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "target"; readonly target: Entry };
type ParsedSeat =
  | { readonly kind: "inherit" }
  | { readonly kind: "entry"; readonly entry: Entry }
  | { readonly kind: "unresolved"; readonly model: string; readonly reason: string };

export function parseModelsFile(text: string) {
  const lines = new Map<string, ReadonlyArray<ParsedSeat>>();
  const diagnostics: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      diagnostics.push(`Models line ${index + 1}: expected role: value.`);
      continue;
    }
    const role = line.slice(0, colon).trim();
    if (lines.has(role))
      diagnostics.push(`Models line ${index + 1}: duplicate role ${role}; using the last value.`);
    const values = line
      .slice(colon + 1)
      .split(",")
      .filter((value) => value.trim().length > 0);
    if (values.length === 0) {
      diagnostics.push(`Models line ${index + 1}: empty role ${role}; using defaults.`);
      lines.delete(role);
      continue;
    }
    lines.set(
      role,
      values.map((value): ParsedSeat => {
        const trimmed = value.trim();
        if (trimmed === "inherit-parent" || trimmed === "auto") return { kind: "inherit" };
        const [target = "", ...tokens] = trimmed.split(/\s+/);
        const slash = target.indexOf("/");
        const options: ProviderOptionSelection[] = [];
        let error =
          slash <= 0 || slash === target.length - 1 ? "expected instance/model" : undefined;
        for (const token of tokens) {
          const equal = token.indexOf("=");
          if (equal <= 0 || equal === token.length - 1) {
            error = "expected option=value";
            continue;
          }
          const value = token.slice(equal + 1);
          options.push({
            id: token.slice(0, equal),
            value,
          });
        }
        return {
          kind: "entry",
          entry: {
            providerInstanceId: slash < 0 ? target : target.slice(0, slash),
            model: slash < 0 ? "" : target.slice(slash + 1),
            options,
            ...(error === undefined ? {} : { error }),
          },
        };
      }),
    );
  }
  return { lines, diagnostics };
}

const effortLadder = ["low", "medium", "high", "xhigh", "max"];
// Omitted speed follows T3's normal inheritance/default rules.
const speedOptionIds = new Set(["fastMode", "serviceTier"]);

function resolveOptions(
  requested: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
) {
  const selections = requested.map((selection) => {
    const descriptor = descriptors.find((descriptor) => descriptor.id === selection.id);
    return descriptor?.type === "boolean" &&
      (selection.value === "true" || selection.value === "false")
      ? { id: selection.id, value: selection.value === "true" }
      : selection;
  });
  const problems = [...invalidOptionSelections(selections, descriptors)];
  const options: ProviderOptionSelection[] = [];
  for (const descriptor of descriptors) {
    if (
      speedOptionIds.has(descriptor.id) &&
      !selections.some((option) => option.id === descriptor.id)
    )
      continue;
    const value =
      selections.find((option) => option.id === descriptor.id)?.value ??
      getProviderOptionCurrentValue(descriptor) ??
      (descriptor.type === "boolean" ? false : undefined);
    if (value === undefined) problems.push(`option ${descriptor.id} has no current value`);
    else options.push({ id: descriptor.id, value });
  }
  problems.push(...invalidOptionSelections(options, descriptors));
  return { options, problems };
}

function defaultSeat(
  slug: string,
  providers: ReadonlyArray<ServerProvider>,
  constraintsFor: (provider: ServerProvider) => ReadonlyArray<string>,
  parentModelSelection: ModelSelection | undefined,
  modelPreferences: ServerSettings["providerModelPreferences"] | undefined,
): ParsedSeat {
  if (slug === "inherit-parent" || slug === "auto") return { kind: "inherit" };
  const withoutFast = slug.replace(/-fast$/, "");
  const effortMatch = /-(low|medium|high|xhigh|max)$/.exec(withoutFast);
  const variants = [
    { model: slug, effort: undefined },
    ...(withoutFast === slug ? [] : [{ model: withoutFast, effort: undefined }]),
    ...(effortMatch === null
      ? []
      : [{ model: withoutFast.slice(0, effortMatch.index), effort: effortMatch[1] }]),
  ];
  const advertised = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  for (const variant of variants) {
    const matching = advertised.filter(
      ({ model }) =>
        model.slug === variant.model ||
        (!variant.model.includes("/") && model.slug.endsWith(`/${variant.model}`)),
    );
    if (matching.length === 0) continue;
    const eligible = matching.filter(
      ({ provider, model }) =>
        constraintsFor(provider).length === 0 &&
        isCapabilityModelVisible(model, modelPreferences?.[provider.instanceId]),
    );
    const exact = eligible.filter(({ model }) => model.slug === variant.model);
    const candidates = exact.length > 0 ? exact : eligible;
    if (new Set(candidates.map(({ model }) => model.slug)).size > 1)
      return {
        kind: "unresolved",
        model: slug,
        reason: "model alias is ambiguous; run setup-pstack to choose an advertised model",
      };
    const priority = (provider: ServerProvider) =>
      Number(provider.instanceId !== parentModelSelection?.instanceId);
    const available = candidates.toSorted(
      (left, right) => priority(left.provider) - priority(right.provider),
    );
    for (const { provider, model } of available) {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const options: ProviderOptionSelection[] = [];
      const descriptor = descriptors.find(
        (candidate) =>
          candidate.type === "select" &&
          candidate.options.filter((option) => effortLadder.includes(option.id)).length >= 2,
      );
      if (variant.effort !== undefined && descriptor?.type === "select") {
        const clamped = effortLadder
          .slice(0, effortLadder.indexOf(variant.effort) + 1)
          .findLast((value) => descriptor.options.some((option) => option.id === value));
        if (clamped === undefined) continue;
        options.push({ id: descriptor.id, value: clamped });
      }
      if (resolveOptions(options, descriptors).problems.length > 0) continue;
      return {
        kind: "entry",
        entry: { providerInstanceId: provider.instanceId, model: model.slug, options },
      };
    }
    return {
      kind: "unresolved",
      model: slug,
      reason: "no available provider can run this model with the requested reasoning budget",
    };
  }
  return { kind: "unresolved", model: slug, reason: "model is not advertised" };
}

export function resolveRoles(input: {
  readonly file: ReturnType<typeof parseModelsFile> | undefined;
  readonly defaults: ReadonlyArray<PstackRoleDefault>;
  readonly capableInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly parentModelSelection?: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly settings: Pick<ServerSettings, "providerInstances"> &
    Partial<Pick<ServerSettings, "providerModelPreferences">>;
}) {
  const constraintsFor = (provider: ServerProvider) =>
    delegationProviderConstraints(
      provider,
      input.capableInstanceIds.has(provider.instanceId),
      input.nowMs,
    );
  const diagnostics = [...(input.file?.diagnostics ?? [])];
  const parent =
    input.parentModelSelection === undefined
      ? undefined
      : input.providers.find(
          (provider) => provider.instanceId === input.parentModelSelection?.instanceId,
        );
  const parentConstraints =
    input.parentModelSelection === undefined
      ? []
      : parent === undefined
        ? ["provider instance is not registered"]
        : constraintsFor(parent);
  const inherited: Seat =
    parentConstraints.length === 0 ? { kind: "inherit" } : { kind: "unavailable" };
  if (parentConstraints.length > 0)
    diagnostics.push(
      `Parent model cannot run a child task (${parentConstraints.join(" ")}); refresh orchestrator_capabilities before choosing another target.`,
    );
  for (const role of input.file?.lines.keys() ?? []) {
    if (!input.defaults.some((entry) => entry.label === role))
      diagnostics.push(`Unknown role ${role}; ignored.`);
  }
  const roles = input.defaults.map((role) => {
    const entries =
      input.file?.lines.get(role.label) ??
      role.defaultValue
        .split(",")
        .map((slug) =>
          defaultSeat(
            slug.trim(),
            input.providers,
            constraintsFor,
            input.parentModelSelection,
            input.settings.providerModelPreferences,
          ),
        );
    const panel = PSTACK_PANEL_ROLES.has(role.label);
    const fallback = (index: number, target: string, reason: string): Seat | undefined => {
      const action =
        inherited.kind === "unavailable"
          ? "parent delegation is unavailable; refresh orchestrator_capabilities before choosing another target."
          : panel
            ? "runs on the parent model."
            : "excluded from pool; uses the parent model if no seats remain.";
      diagnostics.push(
        `Fallback: ${role.label} seat ${index + 1} ${target} unavailable (${reason}); ${action}`,
      );
      return panel ? inherited : undefined;
    };
    const seats = entries.map((seat, index): Seat | undefined => {
      if (seat.kind === "inherit")
        return inherited.kind === "unavailable" && !panel ? undefined : inherited;
      if (seat.kind === "unresolved") return fallback(index, seat.model, seat.reason);
      const entry = seat.entry;
      const instanceId = entry.providerInstanceId;
      const provider = input.providers.find((provider) => provider.instanceId === instanceId);
      const model = provider?.models.find((model) => model.slug === entry.model);
      const descriptors = model?.capabilities?.optionDescriptors ?? [];
      const { options, problems } = resolveOptions(entry.options, descriptors);
      let reason =
        entry.error ??
        (provider === undefined
          ? "provider instance is not registered"
          : constraintsFor(provider).join(" ") || undefined);
      reason ??= model === undefined ? "model is not advertised" : undefined;
      reason ??= problems.join(" ") || undefined;
      if (reason !== undefined) {
        return fallback(index, `${entry.providerInstanceId}/${entry.model}`, reason);
      }
      return {
        kind: "target",
        target: { providerInstanceId: instanceId, model: entry.model, options },
      };
    });
    const available = seats.filter((seat) => seat !== undefined);
    return {
      role: role.label,
      seats: available.length > 0 ? available : [inherited],
    };
  });
  return { roles, diagnostics };
}

// Native pstack plugins are off in T3 sessions, so this is the agent's only pointer to the pack.
export function formatPstackLocator(packDir: string): string {
  return [
    "<t3_pstack>",
    `pstack is built into T3 Code. <pstack>: ${packDir}`,
    "Read <pstack>/skills/<name>/SKILL.md for a pstack skill; its principles are the principle-* skills. Running a workflow with T3's model roles needs $pstack:<skill>.",
    "</t3_pstack>",
  ].join("\n");
}

export function formatPstackBlock(input: {
  readonly skillNames: ReadonlyArray<string>;
  readonly packDir: string;
  readonly modelsPath: string;
  readonly resolved: ReturnType<typeof resolveRoles>;
}): string {
  return [
    "<t3_pstack>",
    `pstack skill: ${input.skillNames.join(", ")}`,
    `<pstack>: ${input.packDir}`,
    `<models>: ${input.modelsPath}`,
    ...input.skillNames.map((name) => `Read <pstack>/skills/${name}/SKILL.md and follow it.`),
    "Resolved roles (exact delegate_task targets; they override any model a skill or <models> names):",
    "These targets are a snapshot. If a target is rejected or marked unavailable, refresh orchestrator_capabilities before retrying; keep the user's model choices and reasoning budget, and report any fallback.",
    "After setup-pstack changes <models>, re-read it and resolve against fresh orchestrator_capabilities; the earlier targets below no longer apply.",
    ...input.resolved.roles.map(({ role, seats }) => {
      const rule =
        seats.length > 1
          ? PSTACK_PANEL_ROLES.has(role)
            ? " (panel, one child per seat)"
            : " (pool, pick one per spawn)"
          : "";
      return `- ${role}${rule}: ${seats.map((seat, index) => `[${index + 1}] ${seat.kind === "target" ? JSON.stringify(seat.target) : seat.kind}`).join(" ")}`;
    }),
    ...(input.resolved.diagnostics.length === 0
      ? []
      : ["Notes:", ...input.resolved.diagnostics.map((note) => `- ${note}`)]),
    "</t3_pstack>",
  ].join("\n");
}
