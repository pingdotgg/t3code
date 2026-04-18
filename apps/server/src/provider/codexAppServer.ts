import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as CodexClient from "effect-codex-app-server/client";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import type { Mutable } from "effect/Types";

import { readCodexAccountSnapshotResponse, type CodexAccountSnapshot } from "./codexAccount.ts";

export interface CodexDiscoverySnapshot {
  readonly account: CodexAccountSnapshot;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export class CodexDiscoveryProbeError extends Schema.TaggedErrorClass<CodexDiscoveryProbeError>()(
  "CodexDiscoveryProbeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export function parseCodexSkillsListResponse(
  response: EffectCodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

export function buildCodexInitializeParams(): EffectCodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

export const probeCodexDiscovery = Effect.fn("probeCodexDiscovery")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
}) {
  const clientContext = yield* Layer.build(
    CodexClient.layerCommand({
      command: input.binaryPath,
      args: ["app-server"],
      ...(input.homePath ? { env: { CODEX_HOME: input.homePath } } : {}),
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CodexDiscoveryProbeError({
          detail: `Codex discovery probe spawn failed: ${cause.message}`,
          cause,
        }),
    ),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  yield* client.request("initialize", buildCodexInitializeParams()).pipe(
    Effect.mapError(
      (cause) =>
        new CodexDiscoveryProbeError({
          detail: `Codex discovery probe initialize failed: ${cause.message}`,
          cause,
        }),
    ),
  );
  yield* client.notify("initialized", undefined).pipe(
    Effect.mapError(
      (cause) =>
        new CodexDiscoveryProbeError({
          detail: `Codex discovery probe initialized notification failed: ${cause.message}`,
          cause,
        }),
    ),
  );

  const [skillsResponse, accountResponse] = yield* Effect.all(
    [
      client.request("skills/list", {
        cwds: [input.cwd],
      }),
      client.request("account/read", {}),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CodexDiscoveryProbeError({
          detail: `Codex discovery probe request failed: ${cause.message}`,
          cause,
        }),
    ),
  );

  return {
    account: readCodexAccountSnapshotResponse(accountResponse),
    skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
  } satisfies CodexDiscoverySnapshot;
}, Effect.scoped);
