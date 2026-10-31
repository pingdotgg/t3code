import { SandboxProviderError, type SandboxTemplate } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  type CreatedSandbox,
  jsonBody,
  requestJson,
  requestText,
  type SandboxProviderConfig,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
} from "../SandboxProvider.ts";

const VERCEL_API_BASE = "https://api.vercel.com";
const DEFAULT_PROJECT = "t3-sandboxes";
const SERVER_PORT = 3773;
const ROLE_TAG = "t3.code/role";
// Vercel snapshots carry no name, so a template is a stopped sandbox whose own snapshot is the disk.
const TEMPLATE_PREFIX = "t3-template-";
const STOPPED_DISK_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
// One session, not the sandbox, is capped: 45 minutes on Hobby, a day on Pro and Enterprise.
const HOBBY_SESSION_MINUTES = 45;
const PAID_SESSION_MINUTES = 1440;
const HOBBY_MAX_VCPUS = 4;
const POLL_INTERVAL = "2 seconds";
const POLL_ATTEMPTS = 90;

const VercelTeam = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  billing: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ plan: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
});

const VercelTeams = Schema.Struct({ teams: Schema.Array(VercelTeam) });

const VercelNamedSandbox = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  currentSessionId: Schema.String,
  currentSnapshotId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.Number,
  vcpus: Schema.optionalKey(Schema.Number),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const VercelSandbox = Schema.Struct({
  sandbox: VercelNamedSandbox,
  session: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, status: Schema.String, timeout: Schema.Number }),
  ),
  routes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ port: Schema.Number, url: Schema.String })),
  ),
});

const VercelSandboxes = Schema.Struct({ sandboxes: Schema.Array(VercelNamedSandbox) });

const Ignored = Schema.Struct({});

// `stopping` already refuses commands, so it reads as stopped; `stopped` keeps the disk for resume.
const VERCEL_STATUS: Record<string, SandboxProviderStatus> = {
  running: "running",
  stopping: "stopped",
  stopped: "stopped",
};

const SIZE_VCPUS: Record<string, number> = { "vercel-2": 2, "vercel-4": 4, "vercel-8": 8 };

const info = {
  kind: "vercel",
  label: "Vercel",
  detail: "Firecracker microVMs with a public URL per port. Hobby sessions stop after 45 minutes.",
  apiKeyLabel: "Vercel access token",
  apiKeyPlaceholder: "vcp_...",
  docsUrl: "https://vercel.com/account/settings/tokens",
  sizes: [
    { id: "vercel-2", label: "Small", detail: "2 vCPU · 4 GB · 64 GB" },
    { id: "vercel-4", label: "Medium", detail: "4 vCPU · 8 GB · 64 GB" },
    { id: "vercel-8", label: "Large", detail: "8 vCPU · 16 GB · 64 GB · Pro plan" },
  ],
  settingsFields: [
    { id: "teamId", label: "Team", placeholder: "Detected from the token", optional: true },
    { id: "projectId", label: "Project", placeholder: DEFAULT_PROJECT, optional: true },
  ],
} satisfies SandboxProviderDriver["info"];

interface Scope {
  readonly teamId: string | undefined;
  readonly project: string;
  readonly sessionMaxMinutes: number;
  readonly hobby: boolean;
}

const configError = (detail: string) =>
  new SandboxProviderError({ provider: "vercel", stage: "config", detail });

const toScope = (
  config: SandboxProviderConfig,
  team: typeof VercelTeam.Type | undefined,
): Scope => {
  // An account without teams is a personal Hobby account.
  const plan = team?.billing?.plan ?? "hobby";
  const hobby = plan !== "pro" && plan !== "enterprise";
  return {
    teamId: team?.id,
    project: config.settings.projectId ?? DEFAULT_PROJECT,
    sessionMaxMinutes: hobby ? HOBBY_SESSION_MINUTES : PAID_SESSION_MINUTES,
    hobby,
  };
};

const listTeams = (config: SandboxProviderConfig) =>
  requestJson({
    provider: "vercel",
    stage: "config",
    schema: VercelTeams,
    request: authorize(
      HttpClientRequest.get(`${VERCEL_API_BASE}/v2/teams`).pipe(
        HttpClientRequest.setUrlParams({ limit: "20" }),
      ),
      config.apiKey,
    ),
  });

