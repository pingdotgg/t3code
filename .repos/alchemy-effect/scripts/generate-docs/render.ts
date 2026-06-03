import * as path from "node:path";

import type {
  BindingClassDoc,
  DirectoryCatalog,
  FileDoc,
  LinkDoc,
  ShapeDoc,
  SourceEntry,
} from "./types.ts";
import {
  docsRoot,
  escapeMarkdown,
  labelFromDocRelativePath,
  relativeDocLink,
} from "./utils.ts";

function renderLinks(links: LinkDoc[]) {
  return links.map((link) => `- [${link.label}](${link.href})`).join("\n");
}

function renderShape(
  shape: ShapeDoc | undefined,
  heading: string,
  level: "##" | "###" = "##",
) {
  if (!shape) {
    return "";
  }

  if (shape.properties.length === 0) {
    return [
      `${level} ${heading}`,
      shape.description ?? "",
      shape.signature ? ["```ts", shape.signature, "```"].join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const rows = shape.properties.map(
    (property) =>
      `| \`${escapeMarkdown(property.name)}\` | \`${escapeMarkdown(property.type)}\` | ${
        property.optional ? "optional" : "required"
      }${property.readonly ? ", readonly" : ""} | ${escapeMarkdown(
        property.defaultValue ?? "-",
      )} | ${escapeMarkdown(property.description ?? "-")} |`,
  );

  const table = [
    "| Property | Type | Flags | Default | Description |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");

  return [`${level} ${heading}`, shape.description ?? "", table]
    .filter(Boolean)
    .join("\n\n");
}

function renderBindingGroup(heading: string, items: BindingClassDoc[]) {
  if (items.length === 0) {
    return "";
  }

  return [
    `### ${heading}`,
    ...items.map((item) =>
      [
        `#### \`${item.name}\``,
        item.identifier ? `Identifier: \`${item.identifier}\`` : "",
        item.summary ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  ].join("\n\n");
}

function renderExports(fileDoc: FileDoc) {
  if (fileDoc.exports.length === 0) {
    return "";
  }

  const rows = fileDoc.exports.map(
    (entry) =>
      `| \`${escapeMarkdown(entry.name)}\` | ${entry.kind} | \`${escapeMarkdown(
        entry.signature,
      )}\` | ${escapeMarkdown(entry.summary ?? "-")} |`,
  );

  const details = fileDoc.exports
    .map((entry) =>
      [
        `### \`${entry.name}\``,
        entry.summary ?? "",
        ["```ts", entry.signature, "```"].join("\n"),
        entry.shape ? renderShape(entry.shape, entry.shape.title, "###") : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");

  return [
    "## Exports",
    "| Symbol | Kind | Signature | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    details,
  ].join("\n");
}

function renderExamples(fileDoc: FileDoc) {
  if (fileDoc.examples.length === 0 && !fileDoc.autoExample) {
    return "";
  }

  const sections = fileDoc.examples.flatMap((section) => [
    `### ${section.title}`,
    ...section.examples.flatMap((example) => [
      `#### ${example.title}`,
      example.body,
    ]),
  ]);

  if (fileDoc.autoExample) {
    sections.push(
      "### Quick Start",
      `#### ${fileDoc.autoExample.title}`,
      fileDoc.autoExample.body,
    );
  }

  return ["## Examples", ...sections].join("\n\n");
}

function renderCatalog(catalog: DirectoryCatalog) {
  const parts = ["## Navigation"];
  if (catalog.parent) {
    parts.push(`- Parent: [${catalog.parent.label}](${catalog.parent.href})`);
  }
  if (catalog.siblings.length > 0) {
    parts.push("- Siblings");
    parts.push(renderLinks(catalog.siblings));
  }
  return parts.join("\n");
}

function isPrimaryReferencePage(fileDoc: FileDoc) {
  return ["resource", "host", "operation", "event-source"].includes(
    fileDoc.fileKind,
  );
}

export function renderFileDoc(fileDoc: FileDoc) {
  const sourceHref = relativeDocLink(
    fileDoc.outputPath,
    path.join(docsRoot, "..", fileDoc.sourcePath),
  );
  const primaryReferencePage = isPrimaryReferencePage(fileDoc);

  return [
    "<!-- AUTO-GENERATED: DO NOT EDIT. Run `bun run generate:docs`. -->",
    "",
    `# ${fileDoc.title}`,
    "",
    fileDoc.summary,
    "",
    `- Source: [\`${fileDoc.sourcePath}\`](${sourceHref})`,
    renderExamples(fileDoc),
    fileDoc.resource && !primaryReferencePage
      ? [
          "## Resource Model",
          `- Resource Type: \`${fileDoc.resource.resourceType}\``,
          fileDoc.resource.providerName
            ? `- Provider Export: \`${fileDoc.resource.providerName}\``
            : "",
          fileDoc.resource.lifecycleOperations.length > 0
            ? `- Lifecycle Operations: ${fileDoc.resource.lifecycleOperations
                .map((name) => `\`${name}\``)
                .join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    renderShape(fileDoc.resource?.props, "Props"),
    renderShape(fileDoc.resource?.attributes, "Attributes"),
    renderShape(fileDoc.resource?.binding, "Binding Contract"),
    fileDoc.operation
      ? [
          "## Reference",
          renderBindingGroup("Runtime Bindings", fileDoc.operation.services),
          renderBindingGroup(
            "Deploy-Time Policies",
            fileDoc.operation.policies,
          ),
          fileDoc.operation.runtimeLayers.length > 0
            ? [
                "### Live Layers",
                fileDoc.operation.runtimeLayers
                  .map((name) => `- \`${name}\``)
                  .join("\n"),
              ].join("\n\n")
            : "",
          fileDoc.operation.supportedHosts.length > 0
            ? [
                "### Supported Hosts",
                fileDoc.operation.supportedHosts
                  .map((name) => `- \`${name}\``)
                  .join("\n"),
              ].join("\n\n")
            : "",
          ...fileDoc.operation.requestShapes.map((shape) =>
            renderShape(shape, shape.title),
          ),
        ]
          .filter(Boolean)
          .join("\n\n")
      : "",
    fileDoc.provider
      ? [
          "## Provider Exports",
          fileDoc.provider.exportedFactories
            .map((name) => `- \`${name}\``)
            .join("\n"),
        ].join("\n\n")
      : "",
    fileDoc.index && fileDoc.index.reExports.length > 0
      ? [
          "## Re-Exports",
          "| Export | Source |",
          "| --- | --- |",
          ...fileDoc.index.reExports.map((entry) => {
            const source = entry.href
              ? `[\`${entry.sourcePath}\`](${entry.href})`
              : `\`${entry.sourcePath}\``;
            return `| \`${escapeMarkdown(entry.exportName)}\` | ${source} |`;
          }),
        ].join("\n")
      : "",
    !primaryReferencePage ? renderExports(fileDoc) : "",
    !primaryReferencePage && fileDoc.relatedLinks.length > 0
      ? ["## Related Files", renderLinks(fileDoc.relatedLinks)].join("\n\n")
      : "",
    !primaryReferencePage ? renderCatalog(fileDoc.directoryCatalog) : "",
  ]
    .filter((part) => part && part.trim().length > 0)
    .join("\n\n");
}

function allDirectories(entries: SourceEntry[]) {
  const directories = new Set<string>();
  for (const entry of entries) {
    let current = path.dirname(entry.relativePath);
    while (true) {
      directories.add(current);
      if (current === ".") {
        break;
      }
      current = path.dirname(current);
    }
  }
  return [...directories].sort();
}

function hasSourceIndex(directory: string, entries: SourceEntry[]) {
  return entries.some(
    (entry) => entry.relativePath === path.join(directory, "index.ts"),
  );
}

export function syntheticIndexes(entries: SourceEntry[]) {
  return allDirectories(entries)
    .filter((directory) => !hasSourceIndex(directory, entries))
    .map((directory) => {
      const outputPath = path.join(
        docsRoot,
        directory === "." ? "index.md" : directory,
        "index.md",
      );
      const files = entries
        .filter(
          (entry) =>
            path.dirname(entry.relativePath) === directory &&
            path.basename(entry.relativePath) !== "index.ts",
        )
        .map((entry) => ({
          label: labelFromDocRelativePath(entry.relativePath),
          href: relativeDocLink(outputPath, entry.outputPath),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
      const childDirectories = allDirectories(entries)
        .filter(
          (candidate) =>
            candidate !== "." && path.dirname(candidate) === directory,
        )
        .map((candidate) => ({
          label: path.basename(candidate),
          href: relativeDocLink(
            outputPath,
            path.join(docsRoot, candidate, "index.md"),
          ),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));

      const title =
        directory === "." ? "API Reference" : path.basename(directory);
      const content = [
        "<!-- AUTO-GENERATED: DO NOT EDIT. Run `bun run generate:docs`. -->",
        "",
        `# ${title}`,
        "",
        directory === "."
          ? "Static API reference generated from `alchemy/src`."
          : `Directory index for \`src/${directory}\`.`,
        "",
        childDirectories.length > 0
          ? ["## Directories", renderLinks(childDirectories)].join("\n\n")
          : "",
        files.length > 0 ? ["## Files", renderLinks(files)].join("\n\n") : "",
      ]
        .filter((part) => part && part.trim().length > 0)
        .join("\n\n");

      return { outputPath, content };
    });
}
