// The kinds of question a workflow declares, and the check that its asks use only those.
import * as NodeModule from "node:module";

import * as Acorn from "acorn";

/** What `workflow(…)`'s `asks` declares: each kind of question with the label a list shows. */
export type AskKinds = Readonly<Record<string, string>>;

const listed = (kinds: AskKinds) => {
  const names = Object.keys(kinds);
  return names.length === 0
    ? "It declares none"
    : `It declares ${names.map((name) => `\`${name}\``).join(", ")}`;
};

/** What is wrong with an ask of `kind` in `workflow`, or undefined when the kind is declared. */
export const undeclaredKind = (
  workflow: string,
  kinds: AskKinds,
  kind: string,
  ask: string | undefined,
): string | undefined =>
  Object.hasOwn(kinds, kind)
    ? undefined
    : `Workflow ${workflow} asks ${ask === undefined ? "a question" : `"${ask}"`} of kind "${kind}", which it does not declare. ${listed(kinds)}. Add the kind to the workflow's \`asks\`, or fix the kind.`;

/** The `asks` a workflow was given, refused when it is not kinds with a label each. */
export const checkAskKinds = (workflow: string, asks: unknown): AskKinds => {
  if (asks === undefined) return {};
  const example = 'as in asks: { feature: "Feature wanted?" }';
  if (typeof asks !== "object" || asks === null || Array.isArray(asks)) {
    throw new Error(`workflow("${workflow}")'s asks is each kind with its label, ${example}.`);
  }
  for (const [kind, label] of Object.entries(asks)) {
    if (kind.trim() === "" || typeof label !== "string" || label.trim() === "") {
      throw new Error(
        `workflow("${workflow}")'s asks gives the kind "${kind}" no label. Each kind takes one, ${example}.`,
      );
    }
  }
  return { ...(asks as AskKinds) };
};

type Node = Acorn.AnyNode;

