// Canonical labels for generated module metadata in esbuild output.
//
// esbuild stamps each bundled module's resolved path — relative to
// absWorkingDir — into `//` banner comments, CommonJS/ESM wrapper keys
// ("../../dep/index.js"(exports, module){…}), synthetic glob-expansion
// module names (`require("<pattern>") in <importer>`), and jsxdev fileName
// metadata, so emitted bytes (and every receipt hash) depend on where the
// build ran and where the checkout lived.
//
// The emitted JavaScript is the authoritative compile: it is never
// re-bundled. Labels are rewritten in place by parsing the output with a
// real parser and touching only positions whose generated provenance is
// structural, not merely name-shaped:
//
// - Module wrapper maps: `var require_*/init_* = __commonJS({…})` /
//   `__esm({…})` statements in the bundle body's top-level statement
//   list, where the callee resolves to a `var` in the prologue — the
//   contiguous run of `var` declarations before the body's first
//   freestanding line comment. esbuild emits its helpers there wholesale;
//   user statements only ever appear after the first module banner or
//   inside module bodies, so a user `var __esm = …` can never occupy a
//   prologue slot. `__glob` maps are keyed by pattern-relative lookup
//   names, not module labels.
// - JSX dev metadata: `fileName` in the argument-4 source object of a
//   `jsxDEV` call, only when the callee's namespace object is a top-level
//   `var` initialized by a prologue `__toESM`/`__toCommonJS` over the
//   `require_*` of a module whose metafile key resolves to the same file
//   `react/jsx-dev-runtime` selects from this package (or the controlled
//   `host-react:react/jsx-dev-runtime` plugin namespace) — or a bare
//   `jsxDEV` imported from the pinned `react/jsx-dev-runtime` specifier.
//   A dependency that merely exports a `jsxDEV` member, or ships a file
//   at a react-shaped path that is not the resolved runtime, is not that
//   module.
// - `//` line comments at line start whose whole text is an emitted
//   label, or whose ` in <label>` suffix follows a call-shaped prefix —
//   esbuild's banner and glob-synthetic comment forms.
//
// A string key inside a proven helper map that is not a bundled input
// label (nor a ` in <label>` synthetic name) means emitted metadata this
// file cannot explain; that throws rather than shipping a half-rewritten
// bundle. The throw is unreachable for programs that do not deliberately
// mimic esbuild's emitted shapes — and mimicry exact down to the
// `require_*`/`init_*` name, prologue binding, and top-level position is
// indistinguishable from generated code by construction. A dep file with
// no usable package identity (no named package.json, no node_modules/
// suffix) or a canonical name claimed by two different modules keeps its
// location-dependent label — a documented limit, not a silent rewrite.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { parse as parseJavaScript } from "acorn";

const packageLabel = (file) => {
  let cursor = NodePath.dirname(file);
  while (true) {
    try {
      const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(cursor, "package.json"), "utf8"));
      if (typeof pkg.name === "string" && pkg.name.length > 0) {
        const rel = NodePath.relative(cursor, file).split(NodePath.sep).join("/");
        return `node_modules/${pkg.name}/${rel}`;
      }
    } catch {}
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
};
const canonicalLabel = (file) =>
  packageLabel(file) ??
  (() => {
    const path = file.split(NodePath.sep).join("/");
    const at = path.lastIndexOf("node_modules/");
    return at === -1 ? null : path.slice(at);
  })();
// Escape a label for a string literal, keeping the quote character esbuild
// chose (it picks ' when the name contains ") and escaping non-ASCII the
// way it does: \xNN, \uNNNN, \u{NNNNN}.
const escapeLabel = (value, quote) => {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f)
      out += "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
    else if (cp < 0x80) out += ch;
    else if (cp <= 0xff) out += "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
    else
      out +=
        cp <= 0xffff
          ? "\\u" + cp.toString(16).toUpperCase().padStart(4, "0")
          : "\\u{" + cp.toString(16).toUpperCase() + "}";
  }
  return out;
};
// A path inside dir as a relative string, or null when it escapes.
const insideRel = (dir, file) => {
  const rel = NodePath.relative(dir, file);
  return rel !== ".." && !rel.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(rel)
    ? rel
    : null;
};

