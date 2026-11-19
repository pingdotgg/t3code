const COMBINATORS = new Set(["all", "allSettled", "any", "race"]);
const MAPPERS = new Set(["map", "flatMap"]);
const BOUNDED_SLICERS = new Set(["slice", "splice"]);
const LIMITER_NAME = /limit|throttle|queue|semaphore|mutex|schedul/i;
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "AwaitExpression",
]);

class FanOutSource {
  constructor(sourceCode) {
    this.sourceCode = sourceCode;
  }

  static unwrap(node) {
    let current = node;
    while (current && WRAPPERS.has(current.type)) {
      current = current.expression ?? current.argument;
    }
    return current;
  }

  static memberName(node) {
    if (node?.type !== "MemberExpression" || node.computed) return null;
    return node.property.type === "Identifier" ? node.property.name : null;
  }

  static calleeName(call) {
    const callee = FanOutSource.unwrap(call.callee);
    if (callee?.type === "Identifier") return callee.name;
    return FanOutSource.memberName(callee);
  }

  /** `limit(...)`, `this.limit(...)`, or a method on a limiter: `globalLimiter.run(...)`. */
  static isLimiterCall(call) {
    const name = FanOutSource.calleeName(call);
    if (name !== null && LIMITER_NAME.test(name)) return true;
    const callee = FanOutSource.unwrap(call.callee);
    if (callee?.type !== "MemberExpression") return false;
    const owner = FanOutSource.unwrap(callee.object);
    const ownerName = owner?.type === "Identifier" ? owner.name : FanOutSource.memberName(owner);
    return ownerName !== null && LIMITER_NAME.test(ownerName);
  }

  static isPromiseCombinator(call) {
    const callee = FanOutSource.unwrap(call.callee);
    return (
      callee?.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Promise" &&
      COMBINATORS.has(FanOutSource.memberName(callee))
    );
  }

  /** `items.map(fn)` or `Array.from(items, fn)`, as `{ receiver, callback }`. */
  static mapCall(node) {
    const call = FanOutSource.unwrap(node);
    if (call?.type !== "CallExpression") return null;
    const callee = FanOutSource.unwrap(call.callee);
    const name = FanOutSource.memberName(callee);
    if (MAPPERS.has(name) && call.arguments.length > 0) {
      return { receiver: callee.object, callback: call.arguments[0] };
    }
    if (
      name === "from" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Array" &&
      call.arguments.length > 1
    ) {
      return { receiver: call.arguments[0], callback: call.arguments[1] };
    }
    return null;
  }

  /** A limiter wrapper such as p-limit: `(item) => limit(() => work(item))`. */
  static isLimitedCallback(callback) {
    const fn = FanOutSource.unwrap(callback);
    if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") {
      return false;
    }
    let body = fn.body;
    if (body.type === "BlockStatement") {
      const statement = body.body.at(-1);
      if (body.body.length !== 1 || statement?.type !== "ReturnStatement") {
        return false;
      }
      body = statement.argument;
    }
    const call = FanOutSource.unwrap(body);
    return call?.type === "CallExpression" && FanOutSource.isLimiterCall(call);
  }

  resolve(identifier) {
    let scope = this.sourceCode.getScope(identifier);
    while (scope) {
      const variable = scope.set.get(identifier.name);
      if (variable) return variable;
      scope = scope.upper;
    }
    return null;
  }

  /** The initializer of a variable that is written once, at its declaration. */
  singleInitializer(identifier) {
    const variable = this.resolve(identifier);
    if (variable?.defs.length !== 1) return null;
    const [definition] = variable.defs;
    if (definition.node.type !== "VariableDeclarator") return null;
    const reassigned = variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    );
    return reassigned ? null : definition.node.init;
  }

  /** `for (const batch of batches)`: the loop element is one chunk of a larger list. */
  isLoopElement(identifier) {
    const definition = this.resolve(identifier)?.defs[0];
    const declaration = definition?.parent;
    return (
      declaration?.type === "VariableDeclaration" &&
      (declaration.parent?.type === "ForOfStatement" ||
        declaration.parent?.type === "ForInStatement") &&
      declaration.parent.left === declaration
    );
  }

  /** A receiver whose size the source fixes, rather than the data. */
  isBoundedReceiver(node) {
    const receiver = FanOutSource.unwrap(node);
    if (!receiver) return false;
    // `[a, b]` is fixed; `[...new Set(ids)]` is as long as its data.
    if (receiver.type === "ArrayExpression") {
      return receiver.elements.every((element) => element?.type !== "SpreadElement");
    }
    if (receiver.type === "ConditionalExpression") {
      return (
        this.isBoundedReceiver(receiver.consequent) && this.isBoundedReceiver(receiver.alternate)
      );
    }
    // A worker pool: `Array.from({ length: CONCURRENCY }, worker)` sizes the fan-out in code.
    if (receiver.type === "ObjectExpression") return true;
    if (receiver.type === "Identifier") {
      if (CONSTANT_NAME.test(receiver.name) || this.isLoopElement(receiver)) {
        return true;
      }
      const init = this.singleInitializer(receiver);
      return init ? this.isBoundedReceiver(init) : false;
    }
    if (receiver.type === "MemberExpression") {
      const name = FanOutSource.memberName(receiver);
      // Injected collaborator lists, such as `this.assessors`, are fixed at construction.
      if (receiver.object.type === "ThisExpression") return true;
      return name !== null && CONSTANT_NAME.test(name);
    }
    if (receiver.type === "CallExpression") {
      return BOUNDED_SLICERS.has(FanOutSource.memberName(FanOutSource.unwrap(receiver.callee)));
    }
    return false;
  }

  /** The mapped collection behind a combinator's argument, directly or through a const. */
  fanOut(argument) {
    const node = FanOutSource.unwrap(argument);
    const direct = FanOutSource.mapCall(node);
    if (direct) return direct;
    if (node?.type !== "Identifier") return null;
    const init = this.singleInitializer(node);
    return init ? FanOutSource.mapCall(init) : null;
  }
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Promise.all over a mapped collection, which starts one query or request per element at once.",
    },
    schema: [],
    messages: {
      unboundedFanOut:
        "Promise.{{combinator}} over a mapped collection starts one call per element at once and exhausts the database connection pool. For database reads, run one set-based query over the whole list (`= ANY(${ids}::text[])` in SQL, `{ in: ids }` in Prisma). For other I/O, bound concurrency with p-limit or process fixed-size batches. If the collection is a small fixed set, disable this line with the reason.",
    },
  },
  create(context) {
    const source = new FanOutSource(context.sourceCode);

    return {
      CallExpression(node) {
        if (!FanOutSource.isPromiseCombinator(node)) return;
        const fanOut = source.fanOut(node.arguments[0]);
        if (!fanOut) return;
        if (FanOutSource.isLimitedCallback(fanOut.callback)) return;
        if (source.isBoundedReceiver(fanOut.receiver)) return;

        context.report({
          node,
          messageId: "unboundedFanOut",
          data: {
            combinator: FanOutSource.memberName(FanOutSource.unwrap(node.callee)),
          },
        });
      },
    };
  },
};

export default {
  rules: {
    "no-unbounded-promise-fan-out": rule,
  },
};
