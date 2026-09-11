import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import {
  markdownLineEnding,
  unicodePunctuation,
  unicodeWhitespace,
} from "micromark-util-character";
import type { Construct, Extension, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

import {
  codexArtifactTemplatePresentationLabel,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from "./codexArtifactTemplates.ts";
import { codexFileCitationMarkdown, resolveCodexFileCitationLink } from "./codexFileCitations.ts";

const COLON = 58;
const DASH = 45;
const UNDERSCORE = 95;
const CODEX_FILE_CITATION_NAME = "codex-file-citation";
const CODEX_ARTIFACT_TEMPLATE_NAME = "artifact-template";

export const CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES = [
  "dataCodexArtifactTemplate",
  "dataArtifactKind",
  "dataDisplayName",
  "dataGalleryKind",
  "dataSkillDirectory",
  "dataSkillName",
] as const;

interface MarkdownPosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

interface MarkdownAstNode {
  type?: string;
  name?: string;
  value?: string;
  url?: string;
  attributes?: Readonly<Record<string, string | null>>;
  position?: MarkdownPosition;
  data?: {
    codexArtifactTemplate?: CodexArtifactTemplate;
    codexFileCitationMarkdown?: string;
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value: unknown;
}

export type CodexArtifactTemplateMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "artifact-template";
      readonly sourceOffset: number;
      readonly template: CodexArtifactTemplate;
    };

function asConstruct(value: Construct | Construct[] | undefined, label: string): Construct {
  const construct = Array.isArray(value) ? value[0] : value;
  if (!construct) throw new Error(`Missing ${label} directive construct`);
  return construct;
}

function directiveNameEnds(code: number | null): boolean {
  return (
    code === null ||
    markdownLineEnding(code) ||
    unicodeWhitespace(code) ||
    (unicodePunctuation(code) && code !== DASH && code !== UNDERSCORE)
  );
}

function directiveNameGate(markerCount: number, name: string): Construct {
  const tokenize: Tokenizer = (effects, ok, nok) => {
    let markerIndex = 0;
    let nameIndex = 0;

    return marker;

    function marker(code: number | null) {
      if (code !== COLON) return nok(code);
      if (markerIndex === 0) effects.enter("data");
      effects.consume(code);
      markerIndex += 1;
      return markerIndex === markerCount ? nameCharacter : marker;
    }

    function nameCharacter(code: number | null) {
      if (code !== name.charCodeAt(nameIndex)) return nok(code);
      effects.consume(code);
      nameIndex += 1;
      return nameIndex === name.length ? afterName : nameCharacter;
    }

    function afterName(code: number | null) {
      effects.exit("data");
      return directiveNameEnds(code) ? ok(code) : nok(code);
    }
  };

  return { partial: true, tokenize };
}

function restrictedDirective(construct: Construct, markerCount: number, name: string): Construct {
  const gate = directiveNameGate(markerCount, name);
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      return effects.check(gate, construct.tokenize.call(this, effects, ok, nok), nok);
    },
  };
}

function codexDirectiveSyntax(): Extension {
  const genericSyntax = directive();
  const textDirective = asConstruct(genericSyntax.text?.[COLON], CODEX_FILE_CITATION_NAME);
  const flowDirectives = genericSyntax.flow?.[COLON];
  const leafDirective = Array.isArray(flowDirectives)
    ? flowDirectives.find((construct) => construct.concrete !== true)
    : flowDirectives;
  if (!leafDirective)
    throw new Error(`Missing ${CODEX_ARTIFACT_TEMPLATE_NAME} directive construct`);

  return {
    text: {
      [COLON]: restrictedDirective(textDirective, 1, CODEX_FILE_CITATION_NAME),
    },
    flow: {
      [COLON]: restrictedDirective(leafDirective, 2, CODEX_ARTIFACT_TEMPLATE_NAME),
    },
  };
}

const CODEX_DIRECTIVE_SYNTAX = codexDirectiveSyntax();
const CODEX_DIRECTIVE_FROM_MARKDOWN = directiveFromMarkdown();

