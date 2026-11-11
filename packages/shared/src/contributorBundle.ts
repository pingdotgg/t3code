import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ContributorBundle,
  CONTRIBUTOR_BUNDLE_SCHEMA_URL,
  type ContributorBundleOrientation,
  type ContributorBundleSeat,
} from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const ContributorBundleFromJson = fromLenientJson(ContributorBundle);

const decodeContributorBundle = Schema.decodeExit(ContributorBundleFromJson);

export function parseContributorBundle(contents: string): ContributorBundle | null {
  const decoded = decodeContributorBundle(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildContributorBundleJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(ContributorBundle, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CONTRIBUTOR_BUNDLE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}

export function formatContributorBundleOrientation(
  orientation: ContributorBundleOrientation,
): string {
  const lines = [orientation.summary];
  if (orientation.map !== undefined && orientation.map.length > 0) {
    lines.push("", "Project map:");
    for (const entry of orientation.map) {
      lines.push(`- ${entry.path}: ${entry.purpose}`);
    }
  }
  if (orientation.guidance !== undefined) {
    lines.push("", "Guidance:", orientation.guidance);
  }
  return lines.join("\n");
}

export function formatContributorBundleSeatBrief(
  seat: ContributorBundleSeat,
  orientation: ContributorBundleOrientation,
): string {
  return [
    seat.roleBrief,
    "",
    "## Project orientation",
    formatContributorBundleOrientation(orientation),
  ].join("\n");
}

export function formatContributorBundleLeadPrompt(bundle: ContributorBundle): string {
  const [lead, ...specialists] = bundle.seats;
  const lines = [
    `You are the lead for the "${bundle.name}" contributor bundle in this repository.`,
  ];
  if (lead !== undefined) {
    lines.push("", lead.roleBrief);
  }
  lines.push("", "## Project orientation", formatContributorBundleOrientation(bundle.orientation));
  if (specialists.length > 0) {
    lines.push("", "Pinned teammates:");
    for (const seat of specialists) {
      lines.push(`- ${seat.title}: ${seat.roleBrief}`);
    }
  }
  lines.push(
    "",
    "Ask what outcome I want, then coordinate the specialist seats. Prefer delegating specialist work over doing it yourself. Keep the project orientation in mind for every assignment.",
  );
  return lines.join("\n");
}
