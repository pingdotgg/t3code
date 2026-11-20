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
import ts from "typescript-legacy";

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly label: string;
}

export interface PatchedFileResult {
  readonly relativePath: string;
  readonly original: string;
  readonly patched: string;
  readonly appliedPatches: ReadonlyArray<string>;
}

export interface PatchPackageResult {
  readonly version: string;
  readonly files: ReadonlyArray<PatchedFileResult>;
}

export class CursorSdkPatchError extends Schema.TaggedError<CursorSdkPatchError>()(
  "CursorSdkPatchError",
  {
    anchor: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `[patch-cursor-sdk] ${this.anchor}: ${this.detail}`;
  }
}

const isCursorSdkPatchError = Schema.is(CursorSdkPatchError);

class CursorSdkCommandError extends Schema.TaggedError<CursorSdkCommandError>()(
  "CursorSdkCommandError",
  {
    command: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `[patch-cursor-sdk] ${this.command}: ${this.detail}`;
  }
}

const SHELL_STREAM_OUTPUT_SYMBOL = "@cursor/sdk.shellStreamOutput";
const AGENT_PB_MODULE_ID = "../proto/dist/generated/agent/v1/agent_pb.js";

const ATTRIBUTION_PROVIDER_BODY =
  `{get(){try{const{readFileSync:r}=process.getBuiltinModule("node:fs"),` +
  `{join:j}=process.getBuiltinModule("node:path"),` +
  `{homedir:h}=process.getBuiltinModule("node:os"),` +
  `x=process.env.XDG_CONFIG_HOME,` +
  `d=process.env.CURSOR_CONFIG_DIR||(x&&process.platform!=="darwin"&&process.platform!=="win32"?j(x,"cursor"):j(h(),".cursor"));` +
  `return JSON.parse(r(j(d,"cli-config.json"),"utf8"))}catch{return}}}`;

const RESUME_DTS_DECLARATION = [
  "",
  "    /**",
  "     * Continue the saved conversation from its latest checkpoint without a new",
  "     * user message (the protocol's ResumeAction). Local agents only.",
  "     */",
  "    resume?(options?: SendOptions): Promise<Run>;",
].join("\n");

function failPatch(anchor: string, detail: string): never {
  throw new CursorSdkPatchError({ anchor, detail });
}

function assertUniqueMatch<T>(matches: ReadonlyArray<T>, anchor: string): T {
  if (matches.length !== 1) {
    failPatch(anchor, `expected exactly 1 match, found ${matches.length}`);
  }
  return matches[0]!;
}

export function applyTextEdits(source: string, edits: ReadonlyArray<TextEdit>): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 0; i < sorted.length; i++) {
    const edit = sorted[i]!;
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
      failPatch(
        edit.label,
        `edit range [${edit.start}, ${edit.end}] out of bounds (len=${source.length})`,
      );
    }
    const prev = sorted[i - 1];
    if (prev !== undefined && edit.end > prev.start) {
      failPatch(
        edit.label,
        `overlapping edits: ${edit.label} [${edit.start}, ${edit.end}] overlaps ${prev.label} [${prev.start}, ${prev.end}]`,
      );
    }
  }
  let output = source;
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

export function parseSource(
  source: string,
  fileName: string,
  kind: ts.ScriptKind = ts.ScriptKind.JS,
): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

export function assertValidSyntax(
  source: string,
  fileName: string,
  kind: ts.ScriptKind = ts.ScriptKind.JS,
): void {
  const sf = parseSource(source, fileName, kind) as ts.SourceFile & {
    readonly parseDiagnostics?: ReadonlyArray<ts.Diagnostic>;
  };
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    const text = ts.flattenDiagnosticMessageText(first.messageText, " ");
    failPatch(
      `syntax(${fileName})`,
      `patched output has syntax error at ${first.start ?? "?"}: ${text}`,
    );
  }
}

function visit(node: ts.Node, visitor: (node: ts.Node) => boolean | void): void {
  if (visitor(node) === false) {
    return;
  }
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function findObjectProperty(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      if (getPropertyNameText(prop.name) === propName) {
        return prop;
      }
    }
  }
  return undefined;
}

function isBooleanTrueLiteral(expr: ts.Expression): boolean {
  const unwrapped = unwrapParens(expr);
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isNumericLiteral(unwrapped.operand) &&
    unwrapped.operand.text === "0"
  );
}

function isPropertyAccessOnIdent(expr: ts.Expression, propName: string): ts.Identifier | undefined {
  const unwrapped = unwrapParens(expr);
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.name.text === propName
  ) {
    return unwrapped.expression;
  }
  return undefined;
}

function isStrictEqualToTrue(expr: ts.Expression, propName: string): ts.Identifier | undefined {
  const unwrapped = unwrapParens(expr);
  if (!ts.isBinaryExpression(unwrapped)) {
    return undefined;
  }
  if (unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return undefined;
  }
  if (isBooleanTrueLiteral(unwrapped.left)) {
    return isPropertyAccessOnIdent(unwrapped.right, propName);
  }
  if (isBooleanTrueLiteral(unwrapped.right)) {
    return isPropertyAccessOnIdent(unwrapped.left, propName);
  }
  return undefined;
}

function isThisMethodCall(expr: ts.Expression, methodName: string): ts.CallExpression | undefined {
  const unwrapped = unwrapParens(expr);
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    unwrapped.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    unwrapped.expression.name.text === methodName
  ) {
    return unwrapped;
  }
  return undefined;
}

function getProtoMessageClassName(
  node: ts.ClassLikeDeclaration,
  expectedTypeName: string,
): string | undefined {
  let matchesTypeName = false;
  for (const member of node.members) {
    if (
      !ts.isMethodDeclaration(member) ||
      getPropertyNameText(member.name) !== "$" ||
      !member.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) ||
      member.body === undefined
    ) {
      continue;
    }
    for (const stmt of member.body.statements) {
      if (!ts.isReturnStatement(stmt) || stmt.expression === undefined) {
        continue;
      }
      const ret = unwrapParens(stmt.expression);
      if (!ts.isArrayLiteralExpression(ret) || ret.elements.length === 0) {
        continue;
      }
      const first = ret.elements[0]!;
      if (
        ts.isStringLiteral(first) &&
        (first.text === expectedTypeName || first.text.startsWith(`${expectedTypeName}|`))
      ) {
        matchesTypeName = true;
      }
    }
  }
  if (!matchesTypeName) {
    return undefined;
  }
  if (node.name !== undefined) {
    return node.name.text;
  }
  if (ts.isBinaryExpression(node.parent) && ts.isIdentifier(node.parent.left)) {
    return node.parent.left.text;
  }
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function findProtoExportKey(moduleBody: ts.Node, className: string, anchor: string): string {
  const exportKeys: Array<string> = [];
  visit(moduleBody, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "d" ||
      node.arguments.length !== 2
    ) {
      return;
    }
    const mapArg = node.arguments[1]!;
    if (!ts.isObjectLiteralExpression(mapArg)) {
      return;
    }
    for (const prop of mapArg.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        continue;
      }
      const key = getPropertyNameText(prop.name);
      if (key === undefined) {
        continue;
      }
      const init = unwrapParens(prop.initializer);
      if (
        ts.isArrowFunction(init) &&
        !ts.isBlock(init.body) &&
        ts.isIdentifier(init.body) &&
        init.body.text === className
      ) {
        exportKeys.push(key);
      }
    }
  });
  return assertUniqueMatch(exportKeys, anchor);
}

