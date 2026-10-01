import { defineApi, defineStreamApi, type TypedApi, type TypedStreamApi } from "./capabilities.js";
import type { JsonObject } from "./environment.js";

export const PROJECTS_CLONE = "t3.projects/clone";
export const PROJECTS_CREATE = "t3.projects/create";
export const SOURCE_CONTROL_DISCOVERY = "t3.source-control/discovery";
export const SOURCE_CONTROL_READ = "t3.source-control/read";

export type SourceControlKind = "github" | "gitlab" | "forgejo" | "azure-devops" | "bitbucket";
export type CloneProtocol = "auto" | "ssh" | "https";
export type CloneRepository = {
  readonly provider: SourceControlKind | "unknown";
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
};
export type SourceControlProvider = {
  readonly kind: SourceControlKind | "unknown";
  readonly label: string;
  readonly status: "available" | "missing";
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  readonly account: string | null;
  readonly ready: boolean;
  readonly hint: string | null;
};
export type SourceControlDiscovery = { readonly providers: readonly SourceControlProvider[] };
export type CloneStart = {
  readonly title: string;
  readonly destinationName: string;
  readonly remoteUrl?: string;
  readonly provider?: SourceControlKind;
  readonly repository?: string;
  readonly protocol?: CloneProtocol;
};
export type CloneReceipt = {
  readonly projectId: string;
  readonly cwd: string;
  readonly remoteUrl: string;
  readonly repository: CloneRepository | null;
};
export type ProjectClone = {
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly repository: CloneRepository | null;
  readonly phase: "running" | "done" | "failed" | "cancelled";
  readonly stage: "connecting" | "counting" | "receiving" | "resolving" | "checkout";
  readonly percent: number | null;
  readonly detail: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sequence: number;
};
export type ProjectClones = {
  readonly clones: readonly ProjectClone[];
  readonly truncated: boolean;
};
export type RepositoryList = {
  readonly repositories: readonly CloneRepository[];
  readonly truncated: boolean;
};

const text = { type: "string", minLength: 1, maxLength: 2048 } as const;
const nullable = (schema: JsonObject) => ({ anyOf: [schema, { type: "null" }] });
const providers = ["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const;
const providerSchema = { enum: providers };
const empty = { type: "object", additionalProperties: false, properties: {} } as const;
const repositorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "nameWithOwner", "url", "sshUrl"],
  properties: {
    provider: { enum: [...providers, "unknown"] },
    nameWithOwner: text,
    url: text,
    sshUrl: text,
  },
};
const receiptProperties = {
  projectId: text,
  cwd: text,
  remoteUrl: text,
  repository: nullable(repositorySchema),
};
const actionInput = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: { projectId: text },
} as const;
const actionOutput = {
  type: "object",
  additionalProperties: false,
  required: ["applied"],
  properties: { applied: { type: "boolean" } },
} as const;

export const projectsCloneApi: TypedApi<{
  start: { input: CloneStart; output: CloneReceipt };
  cancel: { input: { readonly projectId: string }; output: { readonly applied: boolean } };
  retry: { input: { readonly projectId: string }; output: { readonly applied: boolean } };
}> &
  TypedStreamApi<{
    subscribe: { input: Record<string, never>; event: ProjectClones };
  }> = defineStreamApi<{ subscribe: { input: Record<string, never>; event: ProjectClones } }>(
  {
    id: PROJECTS_CLONE,
    version: "1.0.0",
    methods: [
      {
        name: "start",
        effect: "write",
        requiredGrants: [PROJECTS_CREATE],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "destinationName"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 256 },
            destinationName: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$",
            },
            remoteUrl: text,
            provider: providerSchema,
            repository: text,
            protocol: { enum: ["auto", "ssh", "https"] },
          },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(receiptProperties),
          properties: receiptProperties,
        },
      },
      ...["cancel", "retry"].map((name) => ({
        name,
        effect: "write" as const,
        requiredGrants: [PROJECTS_CREATE],
        inputSchema: actionInput,
        outputSchema: actionOutput,
      })),
    ],
    streams: [
      {
        name: "subscribe",
        requiredGrants: [PROJECTS_CREATE],
        inputSchema: empty,
        eventSchema: {
          type: "object",
          additionalProperties: false,
          required: ["clones", "truncated"],
          properties: {
            truncated: { type: "boolean" },
            clones: {
              type: "array",
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "projectId",
                  "remoteUrl",
                  "destinationPath",
                  "repository",
                  "phase",
                  "stage",
                  "percent",
                  "detail",
                  "error",
                  "startedAt",
                  "endedAt",
                  "sequence",
                ],
                properties: {
                  projectId: text,
                  remoteUrl: text,
                  destinationPath: text,
                  repository: nullable(repositorySchema),
                  phase: { enum: ["running", "done", "failed", "cancelled"] },
                  stage: { enum: ["connecting", "counting", "receiving", "resolving", "checkout"] },
                  percent: nullable({ type: "integer", minimum: 0, maximum: 100 }),
                  detail: nullable({ type: "string", maxLength: 200 }),
                  error: nullable({ type: "string", maxLength: 1000 }),
                  startedAt: text,
                  endedAt: nullable(text),
                  sequence: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
    ],
  },
  { baseline: "1.0.0" },
);

export const sourceControlDiscoveryApi = defineApi<{
  discover: { input: Record<string, never>; output: SourceControlDiscovery };
  lookupRepository: {
    input: { readonly provider: SourceControlKind; readonly repository: string };
    output: CloneRepository;
  };
  listRepositories: { input: { readonly provider: SourceControlKind }; output: RepositoryList };
}>(
  {
    id: SOURCE_CONTROL_DISCOVERY,
    version: "1.0.0",
    methods: [
      {
        name: "discover",
        effect: "read",
        requiredGrants: [SOURCE_CONTROL_READ],
        inputSchema: empty,
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["providers"],
          properties: {
            providers: {
              type: "array",
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "label", "status", "authStatus", "account", "ready", "hint"],
                properties: {
                  kind: { enum: [...providers, "unknown"] },
                  label: text,
                  status: { enum: ["available", "missing"] },
                  authStatus: { enum: ["authenticated", "unauthenticated", "unknown"] },
                  account: nullable(text),
                  ready: { type: "boolean" },
                  hint: nullable(text),
                },
              },
            },
          },
        },
      },
      {
        name: "lookupRepository",
        effect: "read",
        requiredGrants: [SOURCE_CONTROL_READ],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "repository"],
          properties: { provider: providerSchema, repository: text },
        },
        outputSchema: repositorySchema,
      },
      {
        name: "listRepositories",
        effect: "read",
        requiredGrants: [SOURCE_CONTROL_READ],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["provider"],
          properties: { provider: providerSchema },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repositories", "truncated"],
          properties: {
            repositories: { type: "array", maxItems: 20, items: repositorySchema },
            truncated: { type: "boolean" },
          },
        },
      },
    ],
  },
  { baseline: "1.0.0" },
);
