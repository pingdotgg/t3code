import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export const ORIGIN_GIT_HOST = "origin.cursor.com";
export const ORIGIN_WEB_BASE = "https://cursor.com/codebase";
export const ORIGIN_PULL_REQUEST_JSON_FIELDS = "number,title,url,status,head,base,updatedAt";

export interface NormalizedOriginPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
}

const OriginPullRequestNumber = Schema.Union([PositiveInt, TrimmedNonEmptyString]);
const OriginRef = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Struct({
    ref: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);

const OriginPullRequestSchema = Schema.Struct({
  number: OriginPullRequestNumber,
  title: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.Boolean),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  head: Schema.optional(Schema.NullOr(OriginRef)),
  base: Schema.optional(Schema.NullOr(OriginRef)),
  headRefName: Schema.optional(Schema.NullOr(Schema.String)),
  baseRefName: Schema.optional(Schema.NullOr(Schema.String)),
  fullName: Schema.optional(Schema.NullOr(Schema.String)),
  org: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface OriginPullRequestDecodeOptions {
  readonly nameWithOwner?: string;
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parsePullRequestNumber(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function originRefName(value: string | null | undefined): string | null {
  const trimmed = trimOptionalString(value)?.replace(/^refs\/heads\//u, "") ?? null;
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function refFromField(
  value: Schema.Schema.Type<typeof OriginRef> | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return originRefName(value);
  }
  return originRefName(value.ref);
}

function normalizeOriginPullRequestState(input: {
  status?: string | null | undefined;
  state?: string | null | undefined;
  merged?: boolean | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  if (
    input.merged === true ||
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0)
  ) {
    return "merged";
  }
  const normalized = (input.status ?? input.state)?.trim().toLowerCase();
  if (normalized === "merged") {
    return "merged";
  }
  if (normalized === "closed") {
    return "closed";
  }
  return "open";
}

function nameWithOwnerFromPath(path: string): string | null {
  const segments = path
    .replace(/\.git$/u, "")
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments.at(-2);
  const repo = segments.at(-1);
  return owner && repo ? `${owner}/${repo}` : null;
}

export function originNameWithOwnerFromGitUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const scpMatch = /^[a-zA-Z0-9._-]+@[^:]+:(.+)$/u.exec(trimmed);
  if (scpMatch?.[1]) {
    return nameWithOwnerFromPath(scpMatch[1]);
  }

  try {
    return nameWithOwnerFromPath(new URL(trimmed).pathname);
  } catch {
    return nameWithOwnerFromPath(trimmed);
  }
}

function originNameWithOwnerFromRecord(
  raw: Schema.Schema.Type<typeof OriginPullRequestSchema>,
): string | null {
  const fullName = trimOptionalString(raw.fullName);
  if (fullName?.includes("/")) {
    return nameWithOwnerFromPath(fullName);
  }
  const repository = trimOptionalString(raw.repository);
  if (repository?.includes("/")) {
    return nameWithOwnerFromPath(repository);
  }
  const org = trimOptionalString(raw.org);
  const name = trimOptionalString(raw.name);
  return org && name ? `${org}/${name}` : null;
}

function originPullRequestUrl(input: {
  readonly url: string | null;
  readonly number: number;
  readonly nameWithOwner: string | null;
}): string | null {
  if (input.url) {
    return input.url;
  }
  if (input.nameWithOwner) {
    return `${ORIGIN_WEB_BASE}/${input.nameWithOwner}/pull/${input.number}`;
  }
  return null;
}

function normalizeOriginPullRequestRecord(
  raw: Schema.Schema.Type<typeof OriginPullRequestSchema>,
  options?: OriginPullRequestDecodeOptions,
): NormalizedOriginPullRequestRecord | null {
  const number = parsePullRequestNumber(raw.number);
  const headRefName = originRefName(raw.headRefName) ?? refFromField(raw.head);
  const baseRefName = originRefName(raw.baseRefName) ?? refFromField(raw.base);
  if (number === null || headRefName === null || baseRefName === null) {
    return null;
  }

  const url = originPullRequestUrl({
    url: trimOptionalString(raw.url),
    number,
    nameWithOwner: originNameWithOwnerFromRecord(raw) ?? trimOptionalString(options?.nameWithOwner),
  });
  if (url === null) {
    return null;
  }

  return {
    number,
    title: raw.title,
    url,
    baseRefName,
    headRefName,
    state: normalizeOriginPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
  };
}

const decodeOriginPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeOriginPullRequest = decodeJsonResult(OriginPullRequestSchema);
const decodeOriginPullRequestEntry = Schema.decodeUnknownExit(OriginPullRequestSchema);

export const formatOriginJsonDecodeError = formatSchemaError;

export function decodeOriginPullRequestListJson(
  raw: string,
  options?: OriginPullRequestDecodeOptions,
): Result.Result<
  ReadonlyArray<NormalizedOriginPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeOriginPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedOriginPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeOriginPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      const normalized = normalizeOriginPullRequestRecord(decodedEntry.value, options);
      if (normalized) {
        pullRequests.push(normalized);
      }
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeOriginPullRequestJson(
  raw: string,
  options?: OriginPullRequestDecodeOptions,
): Result.Result<NormalizedOriginPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeOriginPullRequest(raw);
  if (Result.isFailure(result)) {
    return Result.fail(result.failure);
  }
  const normalized = normalizeOriginPullRequestRecord(result.success, options);
  if (normalized === null) {
    return Result.fail(
      Cause.die(
        new Error("Origin pull request JSON is missing number, head, base, or repository."),
      ),
    );
  }
  return Result.succeed(normalized);
}

export function originHttpsCloneUrl(nameWithOwner: string): string {
  return `https://${ORIGIN_GIT_HOST}/${nameWithOwner}.git`;
}

export function originSshCloneUrl(nameWithOwner: string): string {
  return `git@${ORIGIN_GIT_HOST}:${nameWithOwner}.git`;
}

export function originGitHttpsUrl(nameWithOwner: string): string {
  return originHttpsCloneUrl(nameWithOwner).replace(/\.git$/u, "");
}

export function originWebRepositoryUrl(nameWithOwner: string): string {
  return `${ORIGIN_WEB_BASE}/${nameWithOwner}`;
}