export function findResumeActionExportInWebpackModule(sf: ts.SourceFile): {
  readonly resumeExportKey: string;
  readonly summarizeExportKey: string;
} {
  const moduleBodies: Array<ts.Block> = [];
  visit(sf, (node) => {
    if (
      ts.isMethodDeclaration(node) &&
      getPropertyNameText(node.name) === AGENT_PB_MODULE_ID &&
      node.body !== undefined
    ) {
      moduleBodies.push(node.body);
      return false;
    }
    if (
      ts.isPropertyAssignment(node) &&
      getPropertyNameText(node.name) === AGENT_PB_MODULE_ID &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) &&
      ts.isBlock(node.initializer.body)
    ) {
      moduleBodies.push(node.initializer.body);
      return false;
    }
  });
  const moduleBody = assertUniqueMatch(moduleBodies, `agentPbModule(${sf.fileName})`);

  const resumeClasses: Array<string> = [];
  const summarizeClasses: Array<string> = [];
  visit(moduleBody, (node) => {
    if (!ts.isClassLike(node)) {
      return;
    }
    const resumeName = getProtoMessageClassName(node, "ResumeAction");
    if (resumeName !== undefined) {
      resumeClasses.push(resumeName);
    }
    const summarizeName = getProtoMessageClassName(node, "SummarizeAction");
    if (summarizeName !== undefined) {
      summarizeClasses.push(summarizeName);
    }
  });

  const resumeClass = assertUniqueMatch(resumeClasses, `ResumeActionClass(${sf.fileName})`);
  const summarizeClass = assertUniqueMatch(
    summarizeClasses,
    `SummarizeActionClass(${sf.fileName})`,
  );

  return {
    resumeExportKey: findProtoExportKey(
      moduleBody,
      resumeClass,
      `ResumeActionExport(${sf.fileName})`,
    ),
    summarizeExportKey: findProtoExportKey(
      moduleBody,
      summarizeClass,
      `SummarizeActionExport(${sf.fileName})`,
    ),
  };
}

export function findResumeActionClassInBundle(sf: ts.SourceFile): {
  readonly resumeClassName: string;
  readonly summarizeClassName: string;
} {
  const resumeClasses: Array<string> = [];
  const summarizeClasses: Array<string> = [];
  visit(sf, (node) => {
    if (!ts.isClassLike(node)) {
      return;
    }
    const resumeName = getProtoMessageClassName(node, "ResumeAction");
    if (resumeName !== undefined) {
      resumeClasses.push(resumeName);
    }
    const summarizeName = getProtoMessageClassName(node, "SummarizeAction");
    if (summarizeName !== undefined) {
      summarizeClasses.push(summarizeName);
    }
  });
  return {
    resumeClassName: assertUniqueMatch(resumeClasses, `ResumeActionClass(${sf.fileName})`),
    summarizeClassName: assertUniqueMatch(summarizeClasses, `SummarizeActionClass(${sf.fileName})`),
  };
}

export function collectShellStreamOutputEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  if (sf.text.includes(SHELL_STREAM_OUTPUT_SYMBOL)) {
    failPatch(
      `shellStreamOutput(${sf.fileName})`,
      `file already references ${SHELL_STREAM_OUTPUT_SYMBOL}`,
    );
  }
  const edits: Array<TextEdit> = [];

  visit(sf, (node) => {
    if (!ts.isForOfStatement(node) || node.awaitModifier === undefined) {
      return;
    }
    if (
      !ts.isVariableDeclarationList(node.initializer) ||
      node.initializer.declarations.length !== 1
    ) {
      return;
    }
    const itemDecl = node.initializer.declarations[0]!;
    if (!ts.isIdentifier(itemDecl.name) || !ts.isBlock(node.statement)) {
      return;
    }
    const itemVar = itemDecl.name.text;

    const serializeCalls: Array<{ readonly idVar: string }> = [];
    visit(node.statement, (inner) => {
      if (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "serializeStream" &&
        inner.arguments.length === 2 &&
        ts.isIdentifier(inner.arguments[0]!) &&
        ts.isIdentifier(inner.arguments[1]!) &&
        inner.arguments[1]!.text === itemVar
      ) {
        serializeCalls.push({ idVar: inner.arguments[0]!.text });
      }
    });
    if (serializeCalls.length === 0) {
      return;
    }
    const { idVar } = assertUniqueMatch(
      serializeCalls,
      `shellStreamOutput.serializeStream(${sf.fileName})`,
    );

    let enclosingHandle: ts.MethodDeclaration | undefined;
    let cur: ts.Node | undefined = node.parent;
    while (cur !== undefined) {
      if (ts.isMethodDeclaration(cur) && getPropertyNameText(cur.name) === "handle") {
        enclosingHandle = cur;
        break;
      }
      cur = cur.parent;
    }
    if (enclosingHandle === undefined || enclosingHandle.body === undefined) {
      return;
    }

    const destructuredArgs: Array<string> = [];
    visit(enclosingHandle.body, (inner) => {
      if (!ts.isObjectBindingPattern(inner)) {
        return;
      }
      let matchedId = false;
      let argsVar: string | undefined;
      for (const el of inner.elements) {
        if (!ts.isIdentifier(el.name)) {
          continue;
        }
        const propName =
          el.propertyName !== undefined ? getPropertyNameText(el.propertyName) : el.name.text;
        if (propName === "id" && el.name.text === idVar) {
          matchedId = true;
        } else if (propName === "args") {
          argsVar = el.name.text;
        }
      }
      if (matchedId && argsVar !== undefined) {
        destructuredArgs.push(argsVar);
      }
    });
    const argsVar = assertUniqueMatch(
      destructuredArgs,
      `shellStreamOutput.argsBinding(${sf.fileName})`,
    );

    const insertAt = node.statement.getStart(sf) + 1;
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement:
        `{const __t3h=globalThis[Symbol.for("${SHELL_STREAM_OUTPUT_SYMBOL}")];` +
        `const __t3c=${itemVar}.event?.case;` +
        `if(typeof __t3h==="function"&&(__t3c==="stdout"||__t3c==="stderr"))` +
        `try{__t3h({conversationId:${argsVar}.conversationId,toolCallId:${argsVar}.toolCallId,` +
        `event:{case:__t3c,value:{data:${itemVar}.event.value.data}}})}catch{}}`,
      label: "shellStreamOutput",
    });
  });

  return edits;
}

