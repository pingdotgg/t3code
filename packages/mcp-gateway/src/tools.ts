import {
  GatewayError,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayScope,
} from "./port.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type GatewayGrantSource = GatewayGrants | (() => GatewayGrants);

export type GatewayProfileSource =
  | ReadonlyArray<GatewayProfile>
  | (() => ReadonlyArray<GatewayProfile>);

export interface GatewayToolContext {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
}

function currentGrants(source: GatewayGrantSource): GatewayGrants {
  return typeof source === "function" ? source() : source;
}

function currentProfiles(source: GatewayProfileSource | undefined): ReadonlyArray<GatewayProfile> {
  if (source === undefined) return [];
  return typeof source === "function" ? source() : source;
}

function runtimeModeLabel(mode: GatewayProfile["runtimeMode"]): string {
  if (mode === "full-access") return "full access";
  if (mode === "auto-accept-edits") return "auto-accept edits";
  if (mode === "approval-required") return "approval required";
  return "auto";
}

function profileDescription(profile: GatewayProfile): string {
  return [
    `${profile.name} = ${profile.providerLabel}`,
    profile.modelLabel,
    profile.reasoningEffort,
    runtimeModeLabel(profile.runtimeMode),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Tool input must be an object.",
      retryable: false,
    });
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayError({
      code: "invalid_input",
      message: `${key} must be a non-empty string.`,
      retryable: false,
    });
  }
  return value;
}

function environmentWithScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  scope: GatewayScope,
): string {
  const environmentId = requiredString(input, "environmentId");
  const scopes = currentGrants(context.grants)[environmentId];
  if (scopes === undefined) {
    throw new GatewayError({
      code: "unknown_environment",
      message: `Environment ${environmentId} is not granted to this host.`,
      retryable: false,
      environmentId,
    });
  }
  if (!scopes.includes(scope)) {
    throw new GatewayError({
      code: "scope_required",
      message: `Scope ${scope} is required for environment ${environmentId}.`,
      retryable: false,
      environmentId,
      details: { requiredScope: scope },
    });
  }
  return environmentId;
}

function idFor(kind: string, idempotencyKey: string): string {
  return `mcp-${kind}-${idempotencyKey}`;
}

export async function callGatewayTool(
  context: GatewayToolContext,
  name: string,
  rawInput: unknown,
): Promise<any> {
  const input = record(rawInput);
  switch (name) {
    case "t3_list_profiles":
      return {
        items: currentProfiles(context.profiles)
          .filter((profile) =>
            currentGrants(context.grants)[profile.environmentId]?.includes("create"),
          )
          .map((profile) => ({
            name: profile.name,
            environmentId: profile.environmentId,
            description: profileDescription(profile),
          })),
      };
    case "t3_list_environments": {
      const environments = await context.port.listEnvironments();
      const grants = currentGrants(context.grants);
      return {
        items: environments.filter(
          (environment) => grants[environment.environmentId] !== undefined,
        ),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_environment_status": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getEnvironmentStatus(environmentId);
    }
    case "t3_list_projects": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.listProjects(environmentId);
    }
    case "t3_list_threads": {
      const environmentId = environmentWithScope(context, input, "read");
      const page = await context.port.listThreads(environmentId);
      const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
      return projectId === undefined
        ? page
        : { ...page, items: page.items.filter((thread) => thread.projectId === projectId) };
    }
    case "t3_get_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_get_messages": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const requestedLimit = typeof input.limit === "number" ? input.limit : 100;
      const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
      return {
        items: messages.slice(-limit),
        snapshotAt: typeof thread.updatedAt === "string" ? thread.updatedAt : "runtime",
      };
    }
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredString(input, "idempotencyKey");
      const profileName = typeof input.profile === "string" ? input.profile.trim() : "";
      const profile =
        profileName === ""
          ? undefined
          : currentProfiles(context.profiles).find((candidate) => candidate.name === profileName);
      if (
        profileName !== "" &&
        (profile === undefined || profile.environmentId !== environmentId)
      ) {
        throw new GatewayError({
          code: "invalid_profile",
          message: `Profile ${profileName} is not available for environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const rawModelSelection = profile === undefined ? record(input.modelSelection) : undefined;
      return context.port.createThread({
        environmentId,
        projectId: requiredString(input, "projectId"),
        threadId: idFor("thread", idempotencyKey),
        title: requiredString(input, "title"),
        modelSelection: {
          instanceId: profile?.instanceId ?? requiredString(rawModelSelection!, "instanceId"),
          model: profile?.model ?? requiredString(rawModelSelection!, "model"),
          ...(profile?.reasoningEffort === undefined
            ? {}
            : { options: [{ id: "reasoningEffort", value: profile.reasoningEffort }] }),
        },
        runtimeMode:
          profile?.runtimeMode ??
          (input.runtimeMode === "auto-accept-edits" ||
          input.runtimeMode === "auto" ||
          input.runtimeMode === "full-access"
            ? input.runtimeMode
            : "approval-required"),
        interactionMode:
          profile?.interactionMode ?? (input.interactionMode === "plan" ? "plan" : "default"),
        requestId: idFor("create-thread", idempotencyKey),
      });
    }
    case "t3_send_message": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredString(input, "idempotencyKey");
      return context.port.sendMessage({
        environmentId,
        threadId: requiredString(input, "threadId"),
        text: requiredString(input, "text"),
        messageId: idFor("message", idempotencyKey),
        requestId: idFor("send-message", idempotencyKey),
      });
    }
    default:
      throw new GatewayError({
        code: "unknown_tool",
        message: `Unknown tool ${name}.`,
        retryable: false,
      });
  }
}