// Resolved on every call: nothing about the account is cached between operations.
const resolveScope = Effect.fn("Vercel.resolveScope")(function* (config: SandboxProviderConfig) {
  const chosen = config.settings.teamId;
  if (chosen !== undefined) {
    const team = yield* requestJson({
      provider: "vercel",
      stage: "config",
      schema: VercelTeam,
      request: authorize(
        HttpClientRequest.get(`${VERCEL_API_BASE}/v2/teams/${encodeURIComponent(chosen)}`),
        config.apiKey,
      ),
    }).pipe(
      // Vercel answers 403 both for a bad token and for a team the token cannot see; the team list
      // tells them apart, and a bad token fails it with its own error.
      Effect.catchIf(
        (error) => error.status === 403 || error.status === 404,
        () =>
          listTeams(config).pipe(
            Effect.andThen(
              Effect.fail(
                configError(
                  `This Vercel token cannot see a team named ${chosen.slice(0, 100)}. Check Team in the sandbox settings.`,
                ),
              ),
            ),
          ),
      ),
    );
    return toScope(config, team);
  }
  const { teams } = yield* listTeams(config);
  if (teams.length <= 1) return toScope(config, teams[0]);
  const slugs = teams.slice(0, 5).map((team) => team.slug);
  return yield* configError(
    `This Vercel token can see ${teams.length === 20 ? "20 or more" : teams.length} teams. Enter one under Team: ${slugs.join(", ")}${teams.length > slugs.length ? ", …" : ""}.`,
  );
});

const request = (
  config: SandboxProviderConfig,
  scope: Scope,
  base: HttpClientRequest.HttpClientRequest,
  params: Record<string, string> = {},
) =>
  authorize(
    HttpClientRequest.setUrlParams(base, {
      ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
      ...params,
    }),
    config.apiKey,
  );

const sandboxUrl = (name: string) => `${VERCEL_API_BASE}/v2/sandboxes/${encodeURIComponent(name)}`;

const getSandbox = (
  config: SandboxProviderConfig,
  scope: Scope,
  name: string,
  stage: "start" | "install" | "expose" | "template",
) =>
  requestJson({
    provider: "vercel",
    stage,
    schema: VercelSandbox,
    request: request(config, scope, HttpClientRequest.get(sandboxUrl(name)), {
      projectId: scope.project,
    }),
  });

// Sessions change on every resume, so the current one is read before each command or stop.
const runningSession = Effect.fn("Vercel.runningSession")(function* (
  config: SandboxProviderConfig,
  scope: Scope,
  name: string,
  stage: "start" | "install" | "template",
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const current = yield* getSandbox(config, scope, name, stage);
    if (current.sandbox.status === "running" && current.session?.status === "running") {
      return current;
    }
    if (current.sandbox.status !== "running") {
      return yield* new SandboxProviderError({
        provider: "vercel",
        stage,
        detail: `The sandbox is ${current.sandbox.status}.`,
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "vercel",
    stage,
    detail: "Timed out waiting for the sandbox to start.",
  });
});

const waitUntilStopped = Effect.fn("Vercel.waitUntilStopped")(function* (
  config: SandboxProviderConfig,
  scope: Scope,
  name: string,
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const current = yield* getSandbox(config, scope, name, "template");
    if (current.sandbox.status === "stopped") return current;
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "vercel",
    stage: "template",
    detail: "The sandbox did not finish stopping, so the template was not saved.",
  });
});

const stopSession = (config: SandboxProviderConfig, scope: Scope, sessionId: string) =>
  requestJson({
    provider: "vercel",
    stage: "delete",
    schema: Ignored,
    // Vercel answers 415 to a POST without a JSON body.
    request: jsonBody(
      request(
        config,
        scope,
        HttpClientRequest.post(
          `${VERCEL_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`,
        ),
      ),
      {},
    ),
  });