export function collectAttributionForwardingEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  const edits: Array<TextEdit> = [];

  visit(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) {
      return;
    }
    const mcpMetaProp = findObjectProperty(node, "mcpMetaToolEnabled");
    const mcpThresholdProp = findObjectProperty(node, "mcpFileOutputThresholdBytes");
    const getAgentSkillsProp = findObjectProperty(node, "getAgentSkills");
    if (
      mcpMetaProp === undefined ||
      mcpThresholdProp === undefined ||
      getAgentSkillsProp === undefined ||
      !ts.isPropertyAssignment(mcpMetaProp) ||
      !ts.isPropertyAssignment(mcpThresholdProp)
    ) {
      return;
    }
    const optsFromMeta = isPropertyAccessOnIdent(mcpMetaProp.initializer, "mcpMetaToolEnabled");
    const optsFromThreshold = isPropertyAccessOnIdent(
      mcpThresholdProp.initializer,
      "mcpFileOutputThresholdBytes",
    );
    if (
      optsFromMeta === undefined ||
      optsFromThreshold === undefined ||
      optsFromMeta.text !== optsFromThreshold.text
    ) {
      return;
    }
    if (findObjectProperty(node, "attributionConfigProvider") !== undefined) {
      failPatch(
        `attributionForwarding(${sf.fileName})`,
        "workspace resource options already forward attributionConfigProvider",
      );
    }

    const insertAt = mcpMetaProp.getEnd();
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement: `,attributionConfigProvider:${optsFromMeta.text}.attributionConfigProvider`,
      label: "attributionForwarding",
    });
  });

  return edits;
}

export function collectAttributionResourceFactoryEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  const edits: Array<TextEdit> = [];

  visit(sf, (node) => {
    if (
      !ts.isPropertyAssignment(node) ||
      getPropertyNameText(node.name) !== "resourceFactory" ||
      !ts.isObjectLiteralExpression(node.parent)
    ) {
      return;
    }
    const init = unwrapParens(node.initializer);
    if (!ts.isCallExpression(init) || init.arguments.length !== 1) {
      return;
    }
    const factoryArg = unwrapParens(init.arguments[0]!);
    if (!ts.isObjectLiteralExpression(factoryArg)) {
      return;
    }
    const requiredProps = [
      "ignoreService",
      "grepProvider",
      "workspacePaths",
      "diagnosticsProvider",
      "repositoryProvider",
    ];
    if (!requiredProps.every((prop) => findObjectProperty(factoryArg, prop) !== undefined)) {
      return;
    }
    if (findObjectProperty(factoryArg, "attributionConfigProvider") !== undefined) {
      failPatch(
        `attributionResourceFactory(${sf.fileName})`,
        "resourceFactory call already sets attributionConfigProvider",
      );
    }

    const adaptersObj = node.parent;
    const userSourceCalls: Array<{ readonly fnName: string; readonly sourcesVar: string }> = [];
    visit(adaptersObj, (inner) => {
      if (
        !ts.isPropertyAssignment(inner) ||
        getPropertyNameText(inner.name) !== "includeUserExtensibility"
      ) {
        return;
      }
      const call = unwrapParens(inner.initializer);
      if (
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.arguments.length === 2 &&
        ts.isIdentifier(call.arguments[0]!) &&
        ts.isStringLiteral(call.arguments[1]!) &&
        call.arguments[1]!.text === "user"
      ) {
        userSourceCalls.push({
          fnName: call.expression.text,
          sourcesVar: call.arguments[0]!.text,
        });
      }
    });
    const { fnName, sourcesVar } = assertUniqueMatch(
      userSourceCalls,
      `attributionResourceFactory.userSettingSource(${sf.fileName})`,
    );

    const insertAt = factoryArg.getStart(sf) + 1;
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement: `attributionConfigProvider:${fnName}(${sourcesVar},"user")?${ATTRIBUTION_PROVIDER_BODY}:void 0,`,
      label: "attributionResourceFactory",
    });
  });

  return edits;
}

export type ResolvedProtoCtor =
  | { readonly kind: "member"; readonly exportKey: string }
  | { readonly kind: "identifier"; readonly name: string };

function matchActionNewExpression(
  expr: ts.Expression,
  expectedCase: string,
):
  | {
      readonly actionCtor: ts.Expression;
      readonly valueExpr: ts.Expression;
    }
  | undefined {
  const unwrapped = unwrapParens(expr);
  if (!ts.isNewExpression(unwrapped) || unwrapped.arguments?.length !== 1) {
    return undefined;
  }
  const arg = unwrapParens(unwrapped.arguments[0]!);
  if (!ts.isObjectLiteralExpression(arg)) {
    return undefined;
  }
  const actionProp = findObjectProperty(arg, "action");
  if (actionProp === undefined || !ts.isPropertyAssignment(actionProp)) {
    return undefined;
  }
  const actionObj = unwrapParens(actionProp.initializer);
  if (!ts.isObjectLiteralExpression(actionObj)) {
    return undefined;
  }
  const caseProp = findObjectProperty(actionObj, "case");
  const valueProp = findObjectProperty(actionObj, "value");
  if (
    caseProp === undefined ||
    valueProp === undefined ||
    !ts.isPropertyAssignment(caseProp) ||
    !ts.isPropertyAssignment(valueProp)
  ) {
    return undefined;
  }
  const caseVal = unwrapParens(caseProp.initializer);
  if (!ts.isStringLiteral(caseVal) || caseVal.text !== expectedCase) {
    return undefined;
  }
  return {
    actionCtor: unwrapped.expression,
    valueExpr: unwrapParens(valueProp.initializer),
  };
}