/** The text an expression is whenever it runs, when the source alone says so. */
const literals = (node: Node | undefined): ReadonlyArray<string> => {
  if (node === undefined) return [];
  if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
  if (node.type === "TemplateLiteral") {
    const text = node.quasis[0]?.value.cooked;
    return node.expressions.length === 0 && typeof text === "string" ? [text] : [];
  }
  if (node.type === "ConditionalExpression") {
    return [...literals(node.consequent), ...literals(node.alternate)];
  }
  return [];
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The parts of a node that are code, without the names that only label a part of something. */
const children = (node: Node): ReadonlyArray<Node> => {
  const named =
    (node.type === "MemberExpression" && !node.computed && node.property) ||
    ((node.type === "Property" ||
      node.type === "MethodDefinition" ||
      node.type === "PropertyDefinition") &&
      !node.computed &&
      node.key);
  return Object.values(node).flatMap((child) =>
    (Array.isArray(child) ? child : [child]).filter(
      (item): item is Node => isNode(item) && item !== named,
    ),
  );
};

const PARSE = {
  ecmaVersion: "latest",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
} as const;

/** The file as a syntax tree, or undefined when it is not code this can read. */
const parsed = (source: string): Node | undefined => {
  const attempt = (text: string) => {
    for (const sourceType of ["module", "script"] as const) {
      try {
        return Acorn.parse(text, { ...PARSE, sourceType });
      } catch {
        // Tried as the next form.
      }
    }
    return undefined;
  };
  const plain = attempt(source);
  if (plain !== undefined || typeof NodeModule.stripTypeScriptTypes !== "function") return plain;
  try {
    // Only for a file with type annotations: Node blanks them out, as it does to run the file.
    return attempt(NodeModule.stripTypeScriptTypes(source));
  } catch {
    return undefined;
  }
};

/** The name of a property written out, as `{ ask }` or `{ "ask": … }` writes one. */
const keyOf = (property: Acorn.Property | Acorn.AssignmentProperty): string | undefined => {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : undefined;
};

/**
 * Which names in the file are parts of `T3`, and what part each is: `const { ask } = T3`,
 * `const { ask: question } = T3` and `const ask = T3.ask`. A name the file also uses any other
 * way than calling it is left out, since it may be something of the file's own by then.
 */
const partsOfT3 = (tree: Node): ReadonlyMap<string, string> => {
  const parts = new Map<string, string>();
  const other = new Set<string>();
  // A list of what is left to visit, not recursion, so deeply nested code cannot overflow.
  const left: Array<Node> = [tree];
  for (let node = left.pop(); node !== undefined; node = left.pop()) {
    if (node.type === "Identifier") {
      other.add(node.name);
      continue;
    }
    if (node.type === "VariableDeclarator" && node.init?.type === "Identifier") {
      if (node.init.name === "T3" && node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          const part = property.type === "Property" ? keyOf(property) : undefined;
          if (part !== undefined && property.type === "Property") {
            if (property.value.type === "Identifier") parts.set(property.value.name, part);
            else left.push(property.value);
          } else {
            left.push(property);
          }
        }
        continue;
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "MemberExpression" &&
      !node.init.computed &&
      node.init.object.type === "Identifier" &&
      node.init.object.name === "T3" &&
      node.init.property.type === "Identifier"
    ) {
      parts.set(node.id.name, node.init.property.name);
      continue;
    }
    for (const child of children(node)) {
      // Calling a name says nothing about what it is.
      if (node.type === "CallExpression" && child === node.callee && child.type === "Identifier") {
        continue;
      }
      left.push(child);
    }
  }
  for (const name of other) parts.delete(name);
  return parts;
};

/** The workflow a `workflow(…)` call defines, as far as the call itself says. */
export interface WorkflowCall {
  readonly name: string;
  /** Undefined when the version is not a number written in the call. */
  readonly version: number | undefined;
}

export interface AskedKind {
  readonly kind: string;
  /** The ask's name, when it is written outright. */
  readonly ask: string | undefined;
  /** The `workflow(…)` call the ask is written inside; undefined for one outside them all. */
  readonly workflow: WorkflowCall | undefined;
}

/**
 * The kinds a file's asks name outright, each with the workflow it is written in. Read from the
 * syntax tree, so text that looks like an ask is not one, and only `T3`'s own `ask` counts. A
 * kind worked out as the run goes is not found here: `ask` checks it when it is asked.
 */
export const askedKinds = (source: string): ReadonlyArray<AskedKind> => {
  const tree = parsed(source);
  if (tree === undefined) return [];
  const parts = partsOfT3(tree);
  const partCalled = (callee: Node): string | undefined => {
    if (callee.type === "Identifier") return parts.get(callee.name);
    return callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "T3" &&
      callee.property.type === "Identifier"
      ? callee.property.name
      : undefined;
  };
  const optionOf = (options: Node | undefined, name: string): Node | undefined => {
    if (options?.type !== "ObjectExpression") return undefined;
    for (const property of options.properties) {
      if (property.type === "Property" && keyOf(property) === name) return property.value;
    }
    return undefined;
  };
  const found: Array<AskedKind & { readonly at: number }> = [];
  const left: Array<{ readonly node: Node; readonly workflow: WorkflowCall | undefined }> = [
    { node: tree, workflow: undefined },
  ];
  for (let next = left.pop(); next !== undefined; next = left.pop()) {
    const { node } = next;
    let workflow = next.workflow;
    if (node.type === "CallExpression") {
      const part = partCalled(node.callee);
      const [first, options] = node.arguments;
      const names = literals(first);
      if (part === "workflow" && names.length === 1) {
        const version = optionOf(options, "version");
        workflow = {
          name: names[0]!,
          version:
            version?.type === "Literal" && typeof version.value === "number"
              ? version.value
              : undefined,
        };
      }
      if (part === "ask") {
        for (const kind of literals(optionOf(options, "kind"))) {
          found.push({
            kind,
            ask: names.length === 1 ? names[0] : undefined,
            workflow,
            at: node.start,
          });
        }
      }
    }
    for (const child of children(node)) left.push({ node: child, workflow });
  }
  // In the order they are written, so the first one named is the first one a person reads.
  return found
    .toSorted((one, other) => one.at - other.at)
    .map(({ kind, ask, workflow }) => ({ kind, ask, workflow }));
};

/**
 * What is wrong with the kinds a definitions file asks, given the workflows it defined: the first
 * ask whose own workflow does not declare its kind. An ask belongs to the workflow whose
 * definition it is written in, or to the file's only workflow when it is written outside one. An
 * ask this cannot give to one workflow is left to `ask`, which checks it when it is asked.
 */
export const askedKindProblem = (
  source: string,
  definitions: ReadonlyArray<{
    readonly name: string;
    readonly version: number;
    readonly asks: AskKinds;
  }>,
): string | undefined => {
  for (const { kind, ask, workflow } of askedKinds(source)) {
    const owners =
      workflow === undefined
        ? definitions
        : definitions.filter(
            (definition) =>
              definition.name === workflow.name &&
              (workflow.version === undefined || definition.version === workflow.version),
          );
    const [owner] = owners;
    if (owner === undefined || owners.length > 1) continue;
    const problem = undeclaredKind(owner.name, owner.asks, kind, ask);
    if (problem !== undefined) return problem;
  }
  return undefined;
};
