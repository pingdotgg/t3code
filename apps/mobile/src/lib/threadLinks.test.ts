import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import * as Contracts from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const babel: {
  transformFileSync: (
    filename: string,
    options: Record<string, unknown>,
  ) => { code?: string | null } | null;
} = require("@babel/core");

it("extracts thread links when Hermes clones Babel's named-group regex for matchAll", () => {
  const compiled = babel.transformFileSync(
    NodeURL.fileURLToPath(
      new URL("../../../../packages/shared/src/threadLinks.ts", import.meta.url),
    ),
    {
      babelrc: false,
      configFile: false,
      presets: [[require.resolve("babel-preset-expo"), { enableBabelRuntime: false }]],
      caller: {
        name: "metro",
        bundler: "metro",
        platform: "android",
        isDev: false,
        isServer: false,
        isNodeModule: false,
        supportsStaticESM: false,
        supportsReactCompiler: true,
      },
    },
  );
  if (!compiled?.code) throw new Error("Mobile thread links did not compile");
  class CloningRegExp extends RegExp {
    // Hermes's matchAll clone loses Babel's wrapper and its named-group mapping.
    override [Symbol.matchAll](value: string) {
      return new RegExp(this.source, this.flags)[Symbol.matchAll](value);
    }
  }
  const exports = {} as typeof import("@t3tools/shared/threadLinks");
  const dependencies: Readonly<Record<string, unknown>> = {
    "@t3tools/contracts": Contracts,
    "effect/Option": Option,
    "effect/Schema": Schema,
  };
  NodeVM.runInNewContext(compiled.code, {
    exports,
    RegExp: new Proxy(CloningRegExp, {
      apply: (target, _thisArg, args) => Reflect.construct(target, args),
    }),
    require: (name: string) => dependencies[name],
  });
  const environmentId = Contracts.EnvironmentId.make("here");
  expect(
    exports.threadLinkRefs(
      "[Dictation](t3-thread://v2/here/thread-1) <t3-thread://v2/there/thread-2> `<t3-thread://v2/code/literal>`",
      environmentId,
    ),
  ).toEqual([
    { environmentId, threadId: "thread-1" },
    { environmentId: "there", threadId: "thread-2" },
  ]);
});