export function collectResumeActionDispatchEdits(
  sf: ts.SourceFile,
  expectedSummarizeCtor: ResolvedProtoCtor,
  resumeCtor: ResolvedProtoCtor,
): ReadonlyArray<TextEdit> {
  const edits: Array<TextEdit> = [];

  visit(sf, (node) => {
    if (!ts.isConditionalExpression(node)) {
      return;
    }
    const reqVar = isStrictEqualToTrue(node.condition, "summarize");
    if (reqVar === undefined) {
      return;
    }
    const summarizeBranch = matchActionNewExpression(node.whenTrue, "summarizeAction");
    const userMsgBranch = matchActionNewExpression(node.whenFalse, "userMessageAction");
    if (summarizeBranch === undefined || userMsgBranch === undefined) {
      return;
    }
    if (
      ts.isConditionalExpression(node.parent) &&
      isStrictEqualToTrue(node.parent.condition, "resume") !== undefined
    ) {
      failPatch(
        `resumeActionDispatch(${sf.fileName})`,
        "resumeAction dispatch branch already exists",
      );
    }
    if (!ts.isNewExpression(summarizeBranch.valueExpr)) {
      failPatch(
        `resumeActionDispatch(${sf.fileName})`,
        "expected summarizeAction value to be a NewExpression",
      );
    }

    const summarizeValueCtor = summarizeBranch.valueExpr.expression;
    let resumeCtorExpr: string;
    if (expectedSummarizeCtor.kind === "member" && resumeCtor.kind === "member") {
      if (
        !ts.isPropertyAccessExpression(summarizeValueCtor) ||
        !ts.isIdentifier(summarizeValueCtor.expression) ||
        summarizeValueCtor.name.text !== expectedSummarizeCtor.exportKey
      ) {
        failPatch(
          `resumeActionDispatch(${sf.fileName})`,
          `expected summarizeAction ctor *.${expectedSummarizeCtor.exportKey}, got ${summarizeValueCtor.getText(sf)}`,
        );
      }
      resumeCtorExpr = `${summarizeValueCtor.expression.text}.${resumeCtor.exportKey}`;
    } else if (expectedSummarizeCtor.kind === "identifier" && resumeCtor.kind === "identifier") {
      if (
        !ts.isIdentifier(summarizeValueCtor) ||
        summarizeValueCtor.text !== expectedSummarizeCtor.name
      ) {
        failPatch(
          `resumeActionDispatch(${sf.fileName})`,
          `expected summarizeAction ctor ${expectedSummarizeCtor.name}, got ${summarizeValueCtor.getText(sf)}`,
        );
      }
      resumeCtorExpr = resumeCtor.name;
    } else {
      failPatch(`resumeActionDispatch(${sf.fileName})`, "mismatched ctor kind");
    }

    const actionCtorText = summarizeBranch.actionCtor.getText(sf);
    const insertAt = node.getStart(sf);
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement: `${reqVar.text}.resume===!0?new ${actionCtorText}({action:{case:"resumeAction",value:new ${resumeCtorExpr}}}):`,
      label: "resumeActionDispatch",
    });
  });

  return edits;
}

export function collectLocalAgentResumeMethodEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  const edits: Array<TextEdit> = [];

  visit(sf, (node) => {
    if (
      !ts.isMethodDeclaration(node) ||
      getPropertyNameText(node.name) !== "summarize" ||
      node.parameters.length !== 0 ||
      node.body === undefined ||
      !node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword) ||
      !ts.isClassLike(node.parent)
    ) {
      return;
    }

    let hasGetAgent = false;
    const sendImplCalls: Array<ts.CallExpression> = [];
    visit(node.body, (inner) => {
      if (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "getAgent" &&
        inner.expression.expression.getText(sf) === "this.platform.store"
      ) {
        hasGetAgent = true;
      }
      const sendImpl = ts.isExpression(inner) ? isThisMethodCall(inner, "sendImpl") : undefined;
      if (sendImpl !== undefined && sendImpl.arguments.length >= 2) {
        sendImplCalls.push(sendImpl);
      }
    });
    if (!hasGetAgent || sendImplCalls.length === 0) {
      return;
    }

    const parentClass = node.parent;
    if (
      parentClass.members.some(
        (member) =>
          (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
          getPropertyNameText(member.name) === "resume",
      )
    ) {
      failPatch(
        `localAgentResumeMethod(${sf.fileName})`,
        "local agent class already defines resume()",
      );
    }

    const sendImplCall = assertUniqueMatch(
      sendImplCalls,
      `localAgentResumeMethod.sendImpl(${sf.fileName})`,
    );
    const sendArg0 = unwrapParens(sendImplCall.arguments[0]!);
    const sendArg1 = unwrapParens(sendImplCall.arguments[1]!);
    if (
      !ts.isObjectLiteralExpression(sendArg0) ||
      findObjectProperty(sendArg0, "summarize") === undefined ||
      !ts.isObjectLiteralExpression(sendArg1) ||
      sendArg1.properties.length !== 0
    ) {
      failPatch(
        `localAgentResumeMethod(${sf.fileName})`,
        `unexpected sendImpl args in summarize(): ${sendImplCall.getText(sf)}`,
      );
    }

    const methodStart = node.getStart(sf);
    const methodSource = sf.text.slice(methodStart, node.getEnd());
    const innerEdits: Array<TextEdit> = [];

    const nameStart = node.name.getStart(sf) - methodStart;
    const closeParenPos = sf.text.indexOf(")", node.name.getEnd());
    if (closeParenPos === -1 || closeParenPos >= node.body.getStart(sf)) {
      failPatch(`localAgentResumeMethod(${sf.fileName})`, "could not locate summarize() parens");
    }
    innerEdits.push({
      start: nameStart,
      end: closeParenPos + 1 - methodStart,
      replacement: "resume(__t3o={})",
      label: "resume.signature",
    });

    const summarizeMsgMatches: Array<{ readonly start: number; readonly end: number }> = [];
    const opStringMatches: Array<{ readonly start: number; readonly end: number }> = [];
    visit(node.body, (inner) => {
      if (ts.isTemplateTail(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
        const raw = sf.text.slice(inner.getStart(sf), inner.getEnd());
        const needle = " to summarize yet.";
        const offset = raw.indexOf(needle);
        if (offset !== -1) {
          summarizeMsgMatches.push({
            start: inner.getStart(sf) + offset - methodStart,
            end: inner.getStart(sf) + offset + needle.length - methodStart,
          });
        }
      } else if (ts.isStringLiteral(inner) && inner.text === "agent.summarize") {
        opStringMatches.push({
          start: inner.getStart(sf) - methodStart,
          end: inner.getEnd() - methodStart,
        });
      }
    });

    const msgMatch = assertUniqueMatch(
      summarizeMsgMatches,
      `localAgentResumeMethod.noSavedConversationMessage(${sf.fileName})`,
    );
    innerEdits.push({
      start: msgMatch.start,
      end: msgMatch.end,
      replacement: " to resume yet.",
      label: "resume.errorMessage",
    });

    innerEdits.push({
      start: sendArg0.getStart(sf) - methodStart,
      end: sendArg0.getEnd() - methodStart,
      replacement: '{text:"",resume:!0}',
      label: "resume.sendImplArg0",
    });
    innerEdits.push({
      start: sendArg1.getStart(sf) - methodStart,
      end: sendArg1.getEnd() - methodStart,
      replacement: "__t3o",
      label: "resume.sendImplArg1",
    });

    if (opStringMatches.length !== 2) {
      failPatch(
        `localAgentResumeMethod.operationLiterals(${sf.fileName})`,
        `expected exactly 2 "agent.summarize" literals, found ${opStringMatches.length}`,
      );
    }
    for (const opMatch of opStringMatches) {
      innerEdits.push({
        start: opMatch.start,
        end: opMatch.end,
        replacement: '"agent.resume"',
        label: "resume.operation",
      });
    }

    const resumeMethodSource = applyTextEdits(methodSource, innerEdits);
    if (resumeMethodSource.toLowerCase().includes("summarize")) {
      failPatch(
        `localAgentResumeMethod(${sf.fileName})`,
        `generated resume() still contains "summarize": ${resumeMethodSource}`,
      );
    }

    edits.push({
      start: methodStart,
      end: methodStart,
      replacement: resumeMethodSource,
      label: "localAgentResumeMethod",
    });
  });

  return edits;
}