const FUNCTION_LIKE = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
// Module-map helpers: their object argument maps module labels (or
// glob-synthetic `require("<pattern>") in <label>` names) to factories.
// `__glob`'s own map is keyed by pattern-relative specifiers — lookup
// names, not module labels — so it is not a label position.
const MAP_HELPERS = new Set(["__commonJS", "__esm", "__commonJSMin", "__esmMin"]);
const NS_HELPERS = new Set(["__toESM", "__toCommonJS"]);
// Generated module-wrapper declarators always carry these prefixes.
const WRAPPER_NAME = /^(?:require|init)_/;
const SCOPES = new Set([
  ...FUNCTION_LIKE,
  "Program",
  "BlockStatement",
  "StaticBlock",
  "CatchClause",
  "SwitchStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "ClassExpression",
]);
// Every Identifier a binding pattern declares.
const patternIds = (node, out = []) => {
  if (node === null || node === undefined) return out;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      break;
    case "RestElement":
      patternIds(node.argument, out);
      break;
    case "AssignmentPattern":
      patternIds(node.left, out);
      break;
    case "ArrayPattern":
      for (const element of node.elements) patternIds(element, out);
      break;
    case "ObjectPattern":
      for (const property of node.properties)
        patternIds(property.type === "RestElement" ? property.argument : property.value, out);
      break;
  }
  return out;
};
const childNodes = function* (node) {
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child !== null && typeof child === "object" && typeof child.type === "string")
          yield child;
    } else if (value !== null && typeof value === "object" && typeof value.type === "string") {
      yield value;
    }
  }
};
// var/function declarations hoisted into a function's scope — searched
// through nested blocks but never into nested functions.
const collectHoisted = (node, found) => {
  for (const child of childNodes(node)) {
    if (FUNCTION_LIKE.has(child.type)) continue;
    if (child.type === "VariableDeclaration" && child.kind === "var") {
      for (const declarator of child.declarations)
        for (const name of patternIds(declarator.id)) found.set(name, { kind: "var", declarator });
    } else if (child.type === "FunctionDeclaration" && child.id) {
      found.set(child.id.name, { kind: "function" });
    }
    collectHoisted(child, found);
  }
};
// Names bound directly at this scope level. Import bindings record their
// declaration's source specifier so callers can pin provenance to the
// exact module an import came from.
const scopeBindings = (node) => {
  const found = new Map();
  const addPattern = (pattern, kind) => patternIds(pattern).forEach((n) => found.set(n, { kind }));
  const lexicalStatements = (statements) => {
    for (const statement of statements) {
      if (statement.type === "VariableDeclaration") {
        if (statement.kind === "var")
          for (const declarator of statement.declarations)
            for (const name of patternIds(declarator.id))
              found.set(name, { kind: "var", declarator });
        else for (const declarator of statement.declarations) addPattern(declarator.id, "lexical");
      } else if (statement.type === "FunctionDeclaration" && statement.id) {
        found.set(statement.id.name, { kind: "function" });
      } else if (statement.type === "ClassDeclaration" && statement.id) {
        found.set(statement.id.name, { kind: "lexical" });
      } else if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers)
          found.set(specifier.local.name, {
            kind: "import",
            source: statement.source.value,
          });
      }
    }
  };
  if (FUNCTION_LIKE.has(node.type)) {
    for (const param of node.params) addPattern(param, "param");
    // A named function expression binds its own name inside its body.
    if (node.type !== "FunctionDeclaration" && node.id)
      found.set(node.id.name, { kind: "function" });
    if (node.body.type === "BlockStatement") collectHoisted(node.body, found);
    return found;
  }
  // A named class expression binds its own name inside its body.
  if (node.type === "ClassExpression") {
    if (node.id) found.set(node.id.name, { kind: "lexical" });
    return found;
  }
  if (node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock") {
    lexicalStatements(node.body);
    return found;
  }
  if (node.type === "CatchClause") {
    if (node.param) addPattern(node.param, "param");
    return found;
  }
  if (node.type === "SwitchStatement") {
    for (const kase of node.cases) lexicalStatements(kase.consequent);
    return found;
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    const decl = node.init ?? node.left;
    if (decl && decl.type === "VariableDeclaration" && decl.kind !== "var")
      for (const declarator of decl.declarations) addPattern(declarator.id, "lexical");
    return found;
  }
  return found;
};
// The nearest binding for `name` visible from a position, walking scopes
// outward.
const bindingOf = (name, ancestors, scopes) => {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const scope = scopes.get(ancestors[i]);
    const binding = scope === undefined ? undefined : scope.get(name);
    if (binding !== undefined) return binding;
  }
  return undefined;
};
// `(0, x.jsxDEV)` arrives as a SequenceExpression; peel grouping and comma
// layers down to the real callee.
const unwrapCallee = (expr) => {
  while (true) {
    if (expr.type === "ParenthesizedExpression") expr = expr.expression;
    else if (expr.type === "SequenceExpression")
      expr = expr.expressions[expr.expressions.length - 1];
    else return expr;
  }
};
// The statement list of a node's body, for nodes whose `.body` is either
// an array (Program, blocks, static blocks) or a BlockStatement.
const statementList = (node) =>
  Array.isArray(node.body)
    ? node.body
    : node.body && node.body.type === "BlockStatement"
      ? node.body.body
      : null;
