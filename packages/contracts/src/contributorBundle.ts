import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadSpecialistKey } from "./threadSpecialist.ts";

/**
 * Repo-shipped specialist recipe: a small specialist roster plus the project-world
 * map maintainers want every specialist to share. Distinct from built-in Workshop,
 * which carries no checkout-specific orientation. Installed through the same
 * "Add specialists from template" action as Workshop.
 */
export const CONTRIBUTOR_BUNDLE_FILE_NAME = "t3.contributor-bundle.json";

export const CONTRIBUTOR_BUNDLE_SCHEMA_URL = "https://t3.codes/schema/contributor-bundle.json";

const CONTRIBUTOR_BUNDLE_PATH_MAX_LENGTH = 512;
const CONTRIBUTOR_BUNDLE_MAX_MAP_ENTRIES = 50;
const CONTRIBUTOR_BUNDLE_MAX_SEATS = 12;

const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const ContributorBundleMapEntry = Schema.Struct({
  path: trimmedNonEmpty(
    {
      description: 'Workspace-relative path or area label (e.g. "apps/server" or "docs/user").',
    },
    CONTRIBUTOR_BUNDLE_PATH_MAX_LENGTH,
  ),
  purpose: trimmedNonEmpty({
    description: "What a contributor should know about this area of the project.",
  }),
}).annotate({
  description: "One entry in the project map shipped with the contributor bundle.",
});
export type ContributorBundleMapEntry = typeof ContributorBundleMapEntry.Type;

export const ContributorBundleOrientation = Schema.Struct({
  summary: trimmedNonEmpty({
    description: "Short project-world briefing every specialist should share.",
  }),
  map: Schema.optionalKey(
    Schema.Array(ContributorBundleMapEntry)
      .annotate({
        description: "Project map: paths and why they matter for contributors.",
      })
      .check(Schema.isMaxLength(CONTRIBUTOR_BUNDLE_MAX_MAP_ENTRIES)),
  ),
  guidance: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "Working agreements for agents in this checkout (verify commands, PR habits, traps).",
    }),
  ),
}).annotate({
  description: "Checkout-specific orientation that generic Workshop specialists do not include.",
});
export type ContributorBundleOrientation = typeof ContributorBundleOrientation.Type;

export const ContributorBundleSeat = Schema.Struct({
  id: ThreadSpecialistKey.annotate({
    description: 'Stable specialist key within the bundle (e.g. "lead", "builder").',
  }),
  title: trimmedNonEmpty({
    description: "Thread title and specialist label when the bundle is installed.",
  }),
  roleBrief: trimmedNonEmpty({
    description: "Role instructions for this specialist, written for this repository.",
  }),
}).annotate({
  description: "One durable specialist the bundle installs as a pinned thread binding.",
});
export type ContributorBundleSeat = typeof ContributorBundleSeat.Type;

export const ContributorBundle = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${CONTRIBUTOR_BUNDLE_SCHEMA_URL}".`,
    }),
  ),
  name: trimmedNonEmpty({
    description: "Display name for the contributor bundle.",
  }),
  description: Schema.optionalKey(
    trimmedNonEmpty({
      description: "One-line summary of who the bundle is for.",
    }),
  ),
  orientation: ContributorBundleOrientation,
  seats: Schema.Array(ContributorBundleSeat)
    .annotate({
      description: "Specialists installed as durable pinned bindings. First entry is the lead.",
    })
    .check(Schema.isMinLength(1), Schema.isMaxLength(CONTRIBUTOR_BUNDLE_MAX_SEATS)),
}).annotate({
  title: "T3 contributor bundle",
  description:
    "Checked-in specialists + project orientation for T3 Code (t3.contributor-bundle.json). Add from the command palette after opening the repository.",
});
export type ContributorBundle = typeof ContributorBundle.Type;