export function collectModelListCacheRetryEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  const resolveMethods: Array<ts.MethodDeclaration> = [];
  const listMethods: Array<ts.MethodDeclaration> = [];

  visit(sf, (node) => {
    if (!ts.isMethodDeclaration(node) || node.body === undefined) {
      return;
    }
    const name = getPropertyNameText(node.name);
    if (name === "resolveLocalModelSelection") {
      resolveMethods.push(node);
    } else if (name === "listModelsForLocalValidation") {
      listMethods.push(node);
    }
  });

  const resolveMethod = assertUniqueMatch(
    resolveMethods,
    `modelListCacheRetry.resolveLocalModelSelection(${sf.fileName})`,
  );
  const listMethod = assertUniqueMatch(
    listMethods,
    `modelListCacheRetry.listModelsForLocalValidation(${sf.fileName})`,
  );

  if (
    resolveMethod.parameters.length !== 3 ||
    !ts.isIdentifier(resolveMethod.parameters[0]!.name)
  ) {
    failPatch(
      `modelListCacheRetry.resolveParams(${sf.fileName})`,
      `expected 3 parameters on resolveLocalModelSelection, found ${resolveMethod.parameters.length}`,
    );
  }
  const selectionParam = resolveMethod.parameters[0]!.name.text;

  const listCalls: Array<ts.CallExpression> = [];
  visit(resolveMethod.body!, (inner) => {
    const call = ts.isExpression(inner)
      ? isThisMethodCall(inner, "listModelsForLocalValidation")
      : undefined;
    if (call !== undefined) {
      listCalls.push(call);
    }
  });
  const listCall = assertUniqueMatch(listCalls, `modelListCacheRetry.listCall(${sf.fileName})`);
  if (listCall.arguments.length !== 2) {
    failPatch(
      `modelListCacheRetry.listCallArgs(${sf.fileName})`,
      `expected 2 arguments to listModelsForLocalValidation, found ${listCall.arguments.length}`,
    );
  }

  if (
    listMethod.parameters.length !== 2 ||
    !ts.isIdentifier(listMethod.parameters[0]!.name) ||
    !ts.isIdentifier(listMethod.parameters[1]!.name)
  ) {
    failPatch(
      `modelListCacheRetry.listParams(${sf.fileName})`,
      `expected 2 identifier parameters on listModelsForLocalValidation, found ${listMethod.parameters.length}`,
    );
  }
  const apiKeyParam = listMethod.parameters[0]!.name.text;
  const teamIdParam = listMethod.parameters[1]!.name.text;

  const cacheGetMatches: Array<{
    readonly entryVar: string;
    readonly keyVar: string;
    readonly statement: ts.VariableStatement;
  }> = [];
  visit(listMethod.body!, (inner) => {
    if (
      !ts.isVariableDeclaration(inner) ||
      !ts.isIdentifier(inner.name) ||
      inner.initializer === undefined
    ) {
      return;
    }
    const init = unwrapParens(inner.initializer);
    if (
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === "get" &&
      init.expression.expression.getText(sf) === "this.localModelListCache" &&
      init.arguments.length === 1 &&
      ts.isIdentifier(init.arguments[0]!) &&
      ts.isVariableDeclarationList(inner.parent) &&
      ts.isVariableStatement(inner.parent.parent)
    ) {
      cacheGetMatches.push({
        entryVar: inner.name.text,
        keyVar: init.arguments[0]!.text,
        statement: inner.parent.parent,
      });
    }
  });
  const cacheGet = assertUniqueMatch(
    cacheGetMatches,
    `modelListCacheRetry.cacheGet(${sf.fileName})`,
  );

  const stmts = listMethod.body!.statements;
  const lastStmt = stmts[stmts.length - 1];
  if (
    lastStmt === undefined ||
    !ts.isTryStatement(lastStmt) ||
    lastStmt.catchClause === undefined ||
    lastStmt.tryBlock.statements.length !== 1
  ) {
    failPatch(
      `modelListCacheRetry.tryCatch(${sf.fileName})`,
      "expected trailing try/catch with single return statement in listModelsForLocalValidation",
    );
  }
  const tryReturn = lastStmt.tryBlock.statements[0]!;
  if (
    !ts.isReturnStatement(tryReturn) ||
    tryReturn.expression === undefined ||
    !ts.isAwaitExpression(tryReturn.expression) ||
    !ts.isIdentifier(tryReturn.expression.expression) ||
    tryReturn.expression.expression.text !== cacheGet.entryVar
  ) {
    failPatch(
      `modelListCacheRetry.tryReturn(${sf.fileName})`,
      `expected "return await ${cacheGet.entryVar}" inside try block`,
    );
  }

  let hasCacheDelete = false;
  visit(lastStmt.catchClause.block, (inner) => {
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === "delete" &&
      inner.expression.expression.getText(sf) === "this.localModelListCache" &&
      inner.arguments.length === 1 &&
      ts.isIdentifier(inner.arguments[0]!) &&
      inner.arguments[0]!.text === cacheGet.keyVar
    ) {
      hasCacheDelete = true;
    }
  });
  if (!hasCacheDelete) {
    failPatch(
      `modelListCacheRetry.catchDelete(${sf.fileName})`,
      `expected this.localModelListCache.delete(${cacheGet.keyVar}) in catch block`,
    );
  }

  const arg1End = listCall.arguments[1]!.getEnd();
  const teamParamEnd = listMethod.parameters[1]!.getEnd();
  const cacheStmtEnd = cacheGet.statement.getEnd();
  const tryStart = lastStmt.getStart(sf);
  const tryEnd = lastStmt.getEnd();

  return [
    {
      start: arg1End,
      end: arg1End,
      replacement: `,${selectionParam}.id`,
      label: "modelListCacheRetry.passRequestedId",
    },
    {
      start: teamParamEnd,
      end: teamParamEnd,
      replacement: ",__t3id",
      label: "modelListCacheRetry.addIdParam",
    },
    {
      start: cacheStmtEnd,
      end: cacheStmtEnd,
      replacement: `const __t3miss=${cacheGet.entryVar}===void 0;`,
      label: "modelListCacheRetry.recordMiss",
    },
    {
      start: tryStart,
      end: tryStart,
      replacement: "let __t3models;",
      label: "modelListCacheRetry.declareModels",
    },
    {
      start: tryReturn.getStart(sf),
      end: tryReturn.getEnd(),
      replacement: `__t3models=await ${cacheGet.entryVar}`,
      label: "modelListCacheRetry.captureModels",
    },
    {
      start: tryEnd,
      end: tryEnd,
      replacement:
        `if(__t3miss||__t3id===void 0||__t3models.some((__t3m)=>__t3m.id===__t3id||__t3m.aliases?.includes(__t3id)===!0))return __t3models;` +
        `if(this.localModelListCache.get(${cacheGet.keyVar})===${cacheGet.entryVar})this.localModelListCache.delete(${cacheGet.keyVar});` +
        `return this.listModelsForLocalValidation(${apiKeyParam},${teamIdParam});`,
      label: "modelListCacheRetry.retryOnCacheMiss",
    },
  ];
}

