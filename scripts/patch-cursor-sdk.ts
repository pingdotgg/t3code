#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Structural patching needs the legacy compiler AST API, which TypeScript 7 no longer exports.
import ts from "typescript-legacy";

export const JS_SURFACES = ["dist/esm", "dist/cjs", "dist/bundled"] as const;
export type JsSurface = (typeof JS_SURFACES)[number];

export interface TextSplice {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface PatchMatch {
  readonly file: string;
  readonly anchorOffset: number;
  readonly splices: ReadonlyArray<TextSplice>;
}

export interface JsSurfacePatchStep {
  readonly kind: "js-surface";
  readonly stepId: string;
  readonly surfaces?: ReadonlyArray<JsSurface>;
  readonly requiredLiterals: ReadonlyArray<string>;
  readonly findMatches: (sf: ts.SourceFile, file: string) => ReadonlyArray<PatchMatch>;
}

export interface DtsFilePatchStep {
  readonly kind: "dts-file";
  readonly stepId: string;
  readonly relativePaths: ReadonlyArray<string>;
  readonly findMatches: (sf: ts.SourceFile, file: string) => ReadonlyArray<PatchMatch>;
}

export type CursorSdkPatchStep = JsSurfacePatchStep | DtsFilePatchStep;

export interface CursorSdkPatch {
  readonly id: string;
  readonly description: string;
  readonly steps: ReadonlyArray<CursorSdkPatchStep>;
}

export interface AppliedPatchRecord {
  readonly patchId: string;
  readonly stepId: string;
  readonly target: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly spliceCount: number;
}

export interface PatchFilesResult {
  readonly updatedFiles: ReadonlyMap<string, string>;
  readonly applied: ReadonlyArray<AppliedPatchRecord>;
}

export class CursorSdkPatchMatchError extends Schema.TaggedError<CursorSdkPatchMatchError>()(
  "CursorSdkPatchMatchError",
  {
    patchId: Schema.String,
    stepId: Schema.String,
    target: Schema.String,
    matchCount: Schema.Number,
    locations: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.locations.length > 0 ? ` (${this.locations.join(", ")})` : "";
    return `Patch "${this.patchId}/${this.stepId}" expected 1 match in ${this.target}, found ${this.matchCount}${detail}.`;
  }
}

export class CursorSdkPatchSpliceError extends Schema.TaggedError<CursorSdkPatchSpliceError>()(
  "CursorSdkPatchSpliceError",
  {
    file: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to splice "${this.file}": ${this.reason}`;
  }
}

export class CursorSdkPatchSyntaxError extends Schema.TaggedError<CursorSdkPatchSyntaxError>()(
  "CursorSdkPatchSyntaxError",
  {
    file: Schema.String,
    diagnostics: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Patched file "${this.file}" has syntax error(s): ${this.diagnostics.join("; ")}`;
  }
}

export class CursorSdkPatchInputError extends Schema.TaggedError<CursorSdkPatchInputError>()(
  "CursorSdkPatchInputError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class CursorSdkPatchIoError extends Schema.TaggedError<CursorSdkPatchIoError>()(
  "CursorSdkPatchIoError",
  {
    operation: Schema.String,
    targetPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} "${this.targetPath}".`;
  }
}

export class CursorSdkPatchGitError extends Schema.TaggedError<CursorSdkPatchGitError>()(
  "CursorSdkPatchGitError",
  {
    command: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.stderr ? `: ${this.stderr.trim()}` : "";
    return `git ${this.command} failed${this.exitCode !== undefined ? ` (exit ${this.exitCode})` : ""}${detail}`;
  }
}

export type CursorSdkPatchError =
  | CursorSdkPatchMatchError
  | CursorSdkPatchSpliceError
  | CursorSdkPatchSyntaxError
  | CursorSdkPatchInputError
  | CursorSdkPatchIoError
  | CursorSdkPatchGitError;

const PackageManifestSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});
const decodePackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageManifestSchema),
);

function parseSourceFile(fileName: string, text: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

function getParseDiagnostics(sf: ts.SourceFile): ReadonlyArray<string> {
  if (!("parseDiagnostics" in sf) || !Array.isArray(sf.parseDiagnostics)) {
    return [];
  }
  return sf.parseDiagnostics.map((diagnostic: ts.Diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  );
}

function walkAst(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  if (visit(node) === false) {
    return;
  }
  ts.forEachChild(node, (child) => walkAst(child, visit));
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isBooleanTrueLiteral(expr: ts.Expression): boolean {
  const inner = unwrapParens(expr);
  if (inner.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isNumericLiteral(inner.operand) &&
    inner.operand.text === "0"
  );
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function getObjectProperty(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && getPropertyNameText(prop.name) === propName) {
      return prop;
    }
  }
  return undefined;
}

function hasObjectProperty(obj: ts.ObjectLiteralExpression, propName: string): boolean {
  for (const prop of obj.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      getPropertyNameText(prop.name) === propName
    ) {
      return true;
    }
  }
  return false;
}

function isThisPropertyAccess(expr: ts.Expression, propName: string): boolean {
  const inner = unwrapParens(expr);
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.expression.kind === ts.SyntaxKind.ThisKeyword &&
    inner.name.text === propName
  );
}

function matchEqualsTrueProperty(expr: ts.Expression, propName: string): ts.Identifier | undefined {
  const inner = unwrapParens(expr);
  if (
    !ts.isBinaryExpression(inner) ||
    inner.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return undefined;
  }
  const left = unwrapParens(inner.left);
  const right = unwrapParens(inner.right);
  if (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.name.text === propName &&
    isBooleanTrueLiteral(right)
  ) {
    return left.expression;
  }
  if (
    ts.isPropertyAccessExpression(right) &&
    ts.isIdentifier(right.expression) &&
    right.name.text === propName &&
    isBooleanTrueLiteral(left)
  ) {
    return right.expression;
  }
  return undefined;
}

function matchConversationActionNew(
  node: ts.Node,
  expectedCase: string,
): { readonly convAction: ts.Expression; readonly valueAction: ts.Expression } | undefined {
  if (!ts.isNewExpression(node) || !node.arguments || node.arguments.length !== 1) {
    return undefined;
  }
  const arg0 = unwrapParens(node.arguments[0]!);
  if (!ts.isObjectLiteralExpression(arg0)) {
    return undefined;
  }
  const actionProp = getObjectProperty(arg0, "action");
  if (!actionProp) {
    return undefined;
  }
  const actionObj = unwrapParens(actionProp.initializer);
  if (!ts.isObjectLiteralExpression(actionObj)) {
    return undefined;
  }
  const caseProp = getObjectProperty(actionObj, "case");
  const valueProp = getObjectProperty(actionObj, "value");
  if (!caseProp || !valueProp) {
    return undefined;
  }
  const caseVal = unwrapParens(caseProp.initializer);
  const valueVal = unwrapParens(valueProp.initializer);
  if (
    !ts.isStringLiteral(caseVal) ||
    caseVal.text !== expectedCase ||
    !ts.isNewExpression(valueVal)
  ) {
    return undefined;
  }
  return {
    convAction: node.expression,
    valueAction: valueVal.expression,
  };
}

function collectAllIdentifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  walkAst(node, (current) => {
    if (ts.isIdentifier(current)) {
      names.add(current.text);
    }
  });
  return names;
}

function collectReferencedValueIdentifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  walkAst(node, (current) => {
    if (!ts.isIdentifier(current)) {
      return;
    }
    const parent = current.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
      (ts.isPropertyAssignment(parent) && parent.name === current) ||
      (ts.isMethodDeclaration(parent) && parent.name === current)
    ) {
      return;
    }
    names.add(current.text);
  });
  return names;
}

function collectLocalBindingNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  walkAst(node, (current) => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      names.add(current.name.text);
    } else if (ts.isParameter(current) && ts.isIdentifier(current.name)) {
      names.add(current.name.text);
    }
  });
  return names;
}

function pickFreshIdentifier(used: ReadonlySet<string>, candidates: ReadonlyArray<string>): string {
  for (const candidate of candidates) {
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  const base = candidates[candidates.length - 1] ?? "__t3v";
  let suffix = 1;
  while (used.has(`${base}${suffix}`)) {
    suffix++;
  }
  return `${base}${suffix}`;
}

export function applySplices(
  source: string,
  splices: ReadonlyArray<TextSplice>,
  file: string,
): Effect.Effect<string, CursorSdkPatchSpliceError> {
  if (splices.length === 0) {
    return Effect.succeed(source);
  }
  const ordered = [...splices].toSorted((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i]!;
    if (current.start < 0 || current.end < current.start || current.end > source.length) {
      return Effect.fail(
        new CursorSdkPatchSpliceError({
          file,
          reason: `Splice [${current.start}, ${current.end}] is out of bounds for length ${source.length}.`,
        }),
      );
    }
    if (i > 0) {
      const prev = ordered[i - 1]!;
      if (prev.end > current.start || (prev.start === current.start && prev.end === current.end)) {
        return Effect.fail(
          new CursorSdkPatchSpliceError({
            file,
            reason: `Overlapping splices [${prev.start}, ${prev.end}] and [${current.start}, ${current.end}].`,
          }),
        );
      }
    }
  }

  let output = source;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const splice = ordered[i]!;
    output = output.slice(0, splice.start) + splice.replacement + output.slice(splice.end);
  }
  return Effect.succeed(output);
}

// ---------------------------------------------------------------------------
// Patch 1: Forward agent shell stream output via globalThis hook symbol.
// ---------------------------------------------------------------------------

const SHELL_STREAM_HOOK_SYMBOL = "@cursor/sdk.shellStreamOutput";

const shellStreamOutputPatch: CursorSdkPatch = {
  id: "shell-stream-output",
  description: "Forward local shell stdout/stderr stream chunks to the T3 globalThis hook.",
  steps: [
    {
      kind: "js-surface",
      stepId: "forward-shell-stream-output",
      requiredLiterals: ["serializeStream", "hookContextCollector"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (
            !ts.isForOfStatement(node) ||
            node.awaitModifier === undefined ||
            !ts.isVariableDeclarationList(node.initializer) ||
            node.initializer.declarations.length !== 1 ||
            !ts.isIdentifier(node.expression) ||
            !ts.isBlock(node.statement)
          ) {
            return;
          }
          const itemDecl = node.initializer.declarations[0]!;
          if (!ts.isIdentifier(itemDecl.name)) {
            return;
          }
          const itemVar = itemDecl.name.text;
          const streamVar = node.expression.text;
          const loopBlock = node.statement;
          if (loopBlock.getText(sf).includes(SHELL_STREAM_HOOK_SYMBOL)) {
            return;
          }

          let hasSerializeStreamCall = false;
          walkAst(loopBlock, (inner) => {
            if (inner !== loopBlock && isFunctionLike(inner)) {
              return false;
            }
            if (
              ts.isCallExpression(inner) &&
              ts.isPropertyAccessExpression(inner.expression) &&
              inner.expression.name.text === "serializeStream" &&
              inner.arguments.length === 2
            ) {
              const streamArg = unwrapParens(inner.arguments[1]!);
              if (ts.isIdentifier(streamArg) && streamArg.text === itemVar) {
                hasSerializeStreamCall = true;
              }
            }
          });
          if (!hasSerializeStreamCall) {
            return;
          }

          let enclosingFn: ts.Node | undefined = node.parent;
          while (enclosingFn && !isFunctionLike(enclosingFn)) {
            enclosingFn = enclosingFn.parent;
          }
          if (!enclosingFn) {
            return;
          }

          const argsVars: Array<string> = [];
          walkAst(enclosingFn, (inner) => {
            if (inner !== enclosingFn && isFunctionLike(inner)) {
              return false;
            }
            if (
              !ts.isVariableDeclaration(inner) ||
              !ts.isIdentifier(inner.name) ||
              inner.name.text !== streamVar ||
              !inner.initializer
            ) {
              return;
            }
            const init = unwrapParens(inner.initializer);
            if (
              !ts.isCallExpression(init) ||
              init.arguments.length < 3 ||
              !ts.isPropertyAccessExpression(init.expression) ||
              init.expression.name.text !== "execute" ||
              !ts.isPropertyAccessExpression(init.expression.expression) ||
              init.expression.expression.name.text !== "exec"
            ) {
              return;
            }
            const argsArg = unwrapParens(init.arguments[1]!);
            const optsArg = unwrapParens(init.arguments[2]!);
            if (
              ts.isIdentifier(argsArg) &&
              ts.isObjectLiteralExpression(optsArg) &&
              hasObjectProperty(optsArg, "hookContextCollector") &&
              hasObjectProperty(optsArg, "execId")
            ) {
              argsVars.push(argsArg.text);
            }
          });
          if (argsVars.length !== 1) {
            return;
          }

          const argsVar = argsVars[0]!;
          const insertPos = loopBlock.getStart(sf) + 1;
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement:
                  `{const __t3h=globalThis[Symbol.for("${SHELL_STREAM_HOOK_SYMBOL}")];` +
                  `const __t3c=${itemVar}.event?.case;` +
                  `if(typeof __t3h==="function"&&(__t3c==="stdout"||__t3c==="stderr"))` +
                  `try{__t3h({conversationId:${argsVar}.conversationId,toolCallId:${argsVar}.toolCallId,` +
                  `event:{case:__t3c,value:{data:${itemVar}.event.value.data}}})}catch{}}`,
              },
            ],
          });
        });
        return matches;
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Patch 2: Pass cli-config.json attributionConfigProvider into workspace resources.
// ---------------------------------------------------------------------------

const CLI_CONFIG_ATTRIBUTION_GETTER =
  `{get(){try{const{readFileSync:r}=process.getBuiltinModule("node:fs"),` +
  `{join:j}=process.getBuiltinModule("node:path"),` +
  `{homedir:h}=process.getBuiltinModule("node:os"),` +
  `x=process.env.XDG_CONFIG_HOME,` +
  `d=process.env.CURSOR_CONFIG_DIR||(x&&process.platform!=="darwin"&&process.platform!=="win32"?j(x,"cursor"):j(h(),".cursor"));` +
  `return JSON.parse(r(j(d,"cli-config.json"),"utf8"))}catch{return}}}`;

const attributionConfigProviderPatch: CursorSdkPatch = {
  id: "attribution-config-provider",
  description:
    "Forward attributionConfigProvider into workspace resources and read Cursor CLI cli-config.json when user extensibility is enabled.",
  steps: [
    {
      kind: "js-surface",
      stepId: "forward-workspace-attribution-config-provider",
      requiredLiterals: ["mcpMetaToolEnabled", "getAgentSkills", "powershellUtf8Console"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (!ts.isObjectLiteralExpression(node)) {
            return;
          }
          if (hasObjectProperty(node, "attributionConfigProvider")) {
            return;
          }
          if (
            !hasObjectProperty(node, "getAgentSkills") ||
            !hasObjectProperty(node, "powershellUtf8Console")
          ) {
            return;
          }
          const mcpProp = getObjectProperty(node, "mcpMetaToolEnabled");
          if (!mcpProp) {
            return;
          }
          const init = unwrapParens(mcpProp.initializer);
          if (
            !ts.isPropertyAccessExpression(init) ||
            !ts.isIdentifier(init.expression) ||
            init.name.text !== "mcpMetaToolEnabled"
          ) {
            return;
          }
          const srcVar = init.expression.text;
          const insertPos = mcpProp.getEnd();
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement: `,attributionConfigProvider:${srcVar}.attributionConfigProvider`,
              },
            ],
          });
        });
        return matches;
      },
    },
    {
      kind: "js-surface",
      stepId: "provide-cli-config-attribution",
      requiredLiterals: ["resourceFactory", "includeUserExtensibility", "ignoreService"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (
            !ts.isPropertyAssignment(node) ||
            getPropertyNameText(node.name) !== "resourceFactory" ||
            !ts.isObjectLiteralExpression(node.parent)
          ) {
            return;
          }
          const call = unwrapParens(node.initializer);
          if (!ts.isCallExpression(call) || call.arguments.length < 1) {
            return;
          }
          const optsObj = unwrapParens(call.arguments[0]!);
          if (
            !ts.isObjectLiteralExpression(optsObj) ||
            hasObjectProperty(optsObj, "attributionConfigProvider") ||
            !hasObjectProperty(optsObj, "ignoreService") ||
            !hasObjectProperty(optsObj, "grepProvider") ||
            !hasObjectProperty(optsObj, "workspacePaths") ||
            !hasObjectProperty(optsObj, "defaultSandboxPolicy")
          ) {
            return;
          }

          const userExtExprs: Array<string> = [];
          walkAst(node.parent, (inner) => {
            if (
              ts.isPropertyAssignment(inner) &&
              getPropertyNameText(inner.name) === "includeUserExtensibility"
            ) {
              userExtExprs.push(inner.initializer.getText(sf));
            }
          });
          if (userExtExprs.length !== 1) {
            return;
          }

          const insertPos = optsObj.getStart(sf) + 1;
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement: `attributionConfigProvider:${userExtExprs[0]!}?${CLI_CONFIG_ATTRIBUTION_GETTER}:void 0,`,
              },
            ],
          });
        });
        return matches;
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Patch 3: Expose agent.resume(options?) using Cursor's ResumeAction.
// ---------------------------------------------------------------------------

function resolveResumeActionExpr(
  sf: ts.SourceFile,
  convActionAtSummarize: ts.Expression,
): string | undefined {
  const candidates = new Set<string>();
  const convIsProp = ts.isPropertyAccessExpression(convActionAtSummarize);
  const convIsIdent = ts.isIdentifier(convActionAtSummarize);
  if (!convIsProp && !convIsIdent) {
    return undefined;
  }

  walkAst(sf, (node) => {
    const matched = matchConversationActionNew(node, "resumeAction");
    if (!matched) {
      return;
    }
    if (convIsProp) {
      if (
        ts.isPropertyAccessExpression(matched.convAction) &&
        matched.convAction.name.text === convActionAtSummarize.name.text &&
        ts.isPropertyAccessExpression(matched.valueAction)
      ) {
        candidates.add(`${convActionAtSummarize.expression.getText(sf)}.${matched.valueAction.name.text}`);
      }
    } else if (
      ts.isIdentifier(matched.convAction) &&
      matched.convAction.text === convActionAtSummarize.text &&
      ts.isIdentifier(matched.valueAction)
    ) {
      candidates.add(matched.valueAction.text);
    }
  });

  if (candidates.size !== 1) {
    return undefined;
  }
  return [...candidates][0];
}

function buildLocalResumeMethod(sf: ts.SourceFile, method: ts.MethodDeclaration): string | undefined {
  if (!method.body) {
    return undefined;
  }

  const sendImplCalls: Array<{
    readonly arg0: ts.ObjectLiteralExpression;
    readonly arg1: ts.ObjectLiteralExpression;
  }> = [];
  const templateMessageSpans: Array<{ readonly start: number; readonly end: number }> = [];
  const summarizeOpLiterals: Array<ts.StringLiteral> = [];
  let tryBlock: ts.Block | undefined;
  let catchClause: ts.CatchClause | undefined;

  for (const stmt of method.body.statements) {
    if (ts.isTryStatement(stmt)) {
      tryBlock = stmt.tryBlock;
      catchClause = stmt.catchClause;
    }
  }
  if (!tryBlock || !catchClause) {
    return undefined;
  }

  walkAst(method.body, (inner) => {
    if (
      ts.isCallExpression(inner) &&
      isThisPropertyAccess(inner.expression, "sendImpl") &&
      inner.arguments.length >= 2
    ) {
      const arg0 = unwrapParens(inner.arguments[0]!);
      const arg1 = unwrapParens(inner.arguments[1]!);
      if (
        ts.isObjectLiteralExpression(arg0) &&
        arg0.properties.length === 1 &&
        ts.isObjectLiteralExpression(arg1) &&
        arg1.properties.length === 0
      ) {
        const summarizeProp = getObjectProperty(arg0, "summarize");
        if (summarizeProp && isBooleanTrueLiteral(summarizeProp.initializer)) {
          sendImplCalls.push({ arg0, arg1 });
        }
      }
    } else if (ts.isStringLiteral(inner) && inner.text === "agent.summarize") {
      summarizeOpLiterals.push(inner);
    } else if (
      ts.isTemplateTail(inner) ||
      ts.isTemplateMiddle(inner) ||
      ts.isTemplateHead(inner) ||
      ts.isNoSubstitutionTemplateLiteral(inner)
    ) {
      const rawText = inner.getText(sf);
      const phrase = "has no saved conversation to summarize yet.";
      const phraseOffset = rawText.indexOf(phrase);
      if (phraseOffset !== -1) {
        const wordOffset = phraseOffset + "has no saved conversation to ".length;
        const absStart = inner.getStart(sf) + wordOffset;
        templateMessageSpans.push({
          start: absStart,
          end: absStart + "summarize".length,
        });
      }
    }
  });

  if (
    sendImplCalls.length !== 1 ||
    templateMessageSpans.length !== 1 ||
    summarizeOpLiterals.length === 0
  ) {
    return undefined;
  }

  const forbidden = new Set<string>(collectReferencedValueIdentifiers(tryBlock));
  for (const name of collectLocalBindingNames(tryBlock)) {
    forbidden.add(name);
  }
  const catchLocals = collectLocalBindingNames(catchClause);
  if (catchClause.variableDeclaration && ts.isIdentifier(catchClause.variableDeclaration.name)) {
    catchLocals.add(catchClause.variableDeclaration.name.text);
  }
  for (const name of collectReferencedValueIdentifiers(catchClause)) {
    if (!catchLocals.has(name)) {
      forbidden.add(name);
    }
  }
  const optParam = pickFreshIdentifier(forbidden, ["r", "__t3o"]);

  const methodStart = method.getStart(sf);
  const methodText = method.getText(sf);
  const openParenIndex = sf.text.indexOf("(", method.name.getEnd());
  if (openParenIndex === -1 || openParenIndex >= method.body.getStart(sf)) {
    return undefined;
  }

  const sendCall = sendImplCalls[0]!;
  const msgSpan = templateMessageSpans[0]!;
  const localSplices: Array<TextSplice> = [
    {
      start: method.name.getStart(sf) - methodStart,
      end: method.name.getEnd() - methodStart,
      replacement: "resume",
    },
    {
      start: openParenIndex + 1 - methodStart,
      end: openParenIndex + 1 - methodStart,
      replacement: `${optParam}={}`,
    },
    {
      start: msgSpan.start - methodStart,
      end: msgSpan.end - methodStart,
      replacement: "resume",
    },
    {
      start: sendCall.arg0.getStart(sf) - methodStart,
      end: sendCall.arg0.getEnd() - methodStart,
      replacement: `{text:"",resume:!0}`,
    },
    {
      start: sendCall.arg1.getStart(sf) - methodStart,
      end: sendCall.arg1.getEnd() - methodStart,
      replacement: optParam,
    },
    ...summarizeOpLiterals.map((literal) => {
      const quote = sf.text[literal.getStart(sf)] ?? '"';
      return {
        start: literal.getStart(sf) - methodStart,
        end: literal.getEnd() - methodStart,
        replacement: `${quote}agent.resume${quote}`,
      };
    }),
  ];

  const ordered = localSplices.toSorted((a, b) => b.start - a.start);
  let output = methodText;
  for (const splice of ordered) {
    output = output.slice(0, splice.start) + splice.replacement + output.slice(splice.end);
  }
  return output;
}

const agentResumePatch: CursorSdkPatch = {
  id: "agent-resume",
  description: "Add local agent.resume(options?) backed by Cursor's ResumeAction.",
  steps: [
    {
      kind: "js-surface",
      stepId: "local-executor-resume-action",
      requiredLiterals: ["summarizeAction", "resumeAction"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (!ts.isConditionalExpression(node)) {
            return;
          }
          const inputVar = matchEqualsTrueProperty(node.condition, "summarize");
          if (!inputVar) {
            return;
          }
          const summarizeNew = matchConversationActionNew(unwrapParens(node.whenTrue), "summarizeAction");
          if (!summarizeNew) {
            return;
          }
          if (
            ts.isConditionalExpression(node.parent) &&
            node.parent.whenFalse === node &&
            matchEqualsTrueProperty(node.parent.condition, "resume") !== undefined
          ) {
            return;
          }

          const resumeActionExpr = resolveResumeActionExpr(sf, summarizeNew.convAction);
          if (!resumeActionExpr) {
            return;
          }
          const convActionExpr = summarizeNew.convAction.getText(sf);
          const insertPos = node.getStart(sf);
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement: `${inputVar.text}.resume===!0?new ${convActionExpr}({action:{case:"resumeAction",value:new ${resumeActionExpr}}}):`,
              },
            ],
          });
        });
        return matches;
      },
    },
    {
      kind: "js-surface",
      stepId: "local-agent-resume-method",
      requiredLiterals: ["has no saved conversation to summarize yet.", "agent.summarize"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (
            !ts.isMethodDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.name.text !== "summarize" ||
            node.parameters.length !== 0 ||
            !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
          ) {
            return;
          }
          const parentClass = node.parent;
          if (!ts.isClassDeclaration(parentClass) && !ts.isClassExpression(parentClass)) {
            return;
          }
          const alreadyHasResume = parentClass.members.some(
            (member) =>
              ts.isMethodDeclaration(member) &&
              ts.isIdentifier(member.name) &&
              member.name.text === "resume",
          );
          if (alreadyHasResume) {
            return;
          }

          const resumeMethodText = buildLocalResumeMethod(sf, node);
          if (!resumeMethodText) {
            return;
          }

          const insertPos = node.getStart(sf);
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement: resumeMethodText,
              },
            ],
          });
        });
        return matches;
      },
    },
    {
      kind: "dts-file",
      stepId: "sdk-agent-dts-resume",
      relativePaths: ["dist/esm/agent.d.ts", "dist/cjs/agent.d.ts"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (!ts.isInterfaceDeclaration(node) || node.name.text !== "SDKAgent") {
            return;
          }
          const hasResume = node.members.some(
            (member) => member.name !== undefined && getPropertyNameText(member.name) === "resume",
          );
          if (hasResume) {
            return;
          }
          const summarizeMembers = node.members.filter(
            (member): member is ts.MethodSignature =>
              ts.isMethodSignature(member) && getPropertyNameText(member.name) === "summarize",
          );
          if (summarizeMembers.length !== 1) {
            return;
          }
          const summarizeMember = summarizeMembers[0]!;
          const memberStart = summarizeMember.getStart(sf);
          const lineStart = sf.text.lastIndexOf("\n", memberStart) + 1;
          const indentMatch = sf.text.slice(lineStart, memberStart).match(/^[ \t]*/);
          const indent = indentMatch ? indentMatch[0] : "    ";
          const insertPos = summarizeMember.getEnd();
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement:
                  `\n${indent}/**` +
                  `\n${indent} * Continue the saved conversation from its latest checkpoint without a new` +
                  `\n${indent} * user message (the protocol's ResumeAction). Local agents only.` +
                  `\n${indent} */` +
                  `\n${indent}resume?(options?: SendOptions): Promise<Run>;`,
              },
            ],
          });
        });
        return matches;
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Patch 4: Refresh stale localModelListCache when a requested model is missing.
// ---------------------------------------------------------------------------

const refreshStaleModelCachePatch: CursorSdkPatch = {
  id: "refresh-stale-model-cache",
  description:
    "Pass the requested model ID to listModelsForLocalValidation and re-fetch once if a cached model list misses it.",
  steps: [
    {
      kind: "js-surface",
      stepId: "pass-expected-model-id",
      requiredLiterals: ["resolveLocalModelSelection", "listModelsForLocalValidation"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (
            !ts.isMethodDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.name.text !== "resolveLocalModelSelection" ||
            node.parameters.length !== 3 ||
            !node.body
          ) {
            return;
          }
          const firstParam = node.parameters[0]!.name;
          if (!ts.isIdentifier(firstParam)) {
            return;
          }
          const calls: Array<ts.CallExpression> = [];
          walkAst(node.body, (inner) => {
            if (
              ts.isCallExpression(inner) &&
              isThisPropertyAccess(inner.expression, "listModelsForLocalValidation") &&
              inner.arguments.length === 2
            ) {
              calls.push(inner);
            }
          });
          if (calls.length !== 1) {
            return;
          }
          const call = calls[0]!;
          const insertPos = call.arguments[1]!.getEnd();
          matches.push({
            file,
            anchorOffset: insertPos,
            splices: [
              {
                start: insertPos,
                end: insertPos,
                replacement: `,${firstParam.text}.id`,
              },
            ],
          });
        });
        return matches;
      },
    },
    {
      kind: "js-surface",
      stepId: "retry-stale-model-list-cache",
      requiredLiterals: ["listModelsForLocalValidation", "localModelListCache"],
      findMatches: (sf, file) => {
        const matches: Array<PatchMatch> = [];
        walkAst(sf, (node) => {
          if (
            !ts.isMethodDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.name.text !== "listModelsForLocalValidation" ||
            node.parameters.length !== 2 ||
            !node.body
          ) {
            return;
          }
          const apiKeyParam = node.parameters[0]!.name;
          const teamIdParam = node.parameters[1]!.name;
          if (!ts.isIdentifier(apiKeyParam) || !ts.isIdentifier(teamIdParam)) {
            return;
          }

          const cacheLookups: Array<{
            readonly promiseVar: string;
            readonly keyVar: string;
            readonly stmt: ts.VariableStatement;
          }> = [];
          walkAst(node.body, (inner) => {
            if (inner !== node.body && isFunctionLike(inner)) {
              return false;
            }
            if (
              !ts.isVariableDeclaration(inner) ||
              !ts.isIdentifier(inner.name) ||
              !inner.initializer
            ) {
              return;
            }
            const init = unwrapParens(inner.initializer);
            if (
              !ts.isCallExpression(init) ||
              init.arguments.length !== 1 ||
              !ts.isPropertyAccessExpression(init.expression) ||
              init.expression.name.text !== "get" ||
              !isThisPropertyAccess(init.expression.expression, "localModelListCache")
            ) {
              return;
            }
            const keyArg = unwrapParens(init.arguments[0]!);
            if (!ts.isIdentifier(keyArg)) {
              return;
            }
            let current: ts.Node | undefined = inner.parent;
            while (current && !ts.isVariableStatement(current)) {
              current = current.parent;
            }
            if (current && ts.isVariableStatement(current)) {
              cacheLookups.push({
                promiseVar: inner.name.text,
                keyVar: keyArg.text,
                stmt: current,
              });
            }
          });
          if (cacheLookups.length !== 1) {
            return;
          }
          const lookup = cacheLookups[0]!;

          const tryMatches: Array<{
            readonly tryStmt: ts.TryStatement;
            readonly returnStmt: ts.ReturnStatement;
          }> = [];
          walkAst(node.body, (inner) => {
            if (inner !== node.body && isFunctionLike(inner)) {
              return false;
            }
            if (!ts.isTryStatement(inner) || !inner.catchClause) {
              return;
            }
            if (inner.tryBlock.statements.length !== 1) {
              return;
            }
            const onlyStmt = inner.tryBlock.statements[0]!;
            if (!ts.isReturnStatement(onlyStmt) || !onlyStmt.expression) {
              return;
            }
            const retExpr = unwrapParens(onlyStmt.expression);
            if (
              !ts.isAwaitExpression(retExpr) ||
              !ts.isIdentifier(unwrapParens(retExpr.expression)) ||
              (unwrapParens(retExpr.expression) as ts.Identifier).text !== lookup.promiseVar
            ) {
              return;
            }

            let deletesKey = false;
            walkAst(inner.catchClause.block, (catchNode) => {
              if (
                ts.isCallExpression(catchNode) &&
                catchNode.arguments.length === 1 &&
                ts.isPropertyAccessExpression(catchNode.expression) &&
                catchNode.expression.name.text === "delete" &&
                isThisPropertyAccess(catchNode.expression.expression, "localModelListCache")
              ) {
                const delArg = unwrapParens(catchNode.arguments[0]!);
                if (ts.isIdentifier(delArg) && delArg.text === lookup.keyVar) {
                  deletesKey = true;
                }
              }
            });
            if (deletesKey) {
              tryMatches.push({ tryStmt: inner, returnStmt: onlyStmt });
            }
          });
          if (tryMatches.length !== 1) {
            return;
          }
          const { tryStmt, returnStmt } = tryMatches[0]!;

          const used = collectAllIdentifiers(node);
          const expectedModelParam = pickFreshIdentifier(used, ["__t3m"]);
          used.add(expectedModelParam);
          const isFreshVar = pickFreshIdentifier(used, ["__t3f"]);
          used.add(isFreshVar);
          const modelsVar = pickFreshIdentifier(used, ["__t3l"]);
          used.add(modelsVar);
          const entryVar = pickFreshIdentifier(used, ["__t3e"]);

          const semiPrefix = lookup.stmt.getText(sf).endsWith(";") ? "" : ";";
          matches.push({
            file,
            anchorOffset: node.getStart(sf),
            splices: [
              {
                start: node.parameters[1]!.getEnd(),
                end: node.parameters[1]!.getEnd(),
                replacement: `,${expectedModelParam}`,
              },
              {
                start: lookup.stmt.getEnd(),
                end: lookup.stmt.getEnd(),
                replacement: `${semiPrefix}const ${isFreshVar}=${lookup.promiseVar}===void 0;`,
              },
              {
                start: tryStmt.getStart(sf),
                end: tryStmt.getStart(sf),
                replacement: `let ${modelsVar};`,
              },
              {
                start: returnStmt.getStart(sf),
                end: returnStmt.getEnd(),
                replacement: `${modelsVar}=await ${lookup.promiseVar}`,
              },
              {
                start: tryStmt.getEnd(),
                end: tryStmt.getEnd(),
                replacement:
                  `if(${isFreshVar}||${expectedModelParam}===void 0||${modelsVar}.some((${entryVar})=>` +
                  `${entryVar}.id===${expectedModelParam}||${entryVar}.aliases?.includes(${expectedModelParam})===!0))` +
                  `return ${modelsVar};` +
                  `if(this.localModelListCache.get(${lookup.keyVar})===${lookup.promiseVar})` +
                  `this.localModelListCache.delete(${lookup.keyVar});` +
                  `return this.listModelsForLocalValidation(${apiKeyParam.text},${teamIdParam.text});`,
              },
            ],
          });
        });
        return matches;
      },
    },
  ],
};

// Append future @cursor/sdk patches here; each step is enforced to match uniquely per surface/file.
export const CURSOR_SDK_PATCHES: ReadonlyArray<CursorSdkPatch> = [
  shellStreamOutputPatch,
  attributionConfigProviderPatch,
  agentResumePatch,
  refreshStaleModelCachePatch,
];

function formatLocation(sf: ts.SourceFile, file: string, offset: number): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(offset);
  return `${file}:${line + 1}:${character + 1}`;
}

export const applyCursorSdkPatchesToFiles = Effect.fn("patchCursorSdk.applyToFiles")(function* (
  files: ReadonlyMap<string, string>,
  patches: ReadonlyArray<CursorSdkPatch> = CURSOR_SDK_PATCHES,
) {
  const parsedCache = new Map<string, ts.SourceFile>();
  const getParsed = (file: string, kind: ts.ScriptKind): ts.SourceFile | undefined => {
    const cached = parsedCache.get(file);
    if (cached) {
      return cached;
    }
    const content = files.get(file);
    if (content === undefined) {
      return undefined;
    }
    const sf = parseSourceFile(file, content, kind);
    parsedCache.set(file, sf);
    return sf;
  };

  const surfaceFiles = new Map<JsSurface, ReadonlyArray<string>>();
  for (const surface of JS_SURFACES) {
    const prefix = `${surface}/`;
    const matched = [...files.keys()]
      .filter((rel) => rel.startsWith(prefix) && !rel.slice(prefix.length).includes("/") && rel.endsWith(".js"))
      .toSorted();
    surfaceFiles.set(surface, matched);
  }

  const splicesByFile = new Map<string, Array<TextSplice>>();
  const applied: Array<AppliedPatchRecord> = [];

  for (const patch of patches) {
    for (const step of patch.steps) {
      if (step.kind === "js-surface") {
        const surfaces = step.surfaces ?? JS_SURFACES;
        for (const surface of surfaces) {
          const candidates = surfaceFiles.get(surface) ?? [];
          const matches: Array<{ readonly match: PatchMatch; readonly sf: ts.SourceFile }> = [];

          for (const file of candidates) {
            const content = files.get(file);
            if (
              content === undefined ||
              !step.requiredLiterals.every((literal) => content.includes(literal))
            ) {
              continue;
            }
            const sf = getParsed(file, ts.ScriptKind.JS);
            if (!sf) {
              continue;
            }
            for (const match of step.findMatches(sf, file)) {
              matches.push({ match, sf });
            }
          }

          if (matches.length !== 1) {
            return yield* new CursorSdkPatchMatchError({
              patchId: patch.id,
              stepId: step.stepId,
              target: surface,
              matchCount: matches.length,
              locations: matches.map(({ match, sf }) =>
                formatLocation(sf, match.file, match.anchorOffset),
              ),
            });
          }

          const { match, sf } = matches[0]!;
          const fileSplices = splicesByFile.get(match.file) ?? [];
          fileSplices.push(...match.splices);
          splicesByFile.set(match.file, fileSplices);
          const pos = sf.getLineAndCharacterOfPosition(match.anchorOffset);
          applied.push({
            patchId: patch.id,
            stepId: step.stepId,
            target: surface,
            file: match.file,
            line: pos.line + 1,
            column: pos.character + 1,
            spliceCount: match.splices.length,
          });
        }
      } else {
        for (const relativePath of step.relativePaths) {
          const sf = getParsed(relativePath, ts.ScriptKind.TS);
          if (!sf) {
            return yield* new CursorSdkPatchMatchError({
              patchId: patch.id,
              stepId: step.stepId,
              target: relativePath,
              matchCount: 0,
              locations: [],
            });
          }
          const matches = step.findMatches(sf, relativePath);
          if (matches.length !== 1) {
            return yield* new CursorSdkPatchMatchError({
              patchId: patch.id,
              stepId: step.stepId,
              target: relativePath,
              matchCount: matches.length,
              locations: matches.map((match) =>
                formatLocation(sf, match.file, match.anchorOffset),
              ),
            });
          }
          const match = matches[0]!;
          const fileSplices = splicesByFile.get(match.file) ?? [];
          fileSplices.push(...match.splices);
          splicesByFile.set(match.file, fileSplices);
          const pos = sf.getLineAndCharacterOfPosition(match.anchorOffset);
          applied.push({
            patchId: patch.id,
            stepId: step.stepId,
            target: relativePath,
            file: match.file,
            line: pos.line + 1,
            column: pos.character + 1,
            spliceCount: match.splices.length,
          });
        }
      }
    }
  }

  const updatedFiles = new Map<string, string>();
  for (const [file, splices] of [...splicesByFile.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const original = files.get(file);
    if (original === undefined) {
      return yield* new CursorSdkPatchSpliceError({
        file,
        reason: "Source file missing during splice application.",
      });
    }
    const patched = yield* applySplices(original, splices, file);
    const kind = file.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const diagnostics = getParseDiagnostics(parseSourceFile(file, patched, kind));
    if (diagnostics.length > 0) {
      return yield* new CursorSdkPatchSyntaxError({
        file,
        diagnostics,
      });
    }
    updatedFiles.set(file, patched);
  }

  return { updatedFiles, applied } satisfies PatchFilesResult;
});

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((chunks) => Array.from(chunks).join("")),
  );

const runGit = Effect.fn("patchCursorSdk.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  allowedExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = args[0] ?? "";
  const child = yield* spawner.spawn(ChildProcess.make("git", [...args], { cwd })).pipe(
    Effect.mapError((cause) => new CursorSdkPatchGitError({ command, cause })),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError((cause) => new CursorSdkPatchGitError({ command, cause })));

  if (!allowedExitCodes.includes(exitCode)) {
    return yield* new CursorSdkPatchGitError({ command, exitCode, stderr });
  }
  return { stdout, stderr, exitCode };
});

const readSdkCandidateFiles = Effect.fn("patchCursorSdk.readSdkCandidateFiles")(function* (
  sdkDir: string,
  patches: ReadonlyArray<CursorSdkPatch>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, string>();

  const relativePaths = new Set<string>();
  for (const surface of JS_SURFACES) {
    const surfaceDir = path.join(sdkDir, surface);
    const exists = yield* fs.exists(surfaceDir).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "stat", targetPath: surfaceDir, cause }),
      ),
    );
    if (!exists) {
      continue;
    }
    const entries = yield* fs.readDirectory(surfaceDir).pipe(
      Effect.mapError(
        (cause) =>
          new CursorSdkPatchIoError({ operation: "read directory", targetPath: surfaceDir, cause }),
      ),
    );
    for (const entry of entries) {
      if (entry.endsWith(".js")) {
        relativePaths.add(`${surface}/${entry}`);
      }
    }
  }
  for (const patch of patches) {
    for (const step of patch.steps) {
      if (step.kind === "dts-file") {
        for (const rel of step.relativePaths) {
          relativePaths.add(rel);
        }
      }
    }
  }

  for (const rel of [...relativePaths].toSorted()) {
    const fullPath = path.join(sdkDir, rel);
    const exists = yield* fs.exists(fullPath).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "stat", targetPath: fullPath, cause }),
      ),
    );
    if (!exists) {
      continue;
    }
    const content = yield* fs.readFileString(fullPath).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "read", targetPath: fullPath, cause }),
      ),
    );
    files.set(rel, content);
  }

  return files;
});

const readSdkPackageVersion = Effect.fn("patchCursorSdk.readSdkPackageVersion")(function* (
  sdkDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(sdkDir, "package.json");
  const raw = yield* fs.readFileString(manifestPath).pipe(
    Effect.mapError(
      (cause) => new CursorSdkPatchIoError({ operation: "read", targetPath: manifestPath, cause }),
    ),
  );
  const manifest = yield* decodePackageManifest(raw).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "parse", targetPath: manifestPath, cause }),
    ),
  );
  if (manifest.name !== "@cursor/sdk") {
    return yield* new CursorSdkPatchInputError({
      reason: `Expected package "@cursor/sdk" at "${manifestPath}", found "${manifest.name}".`,
    });
  }
  return manifest.version;
});

const resolveUnpatchedSdkDir = Effect.fn("patchCursorSdk.resolveUnpatchedSdkDir")(function* (
  rootDir: string,
  sourceDir: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (sourceDir !== undefined) {
    const resolved = path.resolve(sourceDir);
    const version = yield* readSdkPackageVersion(resolved);
    return { sdkDir: resolved, version, isTempCopy: false };
  }

  const installedLink = path.join(rootDir, "packages/provider-cursor/node_modules/@cursor/sdk");
  const exists = yield* fs.exists(installedLink).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "stat", targetPath: installedLink, cause }),
    ),
  );
  if (!exists) {
    return yield* new CursorSdkPatchInputError({
      reason: `Could not locate installed @cursor/sdk at "${installedLink}". Pass --source <unpatched-sdk-dir> or run \`vp i\` first.`,
    });
  }

  const installedDir = yield* fs.realPath(installedLink).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "resolve", targetPath: installedLink, cause }),
    ),
  );
  const version = yield* readSdkPackageVersion(installedDir);
  const tempRoot = yield* fs
    .makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-unpatched-" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CursorSdkPatchIoError({ operation: "create temp dir", targetPath: rootDir, cause }),
      ),
    );
  const unpatchedDir = path.join(tempRoot, "sdk");
  yield* fs.copy(installedDir, unpatchedDir).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "copy", targetPath: unpatchedDir, cause }),
    ),
  );

  const existingPatch = path.join(rootDir, "patches", `@cursor__sdk@${version}.patch`);
  const patchExists = yield* fs.exists(existingPatch).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "stat", targetPath: existingPatch, cause }),
    ),
  );
  if (patchExists) {
    yield* runGit(unpatchedDir, ["apply", "-R", existingPatch]);
  }

  return { sdkDir: unpatchedDir, version, isTempCopy: true };
});