function sourceForNode(node: MarkdownAstNode, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

function sourceForDirective(node: MarkdownAstNode, source: string, marker: ":" | "::"): string {
  const prefix = `${marker}${node.name ?? ""}`;
  const slicedSource = sourceForNode(node, source);
  if (slicedSource.startsWith(prefix)) return slicedSource;

  const attributes = Object.entries(node.attributes ?? {}).map(([name, value]) =>
    value === null ? name : `${name}=${JSON.stringify(value)}`,
  );
  return `${prefix}${attributes.length === 0 ? "" : `{${attributes.join(" ")}}`}`;
}

function restoreTextDirective(node: MarkdownAstNode, source: string): void {
  node.type = "text";
  node.value = sourceForDirective(node, source, ":");
  delete node.name;
  delete node.attributes;
  delete node.url;
  delete node.data;
  delete node.children;
}

function restoreLeafDirective(node: MarkdownAstNode, source: string): void {
  const value = sourceForDirective(node, source, "::");
  node.type = "paragraph";
  node.children = [
    { type: "text", value, ...(node.position === undefined ? {} : { position: node.position }) },
  ];
  delete node.name;
  delete node.attributes;
  delete node.value;
  delete node.url;
  delete node.data;
}

function renderFileCitation(node: MarkdownAstNode, source: string, insideLink: boolean): void {
  const citation = resolveCodexFileCitationLink(node.attributes);
  if (!citation || insideLink) {
    restoreTextDirective(node, source);
    return;
  }

  node.type = "link";
  node.url = citation.href;
  node.children = [{ type: "text", value: citation.label }];
  node.data = { codexFileCitationMarkdown: codexFileCitationMarkdown(citation) };
  delete node.name;
  delete node.attributes;
  delete node.value;
}

function renderArtifactTemplate(node: MarkdownAstNode, source: string): void {
  const template = resolveCodexArtifactTemplate(node.attributes);
  if (!template) {
    restoreLeafDirective(node, source);
    return;
  }

  node.type = "paragraph";
  node.children = [];
  node.data = {
    codexArtifactTemplate: template,
    hName: "div",
    hProperties: {
      dataCodexArtifactTemplate: "true",
      dataArtifactKind: template.artifactKind,
      dataDisplayName: template.displayName,
      ...(template.galleryKind === undefined ? {} : { dataGalleryKind: template.galleryKind }),
      dataSkillDirectory: template.skillDirectory,
      dataSkillName: template.skillName,
    },
  };
  delete node.name;
  delete node.attributes;
  delete node.value;
  delete node.url;
}

function transformCodexDirectives(node: MarkdownAstNode, source: string, insideLink = false): void {
  if (node.type === "textDirective" && node.name === CODEX_FILE_CITATION_NAME) {
    renderFileCitation(node, source, insideLink);
    return;
  }
  if (node.type === "leafDirective" && node.name === CODEX_ARTIFACT_TEMPLATE_NAME) {
    renderArtifactTemplate(node, source);
    return;
  }

  const childrenInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
  for (const child of node.children ?? []) {
    transformCodexDirectives(child, source, childrenInsideLink);
  }
}

/** Adds grammar only for the two directives emitted by Codex, then renders them as mdast. */
function attachCodexDirectives(this: Processor) {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(CODEX_DIRECTIVE_SYNTAX);
  fromMarkdownExtensions.push(CODEX_DIRECTIVE_FROM_MARKDOWN);

  return (tree: unknown, file: MarkdownFile) => {
    transformCodexDirectives(tree as MarkdownAstNode, String(file.value));
  };
}

export const remarkCodexDirectives = attachCodexDirectives;

const directiveParser = unified().use(remarkParse).use(remarkCodexDirectives).freeze();

function parseCodexMarkdown(markdown: string): MarkdownAstNode {
  return directiveParser.runSync(directiveParser.parse(markdown), {
    value: markdown,
  }) as MarkdownAstNode;
}

interface DirectiveMatch {
  readonly start: number;
  readonly end: number;
  readonly markdown?: string;
  readonly template?: CodexArtifactTemplate;
}

function collectDirectiveMatches(node: MarkdownAstNode, matches: DirectiveMatch[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    if (node.data?.codexFileCitationMarkdown !== undefined) {
      matches.push({ start, end, markdown: node.data.codexFileCitationMarkdown });
      return;
    }
    if (node.data?.codexArtifactTemplate !== undefined) {
      matches.push({ start, end, template: node.data.codexArtifactTemplate });
      return;
    }
  }
  for (const child of node.children ?? []) collectDirectiveMatches(child, matches);
}

function renderDirectiveMatches(
  markdown: string,
  replacementFor: (match: DirectiveMatch) => string | undefined,
): string {
  const matches: DirectiveMatch[] = [];
  collectDirectiveMatches(parseCodexMarkdown(markdown), matches);
  let rendered = markdown;
  for (const match of matches.sort((left, right) => right.start - left.start)) {
    const replacement = replacementFor(match);
    if (replacement !== undefined) {
      rendered = rendered.slice(0, match.start) + replacement + rendered.slice(match.end);
    }
  }
  return rendered;
}

/** Native Markdown renderers use this adapter because they cannot consume a Remark tree. */
export function renderCodexFileCitationsAsMarkdown(markdown: string): string {
  if (!markdown.includes(`:${CODEX_FILE_CITATION_NAME}`)) return markdown;

  return renderDirectiveMatches(markdown, (match) => match.markdown);
}

/** Matches the Markdown emitted when users copy rendered Codex directive UI. */
export function renderCodexDirectivesForCopy(markdown: string): string {
  if (
    !markdown.includes(`:${CODEX_FILE_CITATION_NAME}`) &&
    !markdown.includes(`::${CODEX_ARTIFACT_TEMPLATE_NAME}`)
  ) {
    return markdown;
  }

  return renderDirectiveMatches(markdown, (match) => {
    if (match.markdown !== undefined) return match.markdown;
    if (match.template === undefined) return undefined;
    return `${match.template.displayName} (${codexArtifactTemplatePresentationLabel(match.template.artifactKind)})`;
  });
}

/** Native renderers split cards out because they cannot host a view inside Markdown text. */
export function splitCodexArtifactTemplateMarkdown(
  markdown: string,
): ReadonlyArray<CodexArtifactTemplateMarkdownSegment> {
  if (!markdown.includes(`::${CODEX_ARTIFACT_TEMPLATE_NAME}`)) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const matches: DirectiveMatch[] = [];
  collectDirectiveMatches(parseCodexMarkdown(markdown), matches);
  const templates = matches
    .filter(
      (match): match is DirectiveMatch & { readonly template: CodexArtifactTemplate } =>
        match.template !== undefined,
    )
    .sort((left, right) => left.start - right.start);
  if (templates.length === 0) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const segments: CodexArtifactTemplateMarkdownSegment[] = [];
  let cursor = 0;
  for (const match of templates) {
    if (match.start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: markdown.slice(cursor, match.start),
        sourceOffset: cursor,
      });
    }
    segments.push({
      kind: "artifact-template",
      sourceOffset: match.start,
      template: match.template,
    });
    cursor = match.end;
  }
  if (cursor < markdown.length) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  return segments;
}

export function artifactTemplateFromHastProperties(
  properties: Readonly<Record<string, unknown>> | null | undefined,
): CodexArtifactTemplate | null {
  if (properties?.dataCodexArtifactTemplate !== "true") return null;
  const stringProperty = (name: string) => {
    const value = properties[name];
    return typeof value === "string" ? value : undefined;
  };
  return resolveCodexArtifactTemplate({
    artifact_kind: stringProperty("dataArtifactKind"),
    display_name: stringProperty("dataDisplayName"),
    gallery_kind: stringProperty("dataGalleryKind"),
    skill_directory: stringProperty("dataSkillDirectory"),
    skill_name: stringProperty("dataSkillName"),
  });
}
