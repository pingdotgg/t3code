import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  updateMaskOf,
} from "./ownership.ts";

export type PhraseMatcherType =
  | "PHRASE_MATCHER_TYPE_UNSPECIFIED"
  | "ALL_OF"
  | "ANY_OF";

export type PhraseMatcherRole =
  | "ROLE_UNSPECIFIED"
  | "HUMAN_AGENT"
  | "AUTOMATED_AGENT"
  | "END_USER"
  | "ANY_AGENT";

export type PhraseMatchRuleGroupType =
  | "PHRASE_MATCH_RULE_GROUP_TYPE_UNSPECIFIED"
  | "ALL_OF"
  | "ANY_OF";

export type ExactMatchConfig = {
  /** Whether matching is case sensitive. */
  caseSensitive?: boolean;
};

export type PhraseMatchRule = {
  /** Phrase or regex to match. */
  query?: string;
  /** When true, the phrase must be absent from the transcript. */
  negated?: boolean;
  /** Match configuration. */
  config?: {
    /** Exact-match options. */
    exactMatchConfig?: ExactMatchConfig;
  };
};

export type PhraseMatchRuleGroup = {
  /** How rules in this group combine (`ALL_OF` or `ANY_OF`). */
  type?: PhraseMatchRuleGroupType;
  /** Phrase match rules in this group. */
  phraseMatchRules?: PhraseMatchRule[];
};

export type PhraseMatcherProps = {
  /**
   * Phrase matcher id (the `{phrase_matcher}` segment of
   * `projects/{project}/locations/{location}/phraseMatchers/{phrase_matcher}`).
   * If omitted, a unique id is generated. Immutable — changing it replaces
   * the matcher.
   */
  phraseMatcherId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * matcher. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Phrase matchers have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * How rule groups combine. Required by the API.
   * @default "ALL_OF"
   */
  type?: PhraseMatcherType;
  /**
   * When true, the matcher is applied to conversations.
   * @default false
   */
  active?: boolean;
  /**
   * Speaker role whose utterances this matcher evaluates.
   */
  roleMatch?: PhraseMatcherRole;
  /**
   * Custom version tag. Defaults to the server revision id when omitted.
   */
  versionTag?: string;
  /**
   * Phrase match rule groups.
   */
  phraseMatchRuleGroups?: PhraseMatchRuleGroup[];
};