export const generateUnifiedPatch = Effect.fn("patchCursorSdk.generateUnifiedPatch")(function* (
  originals: ReadonlyMap<string, string>,
  updated: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-diff-" }).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "create temp dir", targetPath: "tmp", cause }),
    ),
  );

  const dirA = path.join(tempDir, "a");
  const dirB = path.join(tempDir, "b");
  for (const [rel, patchedContent] of [...updated.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const origContent = originals.get(rel);
    if (origContent === undefined) {
      return yield* new CursorSdkPatchSpliceError({
        file: rel,
        reason: "Missing original file while generating unified diff.",
      });
    }
    const fileA = path.join(dirA, rel);
    const fileB = path.join(dirB, rel);
    yield* fs.makeDirectory(path.dirname(fileA), { recursive: true }).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "mkdir", targetPath: fileA, cause }),
      ),
    );
    yield* fs.makeDirectory(path.dirname(fileB), { recursive: true }).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "mkdir", targetPath: fileB, cause }),
      ),
    );
    yield* fs.writeFileString(fileA, origContent).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "write", targetPath: fileA, cause }),
      ),
    );
    yield* fs.writeFileString(fileB, patchedContent).pipe(
      Effect.mapError(
        (cause) => new CursorSdkPatchIoError({ operation: "write", targetPath: fileB, cause }),
      ),
    );
  }

  const diffResult = yield* runGit(
    tempDir,
    ["diff", "--no-index", "--no-ext-diff", "--no-color", "--full-index", "--", "a", "b"],
    [0, 1],
  );
  // Strip `git diff --no-index`'s extra directory-root prefix (`a/a/` -> `a/`, `b/b/` -> `b/`).
  const normalized = diffResult.stdout
    .replace(/^diff --git a\/a\/(.+) b\/b\/(.+)$/gm, "diff --git a/$1 b/$2")
    .replace(/^--- a\/a\/(.+)$/gm, "--- a/$1")
    .replace(/^\+\+\+ b\/b\/(.+)$/gm, "+++ b/$1");

  // Verify the generated diff applies cleanly to the unpatched copy before returning it.
  const patchTempFile = path.join(tempDir, "generated.patch");
  yield* fs.writeFileString(patchTempFile, normalized).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({ operation: "write", targetPath: patchTempFile, cause }),
    ),
  );
  yield* runGit(dirA, ["apply", "--check", patchTempFile]);

  return normalized;
});

