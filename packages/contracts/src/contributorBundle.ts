import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Repo-shippable contributor competence pack: a small specialist team plus the
 * project-world map maintainers want every seat to share. Distinct from built-in
 * starter team templates, which carry no checkout-specific orientation.
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
    description: "Short project-world briefing every seat should share.",
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
  description: "Checkout-specific orientation that generic starter teams do not include.",
});
export type ContributorBundleOrientation = typeof ContributorBundleOrientation.Type;

export const ContributorBundleSeat = Schema.Struct({
  id: trimmedNonEmpty(
    {
      description: 'Stable seat id within the bundle (e.g. "lead", "builder").',
    },
    64,
  ),
  title: trimmedNonEmpty({
    description: "Thread title for this seat when the bundle is installed.",
  }),
  roleBrief: trimmedNonEmpty({
    description: "Role instructions for this seat, written for this repository.",
  }),
}).annotate({
  description: "One durable specialist seat the bundle installs as a pinned thread.",
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
      description: "Specialist seats installed as pinned project threads. First seat is the lead.",
    })
    .check(Schema.isMinLength(1), Schema.isMaxLength(CONTRIBUTOR_BUNDLE_MAX_SEATS)),
}).annotate({
  title: "T3 contributor bundle",
  description:
    "Checked-in team + project orientation for T3 Code (t3.contributor-bundle.json). Install from the command palette after opening the repository.",
});
export type ContributorBundle = typeof ContributorBundle.Type;

export const OrchestrationV2InstallContributorBundleInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Pin each seat in the project sidebar. Defaults to true. */
  pin: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2InstallContributorBundleInput =
  typeof OrchestrationV2InstallContributorBundleInput.Type;

export const OrchestrationV2InstalledContributorSeat = Schema.Struct({
  seatId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  roleBrief: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type OrchestrationV2InstalledContributorSeat =
  typeof OrchestrationV2InstalledContributorSeat.Type;

export const OrchestrationV2InstallContributorBundleResult = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  orientation: ContributorBundleOrientation,
  /** Composer draft for the lead seat: orientation + roster. */
  leadPrompt: TrimmedNonEmptyString,
  seats: Schema.Array(OrchestrationV2InstalledContributorSeat).check(Schema.isMinLength(1)),
});
export type OrchestrationV2InstallContributorBundleResult =
  typeof OrchestrationV2InstallContributorBundleResult.Type;

export class OrchestrationV2InstallContributorBundleError extends Schema.TaggedError<OrchestrationV2InstallContributorBundleError>()(
  "OrchestrationV2InstallContributorBundleError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
