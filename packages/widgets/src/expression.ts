/**
 * Parses a function of x without `eval`, which the widget's content security policy blocks.
 * Returns a function, or throws with the position that could not be read.
 */
type Evaluate = (x: number) => number;

const FUNCTIONS: Readonly<Record<string, (value: number) => number>> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

const TOKEN = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+[0-9]*|[-+*/^()])/iy;

export function parseExpression(source: string): Evaluate {
  const input = source
    .replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=/i, "")
    .replaceAll("π", "pi")
    .replaceAll("·", "*")
    .replaceAll("−", "-")
    .replaceAll("**", "^");
  const tokens: Array<string> = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < input.trimEnd().length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(input);
    if (match === null) throw new Error(`Cannot read "${input.slice(at).trim()}".`);
    tokens.push(match[1]!.toLowerCase());
  }
  let position = 0;
  const peek = () => tokens[position];
  const take = (token: string) => {
    if (peek() !== token) return false;
    position += 1;
    return true;
  };

  const sum = (): Evaluate => {
    let left = product();
    for (;;) {
      const current = left;
      if (take("+")) {
        const right = product();
        left = (x) => current(x) + right(x);
      } else if (take("-")) {
        const right = product();
        left = (x) => current(x) - right(x);
      } else return left;
    }
  };
  const startsFactor = (token: string | undefined) =>
    token !== undefined && /^[a-z(.\d]/.test(token);
  const product = (): Evaluate => {
    let left = unary();
    for (;;) {
      const current = left;
      if (take("*")) {
        const right = unary();
        left = (x) => current(x) * right(x);
      } else if (take("/")) {
        const right = unary();
        left = (x) => current(x) / right(x);
      } else if (startsFactor(peek())) {
        const right = power();
        left = (x) => current(x) * right(x);
      } else return left;
    }
  };
  const unary = (): Evaluate => {
    if (take("-")) {
      const value = unary();
      return (x) => -value(x);
    }
    take("+");
    return power();
  };
  const power = (): Evaluate => {
    const base = atom();
    if (!take("^")) return base;
    const exponent = unary();
    return (x) => base(x) ** exponent(x);
  };
  const atom = (): Evaluate => {
    const token = peek();
    if (token === undefined) throw new Error("The expression ends too early.");
    position += 1;
    if (token === "(") {
      const value = sum();
      if (!take(")")) throw new Error("A bracket is not closed.");
      return value;
    }
    if (/^[\d.]/.test(token)) {
      const value = Number(token);
      return () => value;
    }
    if (token === "x") return (x) => x;
    if (Object.hasOwn(CONSTANTS, token)) return () => CONSTANTS[token]!;
    if (Object.hasOwn(FUNCTIONS, token)) {
      const apply = FUNCTIONS[token]!;
      const argument = power();
      return (x) => apply(argument(x));
    }
    throw new Error(`Unknown name "${token}".`);
  };

  const result = sum();
  if (position < tokens.length) throw new Error(`Unexpected "${peek()}".`);
  return result;
}
