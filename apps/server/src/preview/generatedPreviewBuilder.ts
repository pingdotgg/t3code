import type {
  PreviewCatalogEntry,
  PreviewControlDefinition,
  PreviewGeneratedCaseManifest,
  PreviewGenerationConfidence,
  PreviewGenerationWarning,
} from "@forma/contracts";

interface GeneratedPreviewBuildInput {
  readonly entry: PreviewCatalogEntry;
  readonly absoluteComponentPath: string;
  readonly absoluteAppRoot: string;
  readonly globalCssPath: string | null;
}

export interface GeneratedPreviewBuildResult {
  readonly label: string;
  readonly defaultCaseId: string;
  readonly confidence: PreviewGenerationConfidence;
  readonly controls: PreviewControlDefinition[];
  readonly cases: PreviewGeneratedCaseManifest[];
  readonly warnings: PreviewGenerationWarning[];
  readonly moduleSource: string;
}

interface PropAssignment {
  readonly name: string;
  readonly code: string;
}

function formatDisplayLabel(rawValue: string): string {
  return rawValue
    .split(/[-_.\s/]+/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]!.toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_$]+/g, "_");
}

function toViteFsPath(absolutePath: string): string {
  return `/@fs/${absolutePath.replaceAll("\\", "/")}`;
}

function placeholderText(label: string, name: string): string {
  if (name === "children") {
    return label;
  }
  switch (name) {
    case "label":
    case "title":
    case "name":
    case "value":
      return label;
    case "placeholder":
      return `Preview ${label.toLowerCase()}`;
    default:
      return label;
  }
}

function isInterestingEnumProp(name: string): boolean {
  return ["variant", "size", "tone", "intent", "state", "status", "kind"].includes(name);
}

function isInterestingBooleanProp(name: string): boolean {
  return ["disabled", "loading", "open", "active", "selected", "checked", "invalid"].includes(name);
}

function buildControls(entry: PreviewCatalogEntry): PreviewControlDefinition[] {
  const controls: PreviewControlDefinition[] = [];
  for (const prop of entry.propSummary) {
    switch (prop.kind) {
      case "boolean":
        controls.push({
          id: prop.name,
          label: prop.label,
          kind: "boolean",
          required: prop.required,
          defaultValue: false,
        });
        break;
      case "enum":
        controls.push({
          id: prop.name,
          label: prop.label,
          kind: "enum",
          required: prop.required,
          options: (prop.options ?? []).map((option) => ({
            value: option,
            label: formatDisplayLabel(option),
          })),
          ...(prop.options?.[0] ? { defaultValue: prop.options[0] } : {}),
        });
        break;
      case "number":
        controls.push({
          id: prop.name,
          label: prop.label,
          kind: "number",
          required: prop.required,
          defaultValue: 1,
        });
        break;
      case "text":
      case "children":
        controls.push({
          id: prop.name,
          label: prop.label,
          kind: "text",
          required: prop.required,
          defaultValue: placeholderText(entry.label, prop.name),
        });
        break;
      default:
        break;
    }
  }
  return controls;
}

function buildBaseAssignments(input: {
  readonly entry: PreviewCatalogEntry;
  readonly warnings: PreviewGenerationWarning[];
}): {
  readonly propAssignments: PropAssignment[];
  readonly defaultChildren: string | null;
} {
  const propAssignments: PropAssignment[] = [];
  let defaultChildren: string | null = null;

  for (const prop of input.entry.propSummary) {
    switch (prop.kind) {
      case "boolean":
        propAssignments.push({ name: prop.name, code: "false" });
        break;
      case "enum":
        if (prop.options?.[0]) {
          propAssignments.push({
            name: prop.name,
            code: JSON.stringify(prop.options[0]),
          });
        }
        break;
      case "number":
        propAssignments.push({ name: prop.name, code: "1" });
        break;
      case "text":
        propAssignments.push({
          name: prop.name,
          code: JSON.stringify(placeholderText(input.entry.label, prop.name)),
        });
        break;
      case "children":
        defaultChildren = placeholderText(input.entry.label, prop.name);
        break;
      case "callback":
        propAssignments.push({ name: prop.name, code: "() => undefined" });
        break;
      case "unknown":
        if (prop.required) {
          input.warnings.push({
            code: "required-prop-omitted",
            message: `Required prop "${prop.name}" could not be inferred and was omitted from the generated preview.`,
            severity: "warn",
          });
        }
        break;
    }
  }

  return { propAssignments, defaultChildren };
}

function buildCases(entry: PreviewCatalogEntry): PreviewGeneratedCaseManifest[] {
  const cases: PreviewGeneratedCaseManifest[] = [
    {
      id: "default",
      label: "Default",
    },
  ];

  for (const prop of entry.propSummary) {
    if (prop.kind === "enum" && isInterestingEnumProp(prop.name)) {
      for (const option of (prop.options ?? []).slice(1, 4)) {
        cases.push({
          id: `${sanitizeIdentifier(prop.name)}-${sanitizeIdentifier(option)}`,
          label: formatDisplayLabel(option),
        });
      }
      continue;
    }

    if (prop.kind === "boolean" && isInterestingBooleanProp(prop.name)) {
      cases.push({
        id: sanitizeIdentifier(prop.name),
        label: formatDisplayLabel(prop.name),
      });
    }
  }

  return cases;
}