// The deepest statement-list node containing `pos` in a gap between its
// statements — i.e. the list a freestanding comment belongs to.
const enclosingList = (root, pos) => {
  let result = null;
  const visit = (node) => {
    const list = statementList(node);
    if (
      list !== null &&
      node.start <= pos &&
      pos <= node.end &&
      !list.some((s) => s.start <= pos && pos <= s.end)
    )
      result = node;
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return result;
};

// Rewrite the generated label positions in emitted bundle text. `inputs`
// is metafile.inputs — the exact spellings esbuild stamped, including
// plugin-namespace keys like `host-react:react` and pseudo-inputs like
// `<stdin>`; they are all valid map keys, but only labels that resolve
// outside the extension directory are eligible for canonicalization.
// Returns the rewritten text; throws when a proven-generated position
// carries a label this build cannot account for.
export const rewriteEmittedLabels = (text, inputs, dir) => {
  const labels = new Set(inputs);
  const wanted = new Map(); // emitted outside label -> canonical label
  const claimants = new Map(); // canonical label -> how many inputs want it
  const insideKeys = new Set();
  for (const key of inputs) {
    const abs = NodePath.resolve(dir, key);
    if (insideRel(dir, abs) === null) {
      const canon = canonicalLabel(abs);
      if (canon !== null) {
        wanted.set(key, canon);
        claimants.set(canon, (claimants.get(canon) ?? 0) + 1);
      }
    } else insideKeys.add(key);
  }
  // Emitted label -> canonical replacement; ambiguous or colliding labels
  // are absent so their location-dependent spelling survives untouched.
  const finals = new Map();
  for (const [label, canon] of wanted)
    if (claimants.get(canon) === 1 && !insideKeys.has(canon)) finals.set(label, canon);
  // Module keys pinned as this build's JSX dev runtime — the host-react
  // plugin namespace, or the input whose resolved file IS the one
  // `react/jsx-dev-runtime` selects from this package. Path text — a
  // react/-shaped directory or filename anywhere in the tree — proves
  // nothing; only resolution identity does.
  let devRuntimePath = null;
  try {
    devRuntimePath = NodeFS.realpathSync(
      NodeModule.createRequire(NodePath.join(dir, "package.json")).resolve("react/jsx-dev-runtime"),
    );
  } catch {
    // No react resolves under this package — only the host-react
    // namespace can pin the runtime.
  }
  const devRuntimeKeys = new Set(
    [...labels].filter((key) => {
      if (key === "host-react:react/jsx-dev-runtime") return true;
      if (devRuntimePath === null) return false;
      try {
        return NodeFS.realpathSync(NodePath.resolve(dir, key)) === devRuntimePath;
      } catch {
        return false; // pseudo-inputs and non-file keys
      }
    }),
  );
  const comments = [];
  let ast;
  try {
    ast = parseJavaScript(text, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
    });
  } catch {
    ast = parseJavaScript(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      onComment: comments,
    });
  }
  const edits = [];
  const editLiteral = (node, value) => {
    const quote = text[node.start];
    edits.push({
      start: node.start,
      end: node.end,
      replacement: quote + escapeLabel(value, quote) + quote,
    });
  };
  // ` in <label>` suffix of a glob-synthetic name, tried from the right so
  // a label containing " in " still resolves. Returns the label or null.
  const syntheticSuffix = (value) => {
    let at = value.length;
    while (at > 0) {
      at = value.lastIndexOf(" in ", at - 1);
      if (at === -1) return null;
      const candidate = value.slice(at + 4);
      if (labels.has(candidate) && /^[\w$]+\([\s\S]*\)$/.test(value.slice(0, at))) return candidate;
    }
    return null;
  };
  // The bundle body: the statement list that holds the module banner
  // comments. The first line comment at line start whose text is an
  // emitted label (or glob-synthetic name) identifies it; with no banner
  // there are no module labels and no prologue to trust.
  let bundleBody = null;
  for (const comment of comments) {
    if (comment.type !== "Line") continue;
    const body = comment.value.trim();
    if (!labels.has(body) && syntheticSuffix(body) === null) continue;
    const before = text.slice(text.lastIndexOf("\n", comment.start - 1) + 1, comment.start);
    if (before.trim() !== "") continue; // a trailing comment, not a banner
    bundleBody = enclosingList(ast, comment.start);
    break;
  }
  // Prologue + module-wrapper tables for the bundle body. The prologue is
  // the leading run of `var` declarations, ending at the first
  // freestanding line comment (the first module banner) or the first
  // non-var statement — the only slot esbuild fills with its own helpers.
  // Wrapper calls are recorded as init CallExpression -> {declarator,
  // gap}: a generated `var require_*/init_* = <helper>({…})` statement
  // always sits directly under the banner comment naming its module.
  const prologueDecls = new Set();
  const wrapperCalls = new Map();
  if (bundleBody !== null) {
    const list = statementList(bundleBody);
    // Start one byte before the body so a comment at offset zero (the
    // first module's banner, or any other leading comment) is part of the
    // first statement's gap: esbuild never emits user code ahead of its
    // banner, so only the bundler's own prelude can precede the first
    // freestanding comment — a no-helper module cannot contribute
    // prologue bindings.
    let prevEnd = bundleBody.start - 1;
    let prologueOpen = true;
    // The last freestanding comment seen, carried across consecutive `var`
    // statements: a generated module's banner precedes its wrapper var,
    // but a bare `var globRequire_x;` declaration can sit between them, so
    // the effective banner of a wrapper statement is its own gap comment
    // or the one the preceding var run inherited.
    let carriedBanner = null;
    for (const stmt of list) {
      const gap = comments.filter(
        (c) => c.type === "Line" && prevEnd < c.start && c.start < stmt.start,
      );
      const isVar = stmt.type === "VariableDeclaration" && stmt.kind === "var";
      const isDirective = stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal";
      if (!isDirective) {
        if (!isVar || gap.length > 0) prologueOpen = false;
        if (isVar) {
          const banner = gap.length > 0 ? gap[gap.length - 1] : carriedBanner;
          for (const declarator of stmt.declarations) {
            if (declarator.init !== null && declarator.init.type === "CallExpression")
              wrapperCalls.set(declarator.init, { declarator, banner });
            if (
              prologueOpen &&
              gap.length === 0 &&
              declarator.id.type === "Identifier" &&
              declarator.init !== null &&
              FUNCTION_LIKE.has(declarator.init.type) &&
              (MAP_HELPERS.has(declarator.id.name) || NS_HELPERS.has(declarator.id.name))
            )
              prologueDecls.add(declarator);
          }
        }
        carriedBanner = gap.length > 0 ? gap[gap.length - 1] : isVar ? carriedBanner : null;
        prevEnd = stmt.end;
      }
    }
  }
  // The banner a wrapper statement sits under: its own gap comment, or the
  // one a run of bare `var` declarations shares. Generated wrappers are
  // emitted as `// <label>\nvar require_x = __commonJS({"<label>"…})`, so
  // the banner text must be one of the map's own keys.
  const wrapperBannerOk = (entry, keySet) =>
    entry.banner !== null && keySet.has(entry.banner.value.trim());
  const scopes = new Map();
  const walk = (node, ancestors) => {
    if (SCOPES.has(node.type)) scopes.set(node, scopeBindings(node));
    if (node.type === "CallExpression") {
      const callee = unwrapCallee(node.callee);
      if (callee.type === "Identifier" && MAP_HELPERS.has(callee.name)) {
        // Generated module wrapper iff the call is the init of a
        // bundle-body `var require_*/init_*` declarator directly under a
        // banner naming one of its keys, AND its callee resolves to the
        // prologue declaration — positional facts a user declaration or
        // call cannot occupy.
        const binding = bindingOf(callee.name, ancestors, scopes);
        const entry = wrapperCalls.get(node);
        const map = node.arguments[0];
        const keySet = new Set(
          map !== undefined && map.type === "ObjectExpression"
            ? map.properties
                .filter(
                  (p) =>
                    p.type === "Property" &&
                    !p.computed &&
                    p.key.type === "Literal" &&
                    typeof p.key.value === "string",
                )
                .map((p) => p.key.value)
            : [],
        );
        const proven =
          entry !== undefined &&
          entry.declarator.id.type === "Identifier" &&
          WRAPPER_NAME.test(entry.declarator.id.name) &&
          wrapperBannerOk(entry, keySet) &&
          binding !== undefined &&
          binding.kind === "var" &&
          prologueDecls.has(binding.declarator);
        if (proven) {
          for (const property of map.properties) {
            if (property.type !== "Property" || property.computed) continue;
            const key = property.key;
            if (key.type !== "Literal" || typeof key.value !== "string") continue;
            const value = key.value;
            // A glob-synthetic name (`require("<pattern>") in <label>`)
            // is itself a bundled input — canonicalize the importer label
            // inside it, not the whole key.
            const suffix = syntheticSuffix(value);
            const suffixTarget = suffix === null ? undefined : finals.get(suffix);
            if (suffixTarget !== undefined) {
              editLiteral(key, value.slice(0, value.length - suffix.length) + suffixTarget);
              continue;
            }
            if (labels.has(value)) {
              const target = finals.get(value);
              if (target !== undefined) editLiteral(key, target);
              continue;
            }
            if (suffix === null)
              throw new Error(
                "t3-extension: generated module map key is not a bundled input: " +
                  JSON.stringify(value),
              );
          }
        }
      } else {
        // jsxDEV(type, props, key, isStatic, source, self): `source` —
        // argument position 4 — is the generated metadata object carrying
        // fileName. Provenance requires the callee to be the dev-runtime
        // module's namespace: a bare `jsxDEV` or member object imported
        // from the pinned react/jsx-dev-runtime specifier, or a
        // bundle-body `var` initialized by a prologue __toESM/__toCommonJS
        // over a require_* whose banner and wrapper map both pin the
        // dev-runtime module.
        let proven = false;
        if (callee.type === "Identifier" && callee.name === "jsxDEV") {
          const binding = bindingOf(callee.name, ancestors, scopes);
          proven =
            binding !== undefined &&
            binding.kind === "import" &&
            binding.source === "react/jsx-dev-runtime";
        } else if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "jsxDEV" &&
          callee.object.type === "Identifier"
        ) {
          const objectBinding = bindingOf(callee.object.name, ancestors, scopes);
          if (
            objectBinding !== undefined &&
            objectBinding.kind === "import" &&
            objectBinding.source === "react/jsx-dev-runtime"
          ) {
            proven = true;
          } else {
            const objectDecl =
              objectBinding !== undefined && objectBinding.kind === "var"
                ? objectBinding.declarator
                : undefined;
            const nsEntry =
              objectDecl !== undefined && objectDecl.init !== null
                ? wrapperCalls.get(objectDecl.init)
                : undefined;
            const nsCall = nsEntry !== undefined ? objectDecl.init : undefined;
            const nsCallee = nsCall === undefined ? null : unwrapCallee(nsCall.callee);
            if (
              nsCallee !== null &&
              nsCallee.type === "Identifier" &&
              NS_HELPERS.has(nsCallee.name)
            ) {
              const nsHelperBinding = bindingOf(nsCallee.name, ancestors, scopes);
              const inner = nsCall.arguments[0];
              const innerCallee =
                inner !== undefined && inner.type === "CallExpression"
                  ? unwrapCallee(inner.callee)
                  : null;
              const innerBinding =
                innerCallee !== null && innerCallee.type === "Identifier"
                  ? bindingOf(innerCallee.name, ancestors, scopes)
                  : undefined;
              const requireDecl =
                innerBinding !== undefined && innerBinding.kind === "var"
                  ? innerBinding.declarator
                  : undefined;
              const requireEntry =
                requireDecl !== undefined && requireDecl.init !== null
                  ? wrapperCalls.get(requireDecl.init)
                  : undefined;
              const wrapperCall = requireEntry !== undefined ? requireDecl.init : undefined;
              const wrapperCallee =
                wrapperCall === undefined ? null : unwrapCallee(wrapperCall.callee);
              const wrapperBinding =
                wrapperCallee !== null && wrapperCallee.type === "Identifier"
                  ? bindingOf(wrapperCallee.name, ancestors, scopes)
                  : undefined;
              const wrapperMap =
                wrapperCall !== undefined && wrapperCall.arguments[0]?.type === "ObjectExpression"
                  ? wrapperCall.arguments[0]
                  : null;
              const wrapperKeySet = new Set(
                wrapperMap === null
                  ? []
                  : wrapperMap.properties
                      .filter(
                        (p) =>
                          p.type === "Property" &&
                          !p.computed &&
                          p.key.type === "Literal" &&
                          typeof p.key.value === "string",
                      )
                      .map((p) => p.key.value),
              );
              proven =
                nsHelperBinding !== undefined &&
                nsHelperBinding.kind === "var" &&
                prologueDecls.has(nsHelperBinding.declarator) &&
                requireDecl !== undefined &&
                requireDecl.id.type === "Identifier" &&
                WRAPPER_NAME.test(requireDecl.id.name) &&
                wrapperBannerOk(requireEntry, wrapperKeySet) &&
                wrapperBinding !== undefined &&
                wrapperBinding.kind === "var" &&
                wrapperCallee !== null &&
                MAP_HELPERS.has(wrapperCallee.name) &&
                prologueDecls.has(wrapperBinding.declarator) &&
                wrapperKeySet.size > 0 &&
                [...wrapperKeySet].every((k) => devRuntimeKeys.has(k));
            }
          }
        }
        if (proven) {
          const source = node.arguments[4];
          if (source && source.type === "ObjectExpression") {
            for (const property of source.properties) {
              if (property.type !== "Property" || property.method || property.computed) continue;
              const named =
                (property.key.type === "Identifier" && property.key.name === "fileName") ||
                (property.key.type === "Literal" && property.key.value === "fileName");
              if (
                named &&
                property.value.type === "Literal" &&
                typeof property.value.value === "string" &&
                finals.has(property.value.value)
              )
                editLiteral(property.value, finals.get(property.value.value));
            }
          }
        }
      }
    }
    ancestors.push(node);
    for (const child of childNodes(node)) walk(child, ancestors);
    ancestors.pop();
  };
  walk(ast, []);
  for (const comment of comments) {
    if (comment.type !== "Line") continue;
    // Banners sit at line start; a comment after code on the same line is
    // not a generated banner.
    const before = text.slice(text.lastIndexOf("\n", comment.start - 1) + 1, comment.start);
    if (before.trim() !== "") continue;
    const body = comment.value.trim();
    const target = finals.get(body);
    if (target !== undefined) {
      edits.push({ start: comment.start, end: comment.end, replacement: "// " + target });
      continue;
    }
    const suffix = syntheticSuffix(body);
    if (suffix !== null) {
      const target = finals.get(suffix);
      if (target !== undefined) {
        const start = comment.end - suffix.length;
        edits.push({ start, end: comment.end, replacement: target });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
};