export function collectAgentDtsResumeEdits(sf: ts.SourceFile): ReadonlyArray<TextEdit> {
  const sdkAgents: Array<ts.InterfaceDeclaration> = [];
  visit(sf, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "SDKAgent") {
      sdkAgents.push(node);
    }
  });
  const sdkAgent = assertUniqueMatch(sdkAgents, `agentDts.SDKAgent(${sf.fileName})`);
  if (
    sdkAgent.members.some(
      (member) =>
        (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
        getPropertyNameText(member.name) === "resume",
    )
  ) {
    failPatch(`agentDts.resume(${sf.fileName})`, "SDKAgent already declares resume");
  }
  const summarizeMembers = sdkAgent.members.filter(
    (member): member is ts.MethodSignature =>
      ts.isMethodSignature(member) && getPropertyNameText(member.name) === "summarize",
  );
  const summarizeMember = assertUniqueMatch(summarizeMembers, `agentDts.summarize(${sf.fileName})`);
  const insertAt = summarizeMember.getEnd();
  return [
    {
      start: insertAt,
      end: insertAt,
      replacement: RESUME_DTS_DECLARATION,
      label: "agentDts.resume",
    },
  ];
}

const CHUNK_PREFILTER_SENTINELS = [
  "serializeStream",
  "mcpMetaToolEnabled",
  "resourceFactory",
  "summarizeAction",
];

function patchFormatDirectory(
  format: "esm" | "cjs",
  readFile: (relativePath: string) => string,
  listJsFiles: (relativeDir: string) => ReadonlyArray<string>,
): ReadonlyArray<PatchedFileResult> {
  const results: Array<PatchedFileResult> = [];

  // 1. dist/<format>/agent.d.ts
  const agentDtsPath = `dist/${format}/agent.d.ts`;
  const agentDtsOriginal = readFile(agentDtsPath);
  const agentDtsSf = parseSource(agentDtsOriginal, agentDtsPath, ts.ScriptKind.TS);
  const agentDtsEdits = collectAgentDtsResumeEdits(agentDtsSf);
  const agentDtsPatched = applyTextEdits(agentDtsOriginal, agentDtsEdits);
  assertValidSyntax(agentDtsPatched, agentDtsPath, ts.ScriptKind.TS);
  results.push({
    relativePath: agentDtsPath,
    original: agentDtsOriginal,
    patched: agentDtsPatched,
    appliedPatches: agentDtsEdits.map((e) => e.label),
  });

  // 2. dist/<format>/index.js
  const indexPath = `dist/${format}/index.js`;
  const indexOriginal = readFile(indexPath);
  const indexSf = parseSource(indexOriginal, indexPath, ts.ScriptKind.JS);
  const { resumeExportKey, summarizeExportKey } = findResumeActionExportInWebpackModule(indexSf);
  const indexResumeEdits = collectLocalAgentResumeMethodEdits(indexSf);
  assertUniqueMatch(indexResumeEdits, `localAgentResumeMethod(${indexPath})`);
  const indexCacheEdits = collectModelListCacheRetryEdits(indexSf);
  const indexEdits = [...indexResumeEdits, ...indexCacheEdits];
  const indexPatched = applyTextEdits(indexOriginal, indexEdits);
  assertValidSyntax(indexPatched, indexPath, ts.ScriptKind.JS);
  results.push({
    relativePath: indexPath,
    original: indexOriginal,
    patched: indexPatched,
    appliedPatches: ["localAgentResumeMethod", "modelListCacheRetry"],
  });

  // 3. dist/<format>/*.js chunks (dynamic chunk discovery — never hardcode chunk numbers)
  const chunkFiles = listJsFiles(`dist/${format}`).filter(
    (name) => name !== "index.js" && name !== "sqlite.js",
  );
  const chunkEditsByPath = new Map<
    string,
    { readonly original: string; readonly edits: Array<TextEdit> }
  >();
  const anchorHits = {
    shellStreamOutput: 0,
    attributionForwarding: 0,
    attributionResourceFactory: 0,
    resumeActionDispatch: 0,
  };

  for (const name of chunkFiles) {
    const relPath = `dist/${format}/${name}`;
    const original = readFile(relPath);
    if (!CHUNK_PREFILTER_SENTINELS.some((s) => original.includes(s))) {
      continue;
    }
    const sf = parseSource(original, relPath, ts.ScriptKind.JS);
    const fileEdits: Array<TextEdit> = [];

    const shellEdits = collectShellStreamOutputEdits(sf);
    anchorHits.shellStreamOutput += shellEdits.length;
    fileEdits.push(...shellEdits);

    const attrFwdEdits = collectAttributionForwardingEdits(sf);
    anchorHits.attributionForwarding += attrFwdEdits.length;
    fileEdits.push(...attrFwdEdits);

    const attrFactoryEdits = collectAttributionResourceFactoryEdits(sf);
    anchorHits.attributionResourceFactory += attrFactoryEdits.length;
    fileEdits.push(...attrFactoryEdits);

    const resumeDispatchEdits = collectResumeActionDispatchEdits(
      sf,
      { kind: "member", exportKey: summarizeExportKey },
      { kind: "member", exportKey: resumeExportKey },
    );
    anchorHits.resumeActionDispatch += resumeDispatchEdits.length;
    fileEdits.push(...resumeDispatchEdits);

    if (fileEdits.length > 0) {
      chunkEditsByPath.set(relPath, { original, edits: fileEdits });
    }
  }

  for (const [anchor, count] of Object.entries(anchorHits)) {
    if (count !== 1) {
      failPatch(
        `${anchor}(dist/${format}/*)`,
        `expected exactly 1 match across chunks, found ${count}`,
      );
    }
  }

  for (const [relPath, { original, edits }] of chunkEditsByPath) {
    const patched = applyTextEdits(original, edits);
    assertValidSyntax(patched, relPath, ts.ScriptKind.JS);
    results.push({
      relativePath: relPath,
      original,
      patched,
      appliedPatches: edits.map((e) => e.label),
    });
  }

  return results;
}