export type PhraseMatcher = Resource<
  "GCP.ContactCenterInsights.PhraseMatcher",
  PhraseMatcherProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/phraseMatchers/{phrase_matcher}`. */
    name: string;
    /** Phrase matcher id (last path segment). */
    phraseMatcherId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** How rule groups combine. */
    type: string | undefined;
    /** Whether the matcher is active. */
    active: boolean;
    /** Speaker role match. */
    roleMatch: string | undefined;
    /** Custom version tag. */
    versionTag: string | undefined;
    /** Phrase match rule groups. */
    phraseMatchRuleGroups: PhraseMatchRuleGroup[] | undefined;
    /** Server revision id. */
    revisionId: string | undefined;
    /** RFC3339 revision create timestamp. */
    revisionCreateTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 last activation-status change. */
    activationUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights phrase matcher that flags conversations
 * containing configured phrases.
 *
 * Phrase matchers have no labels field — Alchemy stamps ownership into
 * the display name so `list` / nuke can find them. Location and id are
 * immutable. Display name, type, active flag, role, version tag, and
 * rule groups update in place.
 *
 * ### Creating a Phrase Matcher
 * **Example:** Inactive exact-match matcher
 * ```typescript
 * const matcher = yield* GCP.ContactCenterInsights.PhraseMatcher("Refunds", {
 *   displayName: "refunds",
 *   type: "ALL_OF",
 *   active: false,
 *   phraseMatchRuleGroups: [
 *     {
 *       type: "ANY_OF",
 *       phraseMatchRules: [
 *         {
 *           query: "refund",
 *           config: { exactMatchConfig: { caseSensitive: false } },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const PhraseMatcher = Resource<PhraseMatcher>(
  "GCP.ContactCenterInsights.PhraseMatcher",
);

export class PhraseMatcherNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.PhraseMatcherNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_TYPE: PhraseMatcherType = "ALL_OF";

const resourceName = (
  project: string,
  location: string,
  phraseMatcherId: string,
) => `${locationParent(project, location)}/phraseMatchers/${phraseMatcherId}`;

const groupsOf = (
  groups:
    | cci.GoogleCloudContactcenterinsightsV1PhraseMatchRuleGroupList
    | undefined,
): PhraseMatchRuleGroup[] | undefined => {
  if (groups === undefined) return undefined;
  return groups.map((group) => ({
    type: group.type as PhraseMatchRuleGroupType | undefined,
    phraseMatchRules: group.phraseMatchRules?.map((rule) => ({
      query: rule.query,
      negated: rule.negated,
      config: rule.config
        ? {
            exactMatchConfig: rule.config.exactMatchConfig
              ? {
                  caseSensitive: rule.config.exactMatchConfig.caseSensitive,
                }
              : undefined,
          }
        : undefined,
    })),
  }));
};

const toAttrs = (
  matcher: cci.GoogleCloudContactcenterinsightsV1PhraseMatcher,
  project: string,
) => {
  const name = matcher.name ?? "";
  const parsed = parseOwnership(matcher.displayName);
  return {
    name,
    phraseMatcherId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    type: matcher.type,
    active: matcher.active === true,
    roleMatch: matcher.roleMatch,
    versionTag: matcher.versionTag,
    phraseMatchRuleGroups: groupsOf(matcher.phraseMatchRuleGroups),
    revisionId: matcher.revisionId,
    revisionCreateTime: matcher.revisionCreateTime,
    updateTime: matcher.updateTime,
    activationUpdateTime: matcher.activationUpdateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsPhraseMatchers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsPhraseMatchers.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.phraseMatchers ?? [])),
    Stream.filter((matcher) => hasOwnershipMarker(matcher.displayName)),
    Stream.map((matcher) => toAttrs(matcher, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findByDisplayName = (parent: string, displayName: string) =>
  cci.listProjectsLocationsPhraseMatchers.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.phraseMatchers ?? [])),
    Stream.filter((matcher) => matcher.displayName === displayName),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const PhraseMatcherProvider = () =>
  Provider.succeed(PhraseMatcher, {
    stables: [
      "name",
      "phraseMatcherId",
      "location",
      "project",
      "revisionCreateTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.phraseMatcherId ?? output?.phraseMatcherId;
      if (
        previousId !== undefined &&
        news.phraseMatcherId !== undefined &&
        news.phraseMatcherId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const knownId = olds?.phraseMatcherId ?? output?.phraseMatcherId;
      const name =
        output?.name ??
        (knownId ? resourceName(env.project, location, knownId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          locationParent(env.project, location),
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(env.project, location);
      const knownId = news.phraseMatcherId ?? output?.phraseMatcherId;
      const name =
        output?.name ??
        (knownId ? resourceName(env.project, location, knownId) : "");
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const type = news.type ?? DEFAULT_TYPE;
      const active = news.active === true;
      const phraseMatchRuleGroups = news.phraseMatchRuleGroups;

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsPhraseMatchers({
            parent,
            body: {
              displayName,
              type,
              active,
              roleMatch: news.roleMatch,
              versionTag: news.versionTag,
              phraseMatchRuleGroups,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(parent, displayName),
            ),
          );
        current = created ?? (yield* findByDisplayName(parent, displayName));
      }

      if (current === undefined) {
        return yield* new PhraseMatcherNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const typeChanged = (current.type ?? DEFAULT_TYPE) !== type;
      const activeChanged = (current.active === true) !== active;
      const roleChanged = !sameText(current.roleMatch, news.roleMatch);
      const versionChanged = !sameText(current.versionTag, news.versionTag);
      const groupsChanged = !jsonEqual(
        groupsOf(current.phraseMatchRuleGroups),
        phraseMatchRuleGroups,
      );

      if (
        displayChanged ||
        typeChanged ||
        activeChanged ||
        roleChanged ||
        versionChanged ||
        groupsChanged
      ) {
        current = yield* cci.patchProjectsLocationsPhraseMatchers({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            typeChanged ? "type" : undefined,
            activeChanged ? "active" : undefined,
            roleChanged ? "role_match" : undefined,
            versionChanged ? "version_tag" : undefined,
            groupsChanged ? "phrase_match_rule_groups" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            type,
            active,
            roleMatch: news.roleMatch,
            versionTag: news.versionTag,
            phraseMatchRuleGroups,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsPhraseMatchers({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