export interface PatchCursorSdkOptions {
  readonly rootDir?: string | undefined;
  readonly sourceDir?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly check?: boolean | undefined;
  readonly applyInPlace?: boolean | undefined;
}

export const patchCursorSdk = Effect.fn("patchCursorSdk")(function* (
  options: PatchCursorSdkOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const check = options.check ?? false;
  const applyInPlace = options.applyInPlace ?? false;

  if (applyInPlace && options.sourceDir === undefined) {
    return yield* new CursorSdkPatchInputError({
      reason: "--apply-in-place requires --source <unpatched-sdk-dir> so node_modules is never mutated directly.",
    });
  }

  const { sdkDir, version } = yield* resolveUnpatchedSdkDir(rootDir, options.sourceDir);
  const files = yield* readSdkCandidateFiles(sdkDir, CURSOR_SDK_PATCHES);
  const result = yield* applyCursorSdkPatchesToFiles(files, CURSOR_SDK_PATCHES);

  if (check) {
    return {
      mode: "check" as const,
      version,
      outputPath: undefined,
      updatedFiles: [...result.updatedFiles.keys()],
      applied: result.applied,
    };
  }

  if (applyInPlace) {
    for (const [rel, content] of result.updatedFiles.entries()) {
      const targetPath = path.join(sdkDir, rel);
      yield* fs.writeFileString(targetPath, content).pipe(
        Effect.mapError(
          (cause) => new CursorSdkPatchIoError({ operation: "write", targetPath, cause }),
        ),
      );
    }
    return {
      mode: "apply-in-place" as const,
      version,
      outputPath: sdkDir,
      updatedFiles: [...result.updatedFiles.keys()],
      applied: result.applied,
    };
  }

  const outputPath = path.resolve(
    options.outputPath ?? path.join(rootDir, "patches", `@cursor__sdk@${version}.patch`),
  );
  const diffText = yield* generateUnifiedPatch(files, result.updatedFiles);
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchIoError({
          operation: "mkdir",
          targetPath: path.dirname(outputPath),
          cause,
        }),
    ),
  );
  yield* fs.writeFileString(outputPath, diffText).pipe(
    Effect.mapError(
      (cause) => new CursorSdkPatchIoError({ operation: "write", targetPath: outputPath, cause }),
    ),
  );

  return {
    mode: "write-patch" as const,
    version,
    outputPath,
    updatedFiles: [...result.updatedFiles.keys()],
    applied: result.applied,
  };
});