const deleteSandbox = (
  config: SandboxProviderConfig,
  scope: Scope,
  name: string,
  stage: "delete" | "template",
) =>
  requestJson({
    provider: "vercel",
    stage,
    schema: Ignored,
    request: request(config, scope, HttpClientRequest.delete(sandboxUrl(name)), {
      projectId: scope.project,
      // Only snapshots no other sandbox starts from, so a template outlives its source.
      deleteOrphanSnapshots: "true",
    }),
  });

// A sandbox lives in a project; the default one is made on the first create.
const ensureProject = Effect.fn("Vercel.ensureProject")(function* (
  config: SandboxProviderConfig,
  scope: Scope,
) {
  const found = yield* requestJson({
    provider: "vercel",
    stage: "create",
    schema: Ignored,
    request: request(
      config,
      scope,
      HttpClientRequest.get(`${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(scope.project)}`),
    ),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.code === "not_found",
      () => Effect.succeed(false),
    ),
  );
  if (found) return;
  if (scope.project !== DEFAULT_PROJECT) {
    return yield* configError(
      `Vercel has no project named ${scope.project.slice(0, 100)}. Check Project in the sandbox settings.`,
    );
  }
  yield* requestJson({
    provider: "vercel",
    stage: "create",
    schema: Ignored,
    request: jsonBody(
      request(config, scope, HttpClientRequest.post(`${VERCEL_API_BASE}/v11/projects`)),
      { name: DEFAULT_PROJECT },
    ),
  });
});

const parseCommandStream = (stream: string) => {
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as {
      readonly command?: { readonly exitCode?: unknown };
      readonly data?: unknown;
      readonly stream?: unknown;
    };
    if (typeof entry.command?.exitCode === "number") exitCode = entry.command.exitCode;
    if (typeof entry.data === "string") {
      if (entry.stream === "stderr") stderr += entry.data;
      else stdout += entry.data;
    }
  }
  return { exitCode, stdout, stderr };
};

const templateSandboxName = (name: string) => `${TEMPLATE_PREFIX}${name}`;

const toTemplate = (sandbox: typeof VercelNamedSandbox.Type): SandboxTemplate => {
  const size = Object.entries(SIZE_VCPUS).find(([, vcpus]) => vcpus === sandbox.vcpus)?.[0];
  return {
    name: sandbox.name.slice(TEMPLATE_PREFIX.length),
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(sandbox.createdAt)),
    ...(size === undefined ? {} : { size }),
  };
};

// Names must be unique per project and URL-safe; the attempt id keeps two equal labels apart.
const sandboxName = (label: string, idempotencyKey: string) => {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "sandbox";
  return `${slug}-${idempotencyKey.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8)}`;
};