function patchBundledFile(readFile: (relativePath: string) => string): PatchedFileResult {
  const bundledPath = "dist/bundled/index.js";
  const original = readFile(bundledPath);
  const sf = parseSource(original, bundledPath, ts.ScriptKind.JS);

  const { resumeClassName, summarizeClassName } = findResumeActionClassInBundle(sf);
  const shellEdit = assertUniqueMatch(
    collectShellStreamOutputEdits(sf),
    `shellStreamOutput(${bundledPath})`,
  );
  const attrFwdEdit = assertUniqueMatch(
    collectAttributionForwardingEdits(sf),
    `attributionForwarding(${bundledPath})`,
  );
  const attrFactoryEdit = assertUniqueMatch(
    collectAttributionResourceFactoryEdits(sf),
    `attributionResourceFactory(${bundledPath})`,
  );
  const resumeDispatchEdit = assertUniqueMatch(
    collectResumeActionDispatchEdits(
      sf,
      { kind: "identifier", name: summarizeClassName },
      { kind: "identifier", name: resumeClassName },
    ),
    `resumeActionDispatch(${bundledPath})`,
  );
  const resumeMethodEdit = assertUniqueMatch(
    collectLocalAgentResumeMethodEdits(sf),
    `localAgentResumeMethod(${bundledPath})`,
  );
  const cacheEdits = collectModelListCacheRetryEdits(sf);

  const allEdits = [
    shellEdit,
    attrFwdEdit,
    attrFactoryEdit,
    resumeDispatchEdit,
    resumeMethodEdit,
    ...cacheEdits,
  ];
  const patched = applyTextEdits(original, allEdits);
  assertValidSyntax(patched, bundledPath, ts.ScriptKind.JS);

  return {
    relativePath: bundledPath,
    original,
    patched,
    appliedPatches: [
      "shellStreamOutput",
      "attributionForwarding",
      "attributionResourceFactory",
      "resumeActionDispatch",
      "localAgentResumeMethod",
      "modelListCacheRetry",
    ],
  };
}

const PackageManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifestSchema);

export const patchCursorSdkPackage = Effect.fn("patchCursorSdkPackage")(function* (
  packageDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJsonText = yield* fs.readFileString(pkgJsonPath);
  const pkgJson = yield* decodePackageManifest(pkgJsonText).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchError({
          anchor: "package.json",
          detail: `failed to parse ${pkgJsonPath}: ${String(cause)}`,
        }),
    ),
  );
  if (pkgJson.name !== "@cursor/sdk" || typeof pkgJson.version !== "string") {
    return yield* new CursorSdkPatchError({
      anchor: "package.json",
      detail: `expected @cursor/sdk package.json in ${packageDir}, got name=${String(pkgJson.name)}`,
    });
  }

  const fileContents = new Map<string, string>();
  const jsFilesByDir = new Map<string, ReadonlyArray<string>>();

  const preloadDir = Effect.fn("patchCursorSdk.preloadDir")(function* (relativeDir: string) {
    const entries = yield* fs.readDirectory(path.join(packageDir, relativeDir));
    const jsFiles = entries.filter((name) => name.endsWith(".js")).sort();
    jsFilesByDir.set(relativeDir, jsFiles);
    for (const name of jsFiles) {
      const relPath = `${relativeDir}/${name}`;
      fileContents.set(relPath, yield* fs.readFileString(path.join(packageDir, relPath)));
    }
  });

  yield* preloadDir("dist/esm");
  yield* preloadDir("dist/cjs");
  fileContents.set(
    "dist/esm/agent.d.ts",
    yield* fs.readFileString(path.join(packageDir, "dist/esm/agent.d.ts")),
  );
  fileContents.set(
    "dist/cjs/agent.d.ts",
    yield* fs.readFileString(path.join(packageDir, "dist/cjs/agent.d.ts")),
  );
  fileContents.set(
    "dist/bundled/index.js",
    yield* fs.readFileString(path.join(packageDir, "dist/bundled/index.js")),
  );

  const readFile = (relativePath: string): string => {
    const content = fileContents.get(relativePath);
    if (content === undefined) {
      failPatch("readFile", `missing expected file ${relativePath}`);
    }
    return content;
  };
  const listJsFiles = (relativeDir: string): ReadonlyArray<string> =>
    jsFilesByDir.get(relativeDir) ?? [];

  const files = yield* Effect.try({
    try: () =>
      [
        patchBundledFile(readFile),
        ...patchFormatDirectory("cjs", readFile, listJsFiles),
        ...patchFormatDirectory("esm", readFile, listJsFiles),
      ].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    catch: (error) =>
      isCursorSdkPatchError(error)
        ? error
        : new CursorSdkPatchError({
            anchor: "unexpected",
            detail: error instanceof Error ? error.message : String(error),
          }),
  });

  return { version: pkgJson.version, files } satisfies PatchPackageResult;
});