export const patchCursorSdkCommand = Command.make(
  "patch-cursor-sdk",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify all patch anchors and syntax without writing any files."),
      Flag.withDefault(false),
    ),
    applyInPlace: Flag.Boolean("apply-in-place").pipe(
      Flag.withDescription("Apply patches directly into --source instead of writing a .patch file."),
      Flag.withDefault(false),
    ),
    source: Flag.String("source").pipe(
      Flag.withDescription(
        "Path to an unpatched @cursor/sdk package directory (defaults to reverse-applying the current patch onto node_modules).",
      ),
      Flag.optional,
    ),
    output: Flag.String("output").pipe(
      Flag.withDescription("Output path for the generated unified patch file."),
      Flag.optional,
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("Workspace root directory."),
      Flag.optional,
    ),
  },
  ({ check, applyInPlace, source, output, root }) =>
    patchCursorSdk({
      check,
      applyInPlace,
      sourceDir: Option.getOrUndefined(source),
      outputPath: Option.getOrUndefined(output),
      rootDir: Option.getOrUndefined(root),
    }).pipe(
      Effect.scoped,
      Effect.tap((summary) =>
        Effect.gen(function* () {
          yield* Console.log(
            `[patch-cursor-sdk] @cursor/sdk@${summary.version} (${summary.mode}): ${summary.applied.length} patch sites across ${summary.updatedFiles.length} files`,
          );
          for (const record of summary.applied) {
            yield* Console.log(
              `  - ${record.patchId}/${record.stepId} [${record.target}] -> ${record.file}:${record.line}:${record.column} (${record.spliceCount} splice${record.spliceCount === 1 ? "" : "s"})`,
            );
          }
          if (summary.outputPath) {
            yield* Console.log(`[patch-cursor-sdk] Wrote ${summary.outputPath}`);
          }
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Structurally patch @cursor/sdk minified bundles and regenerate patches/@cursor__sdk@<version>.patch.",
  ),
);

if (import.meta.main) {
  Command.run(patchCursorSdkCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
