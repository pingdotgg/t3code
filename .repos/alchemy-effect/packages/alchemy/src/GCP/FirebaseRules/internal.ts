import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_RELEASE_ID_LENGTH = 63;
export const GENERATED_RELEASE_PREFIX = "alc-";

export type RulesetFile = {
  /** Path of this file in the ruleset (e.g. `firestore.rules`). */
  name: string;
  /** Textual rules content. */
  content: string;
  /** Optional fingerprint (git SHA, etag, …) associated with the file. */
  fingerprint?: string;
};

export type RulesetSource = {
  /** Files that make up the ruleset. At least one file is required. */
  files: RulesetFile[];
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;

export const rulesetResourceName = (project: string, rulesetId: string) =>
  `${projectParent(project)}/rulesets/${rulesetId}`;

export const releaseResourceName = (project: string, releaseId: string) =>
  `${projectParent(project)}/releases/${releaseId}`;

export const expandRulesetName = (project: string, value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/")) return trimmed;
  return rulesetResourceName(project, trimmed);
};

export const rulesetIdOf = (name: string) => {
  const marker = "/rulesets/";
  const index = name.indexOf(marker);
  return index >= 0 ? name.slice(index + marker.length) : lastSegment(name);
};

export const releaseIdOf = (name: string) => {
  const marker = "/releases/";
  const index = name.indexOf(marker);
  return index >= 0 ? name.slice(index + marker.length) : lastSegment(name);
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const markerOf = (labels: Record<string, string>) =>
  `// [alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

const OWNERSHIP_LINE = /^\/\/ \[alchemy [^\]]*\]\r?\n?/;

export const stripOwnershipLine = (content: string | undefined): string =>
  (content ?? "").replace(OWNERSHIP_LINE, "");

export const parseOwnership = (
  content: string | undefined,
): {
  labels: Record<string, string>;
  content: string;
} => {
  const raw = content ?? "";
  if (!raw.startsWith("// [alchemy ")) {
    return { labels: {}, content: raw };
  }
  const end = raw.indexOf("]");
  if (end < 0) return { labels: {}, content: raw };
  const labels: Record<string, string> = {};
  for (const part of raw.slice("// [alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { labels, content: stripOwnershipLine(raw) };
};

export const hasOwnershipMarker = (content: string | undefined) =>
  Object.keys(parseOwnership(content).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sourceHasOwnership = (
  source: firebaserules.Source | RulesetSource | undefined,
) => (source?.files ?? []).some((file) => hasOwnershipMarker(file.content));

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (
  id: string,
  source: firebaserules.Source | RulesetSource | undefined,
) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const file = (source?.files ?? []).find((item) =>
      hasOwnershipMarker(item.content),
    );
    if (file === undefined) return false;
    const { labels } = parseOwnership(file.content);
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const toUserFiles = (
  files: readonly firebaserules.File[] | readonly RulesetFile[] | undefined,
): RulesetFile[] =>
  (files ?? []).map((file) => ({
    name: file.name ?? "firestore.rules",
    content: stripOwnershipLine(file.content),
    fingerprint: file.fingerprint,
  }));

export const stampSource = (
  source: RulesetSource,
  labels: Record<string, string>,
): firebaserules.Source => {
  const marker = markerOf(labels);
  const files =
    source.files.length > 0
      ? source.files
      : [{ name: "firestore.rules", content: "" }];
  return {
    files: files.map((file, index) => {
      const content = stripOwnershipLine(file.content);
      return {
        name: file.name,
        fingerprint: file.fingerprint,
        content: index === 0 ? `${marker}\n${content}` : content,
      };
    }),
  };
};

export const sourceFingerprint = (
  files: readonly firebaserules.File[] | readonly RulesetFile[] | undefined,
) =>
  JSON.stringify(
    toUserFiles(files)
      .map((file) => ({
        name: file.name,
        content: file.content,
        fingerprint: file.fingerprint ?? "",
      }))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

export const toReleaseId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_RELEASE_ID_LENGTH - GENERATED_RELEASE_PREFIX.length,
      lowercase: true,
    });
    return `${GENERATED_RELEASE_PREFIX}${generated}`.slice(
      0,
      MAX_RELEASE_ID_LENGTH,
    );
  });

export const isGeneratedReleaseId = (releaseId: string | undefined) =>
  (releaseId ?? "").startsWith(GENERATED_RELEASE_PREFIX);

export const getRuleset = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebaserules
        .getProjectsRulesets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getRelease = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebaserules
        .getProjectsReleases({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRulesetMetas = (project: string) =>
  firebaserules.listProjectsRulesets
    .pages({
      name: projectParent(project),
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.rulesets ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const listFullRulesets = (project: string) =>
  Effect.gen(function* () {
    const metas = yield* listRulesetMetas(project);
    const loaded = yield* Effect.forEach(
      metas,
      (ruleset) => getRuleset(ruleset.name ?? ""),
      { concurrency: 8 },
    );
    return loaded.filter(
      (ruleset): ruleset is firebaserules.Ruleset => ruleset !== undefined,
    );
  });

export const listOwnedRulesets = (project: string) =>
  Effect.gen(function* () {
    const rulesets = yield* listFullRulesets(project);
    return rulesets.filter((ruleset) => sourceHasOwnership(ruleset.source));
  });

export const findOwnedRuleset = (
  rulesets: readonly firebaserules.Ruleset[],
  id: string,
  existingName: string | undefined,
) =>
  Effect.gen(function* () {
    if (existingName) {
      const hit = rulesets.find((ruleset) => ruleset.name === existingName);
      if (hit) return hit;
    }
    for (const ruleset of rulesets) {
      if (yield* ownedByAlchemy(id, ruleset.source)) {
        return ruleset;
      }
    }
    return undefined;
  });

export const listReleases = (project: string) =>
  firebaserules.listProjectsReleases
    .pages({
      name: projectParent(project),
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.releases ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
