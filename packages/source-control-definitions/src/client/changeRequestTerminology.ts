import {
  type ChangeRequestTerminology,
  type SourceControlDefinition,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const PULL_REQUEST: ChangeRequestTerminology = {
  shortLabel: msg("PR", { $context: "abbreviation of pull request" }),
  shortLabelWithArticle: msg("a PR", { $context: "abbreviation of pull request, with article" }),
  singular: msg("pull request"),
  plural: msg("pull requests"),
};

const MERGE_REQUEST: ChangeRequestTerminology = {
  shortLabel: msg("MR", { $context: "abbreviation of merge request" }),
  shortLabelWithArticle: msg("an MR", { $context: "abbreviation of merge request, with article" }),
  singular: msg("merge request"),
  plural: msg("merge requests"),
};

const CHANGE_REQUEST: ChangeRequestTerminology = {
  shortLabel: msg("change request"),
  shortLabelWithArticle: msg("a change request"),
  singular: msg("change request"),
  plural: msg("change requests"),
};

const TERMINOLOGY_BY_KIND: ReadonlyMap<string, ChangeRequestTerminology> = new Map([
  [GitLab.definition.kind, MERGE_REQUEST],
  [UNKNOWN_SOURCE_CONTROL_CLIENT.kind, CHANGE_REQUEST],
]);

/**
 * The forge's change request words in the UI language; English matches `definition.changeRequest`.
 * @public
 */
export function changeRequestTerminology(
  definition: Pick<SourceControlDefinition, "kind">,
  resolve: MFunctionType = mFallback,
): ChangeRequestTerminology {
  const terms = TERMINOLOGY_BY_KIND.get(definition.kind) ?? PULL_REQUEST;
  return {
    shortLabel: resolve(terms.shortLabel),
    shortLabelWithArticle: resolve(terms.shortLabelWithArticle),
    singular: resolve(terms.singular),
    plural: resolve(terms.plural),
  };
}

const TOKEN_ACCESS_BY_KIND: ReadonlyMap<string, string> = new Map([
  [GitHub.definition.kind, msg("read and write access to pull requests and contents")],
]);

/**
 * What a token must be granted, completing "Give it …"; falls back to the definition's English.
 * @public
 */
export function hostTokenAccess(
  definition: Pick<SourceControlDefinition, "kind" | "credentials">,
  resolve: MFunctionType = mFallback,
): string | undefined {
  const access = TOKEN_ACCESS_BY_KIND.get(definition.kind);
  return access === undefined ? definition.credentials?.tokenAccess : resolve(access);
}