const runCommand = Effect.fn("patchCursorSdk.runCommand")(function* (
  cmd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly allowedExitCodes?: ReadonlyArray<number>;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const proc = ChildProcess.make(cmd, [...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(proc);
      const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
        Stream.runCollect(handle.stdout),
        Stream.runCollect(handle.stderr),
        handle.exitCode,
      ]);
      const decoder = new TextDecoder();
      const stdout =
        stdoutChunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
        decoder.decode();
      const stderr =
        stderrChunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
        decoder.decode();
      const allowed = options.allowedExitCodes ?? [0];
      if (!allowed.includes(exitCode)) {
        return yield* new CursorSdkCommandError({
          command: `${cmd} ${args.join(" ")}`,
          detail: `exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        });
      }
      return { stdout, stderr, exitCode };
    }),
  );
});

export const generateUnifiedPatch = Effect.fn("generateUnifiedPatch")(function* (
  files: ReadonlyArray<PatchedFileResult>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-diff-" });
      for (const file of files) {
        const origPath = path.join(tmpDir, "a", file.relativePath);
        const patchedPath = path.join(tmpDir, "b", file.relativePath);
        yield* fs.makeDirectory(path.dirname(origPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(patchedPath), { recursive: true });
        yield* fs.writeFileString(origPath, file.original);
        yield* fs.writeFileString(patchedPath, file.patched);
      }
      const { stdout } = yield* runCommand(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "diff",
          "--no-index",
          "--no-prefix",
          "--full-index",
          "--",
          "a",
          "b",
        ],
        { cwd: tmpDir, allowedExitCodes: [0, 1] },
      );
      return stdout;
    }),
  );
});

const resolveDefaultVersion = Effect.fn("patchCursorSdk.resolveDefaultVersion")(function* (
  rootDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(rootDir, "packages/provider-cursor/package.json");
  const pkg = yield* decodePackageManifest(yield* fs.readFileString(manifestPath)).pipe(
    Effect.mapError(
      (cause) =>
        new CursorSdkPatchError({
          anchor: "version",
          detail: `failed to parse ${manifestPath}: ${String(cause)}`,
        }),
    ),
  );
  const version = pkg.dependencies?.["@cursor/sdk"];
  if (typeof version !== "string" || version.length === 0) {
    return yield* new CursorSdkPatchError({
      anchor: "version",
      detail: `could not read @cursor/sdk version from ${manifestPath}`,
    });
  }
  return version;
});

const extractTarballToTempDir = Effect.fn("patchCursorSdk.extractTarball")(function* (
  tarballPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-extract-" });
  yield* runCommand("tar", ["-xzf", tarballPath, "-C", tmpDir]);
  return path.join(tmpDir, "package");
});

const fetchVersionToTempDir = Effect.fn("patchCursorSdk.fetchVersion")(function* (version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-pack-" });
  const { stdout } = yield* runCommand("npm", [
    "pack",
    `@cursor/sdk@${version}`,
    "--pack-destination",
    tmpDir,
  ]);
  const tarballName = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (tarballName === undefined) {
    return yield* new CursorSdkCommandError({
      command: `npm pack @cursor/sdk@${version}`,
      detail: `could not determine packed tarball filename from stdout: ${stdout}`,
    });
  }
  return yield* extractTarballToTempDir(path.join(tmpDir, tarballName));
});

export const patchCursorSdkCommand = Command.make(
  "patch-cursor-sdk",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Dry-run: verify all structural anchors match uniquely without writing.",
      ),
      Flag.withDefault(false),
    ),
    sdkVersion: Flag.String("sdk-version").pipe(
      Flag.withDescription("Upstream @cursor/sdk version to fetch via npm pack."),
      Flag.optional,
    ),
    dir: Flag.String("dir").pipe(
      Flag.withDescription("Path to an extracted unpatched @cursor/sdk package directory."),
      Flag.optional,
    ),
    tarball: Flag.String("tarball").pipe(
      Flag.withDescription("Path to an unpatched @cursor/sdk .tgz tarball."),
      Flag.optional,
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Output patch path (defaults to patches/@cursor__sdk@<version>.patch)."),
      Flag.optional,
    ),
  },
  ({ check, sdkVersion, dir, tarball, out }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = process.cwd();

        const dirOpt = Option.getOrUndefined(dir);
        const tarballOpt = Option.getOrUndefined(tarball);
        const versionOpt = Option.getOrUndefined(sdkVersion);
        if (dirOpt !== undefined && tarballOpt !== undefined) {
          return yield* new CursorSdkPatchError({
            anchor: "cli",
            detail: "pass at most one of --dir or --tarball",
          });
        }

        const packageDir =
          dirOpt !== undefined
            ? path.resolve(dirOpt)
            : tarballOpt !== undefined
              ? yield* extractTarballToTempDir(path.resolve(tarballOpt))
              : yield* fetchVersionToTempDir(versionOpt ?? (yield* resolveDefaultVersion(rootDir)));

        const result = yield* patchCursorSdkPackage(packageDir);
        const outPath = path.resolve(
          Option.getOrUndefined(out) ??
            path.join(rootDir, "patches", `@cursor__sdk@${result.version}.patch`),
        );

        for (const file of result.files) {
          yield* Console.log(`  ${file.relativePath}: ${file.appliedPatches.join(", ")}`);
        }

        if (check) {
          yield* Console.log(
            `OK: all ${result.files.length} files matched uniquely for @cursor/sdk@${result.version} (dry-run).`,
          );
          return;
        }

        const patchText = yield* generateUnifiedPatch(result.files);
        yield* fs.makeDirectory(path.dirname(outPath), { recursive: true });
        yield* fs.writeFileString(outPath, patchText);
        yield* Console.log(
          `Wrote ${path.relative(rootDir, outPath)} (${(patchText.length / 1024 / 1024).toFixed(2)} MiB) for @cursor/sdk@${result.version}.`,
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Structurally patch an unpatched @cursor/sdk package and emit a pnpm patch file.",
  ),
);

if (import.meta.main) {
  Command.run(patchCursorSdkCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
