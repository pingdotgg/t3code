/**
 * Iterative, depth- and size-bounded KiCad S-expression parser.
 * Parses `.kicad_sch` and `.kicad_pcb` files without recursion stack overflows.
 */

export type SExprNode = string | SExprList;
export interface SExprList extends ReadonlyArray<SExprNode> {}

const MAX_SEXPR_BYTES = 20 * 1024 * 1024;
const MAX_SEXPR_DEPTH = 128;

export function parseSExpr(input: string): SExprList {
  if (input.length > MAX_SEXPR_BYTES) {
    throw new Error(`S-expression exceeds maximum supported size (${MAX_SEXPR_BYTES} bytes).`);
  }

  const root: SExprNode[] = [];
  const stack: SExprNode[][] = [root];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input.charCodeAt(i);
    // Whitespace
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      i += 1;
      continue;
    }
    // Line comment starting with '#'
    if (ch === 35) {
      while (i < len && input.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    // '('
    if (ch === 40) {
      if (stack.length >= MAX_SEXPR_DEPTH) {
        throw new Error(`S-expression nesting exceeded limit (${MAX_SEXPR_DEPTH}).`);
      }
      const next: SExprNode[] = [];
      stack[stack.length - 1]!.push(next);
      stack.push(next);
      i += 1;
      continue;
    }
    // ')'
    if (ch === 41) {
      if (stack.length <= 1) {
        throw new Error(`Unexpected ')' in S-expression at offset ${i}.`);
      }
      stack.pop();
      i += 1;
      continue;
    }
    // Quoted string '"'
    if (ch === 34) {
      i += 1;
      let str = "";
      let closed = false;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 92 && i + 1 < len) {
          // Escape sequence
          const escaped = input[i + 1]!;
          if (escaped === "n") str += "\n";
          else if (escaped === "r") str += "\r";
          else if (escaped === "t") str += "\t";
          else str += escaped;
          i += 2;
          continue;
        }
        if (c === 34) {
          i += 1;
          closed = true;
          break;
        }
        str += input[i]!;
        i += 1;
      }
      if (!closed) {
        throw new Error("Unterminated quoted string in S-expression.");
      }
      stack[stack.length - 1]!.push(str);
      continue;
    }
    // Atom
    const start = i;
    while (i < len) {
      const c = input.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 40 || c === 41) {
        break;
      }
      i += 1;
    }
    stack[stack.length - 1]!.push(input.slice(start, i));
  }

  if (stack.length !== 1) {
    throw new Error("Unclosed '(' in S-expression.");
  }
  return root;
}

export function isSExprList(node: SExprNode | undefined): node is SExprList {
  return Array.isArray(node);
}

export function findChild(list: SExprList, tag: string): SExprList | undefined {
  for (let i = 1; i < list.length; i += 1) {
    const child = list[i];
    if (Array.isArray(child) && child[0] === tag) return child;
  }
  return undefined;
}

export function findChildren(list: SExprList, tag: string): SExprList[] {
  const out: SExprList[] = [];
  for (let i = 1; i < list.length; i += 1) {
    const child = list[i];
    if (Array.isArray(child) && child[0] === tag) out.push(child);
  }
  return out;
}

export function atomString(node: SExprNode | undefined): string | undefined {
  return typeof node === "string" ? node : undefined;
}

export function atomNumber(node: SExprNode | undefined): number | undefined {
  if (typeof node !== "string") return undefined;
  const parsed = Number(node);
  return Number.isFinite(parsed) ? parsed : undefined;
}
