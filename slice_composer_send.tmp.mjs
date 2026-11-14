// Slice + dedent + top-level-return rewrite for the useComposerSend split.
// Prints JSON with the three function bodies. `return;` statements are only rewritten when
// their enclosing function is the `onSend` arrow (never a nested closure).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript";

const src = process.argv[2];
const text = NodeFS.readFileSync(src, "utf8");
const sf = ts.createSourceFile(src, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

const lineStarts = [0];
for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);

const offsetOfLine = (line) => lineStarts[line - 1];

// The onSend arrow: the only initializer named onSend.
let onSend = null;
const visit = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "onSend" &&
    node.initializer
  ) {
    onSend = node.initializer;
  }
  ts.forEachChild(node, visit);
};
visit(sf);
if (!onSend) throw new Error("onSend not found");

const returns = [];
const walkBody = (node) => {
  if (ts.isFunctionLike(node) && node !== onSend) return;
  if (ts.isReturnStatement(node) && !node.expression) returns.push(node);
  ts.forEachChild(node, walkBody);
};
walkBody(onSend);

const replaceReturns = (sliceStart, sliceEnd, statement) => {
  const inside = returns
    .filter((r) => r.getStart(sf) >= sliceStart && r.getEnd() <= sliceEnd)
    .map((r) => ({ start: r.getStart(sf) - sliceStart, end: r.getEnd() - sliceStart }));
  let out = text.slice(sliceStart, sliceEnd);
  for (const { start, end } of inside.reverse()) {
    out = out.slice(0, start) + `return ${statement};` + out.slice(end);
  }
  return { out, count: inside.length };
};

const dedent = (body) =>
  body
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

const slice = (fromLine, toLine, statement) => {
  const start = offsetOfLine(fromLine);
  const end = offsetOfLine(toLine + 1) - 1;
  const { out, count } = replaceReturns(start, end, statement);
  return { body: dedent(out), count };
};

const resolve = slice(415, 628, "{ halted: true }");
const dispatch = slice(629, 1030, "{ done: true }");
const complete = slice(1031, 1513, "{ halted: true }");

process.stderr.write(
  `returns: resolve=${resolve.count} dispatch=${dispatch.count} complete=${complete.count}\n`,
);
process.stdout.write(
  JSON.stringify({ resolve: resolve.body, dispatch: dispatch.body, complete: complete.body }),
);
