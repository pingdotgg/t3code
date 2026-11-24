import { assert, it } from "vite-plus/test";

import { parseExpression } from "./expression.ts";

const at = (source: string, x: number) => parseExpression(source)(x);

it("follows precedence, implicit products and unary minus", () => {
  assert.equal(at("2 + 3*x^2", 2), 14);
  assert.equal(at("2x(x+1)", 3), 24);
  assert.equal(at("-x^2", 3), -9);
  assert.equal(at("2^-x", 1), 0.5);
  assert.equal(at("2^3^2", 0), 512);
});

it("applies functions and constants", () => {
  assert.closeTo(at("sin(pi/2)", 0), 1, 1e-12);
  assert.closeTo(at("f(x) = ln(e^x)", 3), 3, 1e-12);
  assert.equal(at("sqrt(abs(x))", -9), 3);
  assert.equal(at("2sqrt(x)^2", 9), 18);
  assert.equal(at("sqrt(x)(x+1)", 9), 30);
  assert.closeTo(at("sin(x)^2 + cos(x)^2", 2), 1, 1e-12);
  assert.closeTo(at("sin x^2", 2), Math.sin(4), 1e-12);
});

it("rejects what it cannot read", () => {
  assert.throws(() => parseExpression("2 + "));
  assert.throws(() => parseExpression("(x"));
  assert.throws(() => parseExpression("foo(x)"));
  assert.throws(() => parseExpression("x; alert(1)"));
});
