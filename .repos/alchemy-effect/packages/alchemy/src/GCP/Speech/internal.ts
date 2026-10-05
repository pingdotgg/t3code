import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys } from "../Labels.ts";

/** Speech-to-Text v1 Adaptation is served from the global endpoint. */
export const DEFAULT_LOCATION = "global";
/** The global Speech endpoint only serves the `global` location. */
export const LIST_LOCATIONS = ["global"] as const;
export const MAX_ID_LENGTH = 63;
export const MAX_ITEM_LENGTH = 100;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Speech.ResourceNotResolved",
)<{
  name: string;
}> {}

export const parseOwnershipMarker = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  const value = text?.trim() ?? "";
  if (!value.startsWith("alc ")) {
    return { labels: {}, text };
  }
  const parts = value.slice("alc ".length).trim().split(/\s+/);
  const labels: Record<string, string> = {};
  if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
  if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
  if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
  return { labels, text: undefined };
};

export const isOwnershipMarker = (text: string | undefined) =>
  (text ?? "").trim().startsWith("alc ");

export const hasOwnershipMarker = (text: string | undefined) => {
  const { labels } = parseOwnershipMarker(text);
  return Object.keys(labels).some((key) => key.startsWith("alchemy-"));
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const resourceNameOf = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => {
  if (id.length === 0) return "";
  if (id.includes(`/${collection}/`)) return id.replace(/\/+$/, "");
  return `${locationParent(project, location)}/${collection}/${lastSegment(id)}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
}) => {
  const previousLocation =
    input.previousLocation !== undefined
      ? normalizeLocation(input.previousLocation)
      : undefined;
  const nextLocation =
    input.nextLocation !== undefined
      ? normalizeLocation(input.nextLocation)
      : undefined;
  const replace =
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    (previousLocation !== undefined &&
      nextLocation !== undefined &&
      previousLocation !== nextLocation);
  if (!replace) return undefined;
  const samePhysical =
    (previousLocation === undefined || previousLocation === nextLocation) &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return lastSegment(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_ID_LENGTH,
      lowercase: true,
    });
    let next = generated.replace(/-+$/g, "").replace(/^-+/g, "");
    if (!/^[a-z]/.test(next)) {
      next = `s${next}`.slice(0, MAX_ID_LENGTH);
    }
    if (next.length < 4) {
      next = `${next}xxxx`.slice(0, MAX_ID_LENGTH);
    }
    if (!/[a-z0-9]$/.test(next)) {
      next = `${next.slice(0, Math.max(0, MAX_ID_LENGTH - 1))}x`;
    }
    return next;
  });

export type ClassItem = {
  value: string;
};

export type Phrase = {
  value: string;
  boost?: number;
};

export const markerFromItems = (
  items: readonly { value?: string }[] | null | undefined,
) => (items ?? []).find((item) => isOwnershipMarker(item.value))?.value;

export const markerFromPhrases = (
  phrases: readonly { value?: string }[] | null | undefined,
) => (phrases ?? []).find((phrase) => isOwnershipMarker(phrase.value))?.value;

export const stripOwnershipItems = (
  items: readonly { value?: string }[] | null | undefined,
): ClassItem[] =>
  (items ?? [])
    .filter((item) => !isOwnershipMarker(item.value))
    .map((item) => ({ value: item.value ?? "" }))
    .filter((item) => item.value.length > 0);

export const stripOwnershipPhrases = (
  phrases: readonly { value?: string; boost?: number }[] | null | undefined,
): Phrase[] =>
  (phrases ?? [])
    .filter((phrase) => !isOwnershipMarker(phrase.value))
    .map((phrase) => ({
      value: phrase.value ?? "",
      boost: phrase.boost,
    }))
    .filter((phrase) => phrase.value.length > 0);

export const sameItems = (
  left: readonly { value?: string }[] | undefined,
  right: readonly { value?: string }[] | undefined,
) =>
  sameJson(
    stripOwnershipItems(left)
      .map((item) => item.value)
      .sort(),
    stripOwnershipItems(right)
      .map((item) => item.value)
      .sort(),
  );

export const samePhrases = (
  left: readonly { value?: string; boost?: number }[] | undefined,
  right: readonly { value?: string; boost?: number }[] | undefined,
) =>
  sameJson(
    stripOwnershipPhrases(left)
      .map((phrase) => ({
        value: phrase.value,
        boost: phrase.boost ?? 0,
      }))
      .sort((a, b) => a.value.localeCompare(b.value)),
    stripOwnershipPhrases(right)
      .map((phrase) => ({
        value: phrase.value,
        boost: phrase.boost ?? 0,
      }))
      .sort((a, b) => a.value.localeCompare(b.value)),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.Speech.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): Item[] => Array.from(chunk)),
  );

export const getCustomClass = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : speech
        .getProjectsLocationsCustomClasses({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getPhraseSet = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : speech
        .getProjectsLocationsPhraseSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listCustomClassesAt = (parent: string) =>
  parent.length === 0
    ? emptyList<speech.CustomClass>()
    : collectPages(
        speech.listProjectsLocationsCustomClasses.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.customClasses,
      ).pipe(
        Effect.catchTag("NotFound", () => emptyList<speech.CustomClass>()),
      );

export const listPhraseSetsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<speech.PhraseSet>()
    : collectPages(
        speech.listProjectsLocationsPhraseSets.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.phraseSets,
      ).pipe(Effect.catchTag("NotFound", () => emptyList<speech.PhraseSet>()));

const listLocationParents = (project: string) =>
  LIST_LOCATIONS.map((location) => locationParent(project, location));

export const listProjectCustomClasses = (project: string) =>
  Effect.gen(function* () {
    const groups = yield* Effect.forEach(
      listLocationParents(project),
      listCustomClassesAt,
      { concurrency: 2 },
    );
    const seen = new Set<string>();
    const classes: speech.CustomClass[] = [];
    for (const customClass of groups.flat()) {
      const name = customClass.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      classes.push(customClass);
    }
    return classes;
  });

export const listProjectPhraseSets = (project: string) =>
  Effect.gen(function* () {
    const groups = yield* Effect.forEach(
      listLocationParents(project),
      listPhraseSetsAt,
      { concurrency: 2 },
    );
    const seen = new Set<string>();
    const phraseSets: speech.PhraseSet[] = [];
    for (const phraseSet of groups.flat()) {
      const name = phraseSet.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      phraseSets.push(phraseSet);
    }
    return phraseSets;
  });

/**
 * Classes and phrase sets have no labels. Only ones stamped with a legacy
 * `alc …` ownership item by earlier Alchemy versions are discoverable here;
 * current ones are tracked through state alone.
 */
export const listOwnedCustomClasses = (project: string) =>
  listProjectCustomClasses(project).pipe(
    Effect.map((classes) =>
      classes.filter((customClass) =>
        hasOwnershipMarker(markerFromItems(customClass.items)),
      ),
    ),
  );

export const listOwnedPhraseSets = (project: string) =>
  listProjectPhraseSets(project).pipe(
    Effect.map((phraseSets) =>
      phraseSets.filter((phraseSet) =>
        hasOwnershipMarker(markerFromPhrases(phraseSet.phrases)),
      ),
    ),
  );

export const deleteCustomClass = (name: string) =>
  speech
    .deleteProjectsLocationsCustomClasses({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

export const deletePhraseSet = (name: string) =>
  speech
    .deleteProjectsLocationsPhraseSets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