function buildCaseOverrides(entry: PreviewCatalogEntry): Record<string, Record<string, string>> {
  const overrides: Record<string, Record<string, string>> = {
    default: {},
  };

  for (const prop of entry.propSummary) {
    if (prop.kind === "enum" && isInterestingEnumProp(prop.name)) {
      for (const option of (prop.options ?? []).slice(1, 4)) {
        overrides[`${sanitizeIdentifier(prop.name)}-${sanitizeIdentifier(option)}`] = {
          [prop.name]: JSON.stringify(option),
        };
      }
      continue;
    }

    if (prop.kind === "boolean" && isInterestingBooleanProp(prop.name)) {
      overrides[sanitizeIdentifier(prop.name)] = {
        [prop.name]: "true",
      };
    }
  }

  return overrides;
}

function confidenceFor(
  warnings: ReadonlyArray<PreviewGenerationWarning>,
): PreviewGenerationConfidence {
  const severeWarnings = warnings.filter((warning) => warning.severity === "warn").length;
  if (severeWarnings === 0) {
    return "high";
  }
  if (severeWarnings === 1) {
    return "medium";
  }
  return "low";
}

export function buildGeneratedPreview(
  input: GeneratedPreviewBuildInput,
): GeneratedPreviewBuildResult {
  const warnings: PreviewGenerationWarning[] = [];
  const controls = buildControls(input.entry);
  const cases = buildCases(input.entry);
  const caseOverrides = buildCaseOverrides(input.entry);
  const { defaultChildren, propAssignments } = buildBaseAssignments({
    entry: input.entry,
    warnings,
  });
  const resolvedDefaultChildren = defaultChildren ?? input.entry.label;
  const componentImportPath = JSON.stringify(toViteFsPath(input.absoluteComponentPath));
  const globalCssImport = input.globalCssPath
    ? `import ${JSON.stringify(toViteFsPath(input.globalCssPath))};\n`
    : "";
  const componentImport =
    input.entry.exportName === "default"
      ? `import PreviewComponent from ${componentImportPath};`
      : `import { ${input.entry.exportName} as PreviewComponent } from ${componentImportPath};`;
  const propAssignmentCode =
    propAssignments.length > 0
      ? propAssignments
          .map((assignment) => `  ${JSON.stringify(assignment.name)}: ${assignment.code},`)
          .join("\n")
      : "";
  const controlOverrideCode = controls
    .filter((control) => control.id !== "children")
    .map(
      (control) =>
        `  if (Object.prototype.hasOwnProperty.call(controls, ${JSON.stringify(control.id)})) {\n    props[${JSON.stringify(control.id)}] = controls[${JSON.stringify(control.id)}];\n  }`,
    )
    .join("\n");
  const caseOverrideCode = Object.entries(caseOverrides)
    .map(([caseId, overrides]) => {
      const assignmentLines = Object.entries(overrides)
        .map(([propName, code]) => `      ${JSON.stringify(propName)}: ${code},`)
        .join("\n");
      return `    ${JSON.stringify(caseId)}: {\n${assignmentLines}\n    },`;
    })
    .join("\n");
  const caseRenderCode = cases
    .map(
      (previewCase) =>
        `    ${JSON.stringify(previewCase.id)}: {\n      label: ${JSON.stringify(
          previewCase.label,
        )},\n      render: (context) => renderPreviewCase(${JSON.stringify(previewCase.id)}, context),\n    },`,
    )
    .join("\n");
  const moduleSource = `
import React from "react";
${globalCssImport}${componentImport}
import { definePreview } from "@forma/preview-react";

const BASE_PROPS = {
${propAssignmentCode}
};

const CASE_OVERRIDES = {
${caseOverrideCode}
};

function renderPreviewCase(caseId, context) {
  const controls = context?.controls ?? {};
  const props = {
    ...BASE_PROPS,
    ...(CASE_OVERRIDES[caseId] ?? {}),
  };
${controlOverrideCode}
  const children = Object.prototype.hasOwnProperty.call(controls, "children")
    ? controls.children
    : ${JSON.stringify(resolvedDefaultChildren)};
  return React.createElement(PreviewComponent, props, children);
}

export default definePreview({
  label: ${JSON.stringify(input.entry.label)},
  cases: {
${caseRenderCode}
  },
});
`.trim();

  return {
    label: input.entry.label,
    defaultCaseId: "default",
    confidence: confidenceFor(warnings),
    controls,
    cases,
    warnings,
    moduleSource,
  };
}

export function buildLegacyPreviewModuleSource(absolutePreviewPath: string): string {
  return `
import previewDefinition from ${JSON.stringify(toViteFsPath(absolutePreviewPath))};

export default previewDefinition;
`.trim();
}