export const vercelDriver: SandboxProviderDriver = {
  info,
  defaultSize: "vercel-2",
  serverPort: SERVER_PORT,
  create: Effect.fn("Vercel.create")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const vcpus = SIZE_VCPUS[input.size] ?? 2;
    if (input.template === undefined && scope.hobby && vcpus > HOBBY_MAX_VCPUS) {
      return yield* new SandboxProviderError({
        provider: "vercel",
        stage: "config",
        code: "size_unavailable",
        detail: `Vercel Hobby allows up to ${HOBBY_MAX_VCPUS} vCPUs. Choose a smaller size or upgrade to Pro.`,
      });
    }
    yield* ensureProject(input.config, scope);
    const body = {
      name: sandboxName(input.name, input.idempotencyKey),
      ports: [SERVER_PORT],
      // The session stops at the plan's cap even when T3's lifetime is longer; resume starts another.
      timeout: Math.min(input.ttlMinutes ?? 480, scope.sessionMaxMinutes) * 60_000,
      tags: { [ROLE_TAG]: "environment" },
      persistent: true,
      snapshotExpiration: STOPPED_DISK_EXPIRATION_MS,
      keepLastSnapshots: { count: 1 },
    };
    const created = yield* requestJson({
      provider: "vercel",
      stage: "create",
      schema: VercelSandbox,
      request:
        input.template === undefined
          ? jsonBody(
              request(
                input.config,
                scope,
                HttpClientRequest.post(`${VERCEL_API_BASE}/v4/sandboxes`),
              ),
              { ...body, projectId: scope.project, resources: { vcpus } },
            )
          : // A fork copies the template's size, tags, and snapshot settings; the body overrides them.
            jsonBody(
              request(
                input.config,
                scope,
                HttpClientRequest.post(`${sandboxUrl(templateSandboxName(input.template))}/fork`),
                { projectId: scope.project },
              ),
              body,
            ),
    });
    const url = created.routes?.find((route) => route.port === SERVER_PORT)?.url;
    return {
      id: created.sandbox.name,
      name: input.name,
      ...(url === undefined ? {} : { publicUrl: url }),
      settings: {
        ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
        projectId: scope.project,
      },
    } satisfies CreatedSandbox;
  }),
  execute: Effect.fn("Vercel.execute")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const current = yield* runningSession(input.config, scope, input.sandboxId, "install");
    const stream = yield* requestText({
      provider: "vercel",
      stage: "install",
      request: jsonBody(
        request(
          input.config,
          scope,
          HttpClientRequest.post(
            `${VERCEL_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(current.sandbox.currentSessionId)}/cmd`,
          ),
        ),
        {
          command: "sh",
          args: ["-c", input.command],
          wait: true,
          logs: true,
          timeout: Math.min(Math.max(input.timeoutSeconds, 1), 600) * 1000,
        },
      ),
    });
    const result = parseCommandStream(stream);
    if (result.exitCode !== 0) {
      return yield* new SandboxProviderError({
        provider: "vercel",
        stage: "install",
        // Only the exit status is an attribute; command output can contain secrets.
        detail: `The command exited with ${result.exitCode ?? "an unknown status"}.`,
        cause: new Error(
          [result.stderr, result.stdout]
            .map((part) => part.trim())
            .filter((part) => part !== "")
            .join("\n")
            .slice(-4000),
        ),
      });
    }
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  }),
  exposePort: Effect.fn("Vercel.exposePort")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const current = yield* getSandbox(input.config, scope, input.sandboxId, "expose");
    const url = current.routes?.find((route) => route.port === input.port)?.url;
    if (url === undefined) {
      return yield* new SandboxProviderError({
        provider: "vercel",
        stage: "expose",
        detail: `The sandbox does not publish port ${input.port}.`,
      });
    }
    return url;
  }),
  stop: Effect.fn("Vercel.stop")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const current = yield* getSandbox(input.config, scope, input.sandboxId, "start");
    if (current.sandbox.status !== "running") return;
    yield* stopSession(input.config, scope, current.sandbox.currentSessionId);
  }),
  resume: Effect.fn("Vercel.resume")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const timeout = Math.min(input.ttlMinutes ?? 480, scope.sessionMaxMinutes) * 60_000;
    // The new session takes the sandbox's timeout; `resume=true` on the PATCH does not resume.
    yield* requestJson({
      provider: "vercel",
      stage: "start",
      schema: Ignored,
      request: jsonBody(
        request(input.config, scope, HttpClientRequest.patch(sandboxUrl(input.sandboxId)), {
          projectId: scope.project,
        }),
        { timeout },
      ),
    });
    const resumed = yield* requestJson({
      provider: "vercel",
      stage: "start",
      schema: VercelSandbox,
      request: request(input.config, scope, HttpClientRequest.get(sandboxUrl(input.sandboxId)), {
        projectId: scope.project,
        resume: "true",
      }),
    });
    const url = resumed.routes?.find((route) => route.port === SERVER_PORT)?.url;
    return url === undefined ? {} : { publicUrl: url };
  }),
  extend: Effect.fn("Vercel.extend")(function* (input) {
    // A stopped sandbox gets the time left when it resumes.
    if (!input.running) return;
    const scope = yield* resolveScope(input.config);
    const current = yield* getSandbox(input.config, scope, input.sandboxId, "start");
    const session = current.session;
    const expiresAt = current.sandbox.expiresAt;
    if (current.sandbox.status !== "running" || session === undefined || !expiresAt) return;
    const now = yield* Clock.currentTimeMillis;
    // `extend-timeout` adds to the session, which the plan caps; past the cap the session stops
    // early and T3's deadline still stands.
    const duration = Math.min(
      now + input.ttlMinutes * 60_000 - expiresAt,
      scope.sessionMaxMinutes * 60_000 - session.timeout,
    );
    if (duration < 1000) return;
    yield* requestJson({
      provider: "vercel",
      stage: "config",
      schema: Ignored,
      request: jsonBody(
        request(
          input.config,
          scope,
          HttpClientRequest.post(
            `${VERCEL_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(session.id)}/extend-timeout`,
          ),
        ),
        { duration },
      ),
    });
  }),
  status: Effect.fn("Vercel.status")(function* (input) {
    const scope = yield* resolveScope(input.config);
    return yield* getSandbox(input.config, scope, input.sandboxId, "start").pipe(
      Effect.map((current) => VERCEL_STATUS[current.sandbox.status] ?? null),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed("deleted" as const),
      ),
    );
  }),
  // Forks the stopped, already scrubbed sandbox and stops the fork at once: its own snapshot, kept
  // without expiry, becomes the template, so deleting the source afterwards leaves it intact.
  saveTemplate: Effect.fn("Vercel.saveTemplate")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const source = yield* waitUntilStopped(input.config, scope, input.sandboxId);
    const name = templateSandboxName(input.name);
    // Saving under an existing name replaces that template.
    const existing = yield* getSandbox(input.config, scope, name, "template").pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed(false),
      ),
    );
    if (existing) yield* deleteSandbox(input.config, scope, name, "template");
    const forked = yield* requestJson({
      provider: "vercel",
      stage: "template",
      schema: VercelSandbox,
      request: jsonBody(
        request(
          input.config,
          scope,
          HttpClientRequest.post(`${sandboxUrl(input.sandboxId)}/fork`),
          { projectId: scope.project },
        ),
        {
          name,
          timeout: 5 * 60_000,
          tags: { [ROLE_TAG]: "template" },
          persistent: true,
          snapshotExpiration: 0,
          keepLastSnapshots: { count: 1 },
        },
      ),
    });
    yield* stopSession(input.config, scope, forked.sandbox.currentSessionId);
    const saved = yield* waitUntilStopped(input.config, scope, name);
    // Deleting the source keeps a snapshot the template still references, so once the template
    // has its own, the source's stop snapshot goes now instead of billing until it expires.
    const sourceSnapshot = source.sandbox.currentSnapshotId;
    if (
      sourceSnapshot &&
      saved.sandbox.currentSnapshotId &&
      saved.sandbox.currentSnapshotId !== sourceSnapshot
    ) {
      yield* requestJson({
        provider: "vercel",
        stage: "template",
        schema: Schema.Unknown,
        request: request(
          input.config,
          scope,
          HttpClientRequest.delete(
            `${VERCEL_API_BASE}/v2/sandboxes/snapshots/${encodeURIComponent(sourceSnapshot)}`,
          ),
        ),
      }).pipe(Effect.ignore);
    }
    return toTemplate(saved.sandbox);
  }),
  listTemplates: Effect.fn("Vercel.listTemplates")(function* (input) {
    const scope = yield* resolveScope(input.config);
    const listed = yield* requestJson({
      provider: "vercel",
      stage: "template",
      schema: VercelSandboxes,
      request: request(
        input.config,
        scope,
        HttpClientRequest.get(`${VERCEL_API_BASE}/v2/sandboxes`),
        {
          project: scope.project,
          tags: `${ROLE_TAG}:template`,
          limit: "50",
        },
      ),
    }).pipe(
      // No sandbox has been created yet, so the default project does not exist.
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed({ sandboxes: [] }),
      ),
    );
    return {
      // A template still running is mid-save; only a stopped one has its disk.
      templates: listed.sandboxes
        .filter(
          (sandbox) => sandbox.name.startsWith(TEMPLATE_PREFIX) && sandbox.status === "stopped",
        )
        .map(toTemplate),
    };
  }),
  deleteTemplate: Effect.fn("Vercel.deleteTemplate")(function* (input) {
    const scope = yield* resolveScope(input.config);
    yield* deleteSandbox(input.config, scope, templateSandboxName(input.name), "template");
  }),
  destroy: Effect.fn("Vercel.destroy")(function* (input) {
    const scope = yield* resolveScope(input.config);
    yield* deleteSandbox(input.config, scope, input.sandboxId, "delete");
  }),
};
