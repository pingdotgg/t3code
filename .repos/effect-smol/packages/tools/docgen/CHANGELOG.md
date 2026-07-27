# @effect/docgen

## 4.0.0-beta.102

### Major Changes

- [#6556](https://github.com/Effect-TS/effect/pull/6556) [`19eeda6`](https://github.com/Effect-TS/effect/commit/19eeda68bac6d65bd24b9a9ca30565f35dbae565) Thanks @fubhy! - Migrate `@effect/docgen` into the Effect monorepo and update it to Effect 4 while retaining existing behavior.

### Patch Changes

- [#6567](https://github.com/Effect-TS/effect/pull/6567) [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06) Thanks @gcanti! - Add `Record.assignProperty` and safely handle dynamic record keys such as `__proto__` and inherited property names.

- Updated dependencies [[`b6392e1`](https://github.com/Effect-TS/effect/commit/b6392e119704553edec1b4fd2869ac0dbec621ef), [`7ed9450`](https://github.com/Effect-TS/effect/commit/7ed945044eb56aa9aeaf62d4746a011c96c58628), [`45762bd`](https://github.com/Effect-TS/effect/commit/45762bd78df9ecd87c98b8d3738cdeeac7d81128), [`a6e8391`](https://github.com/Effect-TS/effect/commit/a6e8391cd31acd898fae18b3f8e7ca4c6f14f065), [`4ac7e8b`](https://github.com/Effect-TS/effect/commit/4ac7e8b136c61a26c3e438c013dfd7349b38e999), [`4cd40f5`](https://github.com/Effect-TS/effect/commit/4cd40f5692477783bef84fed3c5ef1c0cf5602e6), [`6956bc0`](https://github.com/Effect-TS/effect/commit/6956bc0e6cb27f53fbec39d9b18545940f9f598f), [`0e50ec7`](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246), [`9fcdade`](https://github.com/Effect-TS/effect/commit/9fcdade4a8af772b9ccd8b8a24fe8cee0e5d8470), [`57367d5`](https://github.com/Effect-TS/effect/commit/57367d54de55047ff0c5fce9685475e236bf354c), [`35c445f`](https://github.com/Effect-TS/effect/commit/35c445ff18029d192900ea0914c993f58d5cf1a5), [`c917bb9`](https://github.com/Effect-TS/effect/commit/c917bb94a4c1c4e0a24372a8ebb8a5ca232e36b5), [`bc1f358`](https://github.com/Effect-TS/effect/commit/bc1f3583e63344cb2c398d9040d9c975488ed123), [`0e0c9d7`](https://github.com/Effect-TS/effect/commit/0e0c9d7922ff463c1093d9e0576fae12cb0698d5), [`73d40aa`](https://github.com/Effect-TS/effect/commit/73d40aacd8fcae1b48c23f5b0a5c542127401d1d), [`4f1e318`](https://github.com/Effect-TS/effect/commit/4f1e3183f7123591c46224e9c587df7594562a5f), [`9d8d85c`](https://github.com/Effect-TS/effect/commit/9d8d85c1bb7da51970845b8ea830e386e777514a), [`6079fda`](https://github.com/Effect-TS/effect/commit/6079fda7b02f2f01ad91c15ab8c307336f3ba252), [`5101e92`](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06), [`d0b3265`](https://github.com/Effect-TS/effect/commit/d0b3265c3262670761471ab3518cf933b1b3b20a), [`7a03c89`](https://github.com/Effect-TS/effect/commit/7a03c893ce6492bf94c0ebfb00b63bf25dcbf83e), [`cea1d9c`](https://github.com/Effect-TS/effect/commit/cea1d9c92601e69ebda040af8a1d860d604d885c), [`078e1f5`](https://github.com/Effect-TS/effect/commit/078e1f5636e31b76a86722a636afc37a8cc25580), [`97bafea`](https://github.com/Effect-TS/effect/commit/97bafeab460833b9781527b437d1cb9cbee63260), [`fab0ab8`](https://github.com/Effect-TS/effect/commit/fab0ab8f7ab15ae596faa4ccf75615a494d11b0b), [`c323d8b`](https://github.com/Effect-TS/effect/commit/c323d8b30dbbe85f9df25b67288b93d5332de333), [`6966353`](https://github.com/Effect-TS/effect/commit/69663534d626003eb10a5e55ab1f13e0379fead1), [`0444004`](https://github.com/Effect-TS/effect/commit/04440041989c1785fe4db286379f2be2c15baa85), [`028bbb3`](https://github.com/Effect-TS/effect/commit/028bbb391e161185da10d974ab33381f769940d7), [`ff5d6e2`](https://github.com/Effect-TS/effect/commit/ff5d6e278a1fdff714315dc1a17075012f05c1f0), [`1bfce93`](https://github.com/Effect-TS/effect/commit/1bfce93e6d2bf0794c11733daf51c2390e7de375), [`7ce815c`](https://github.com/Effect-TS/effect/commit/7ce815cd5af6af991dfc13b890fd22345fc77c20), [`7271a7f`](https://github.com/Effect-TS/effect/commit/7271a7faf1080aa75f2f53ca6a0b5ec9334c1d38), [`475fe5c`](https://github.com/Effect-TS/effect/commit/475fe5c12c2d6504c475797c0634f90da01e1797)]:
  - effect@4.0.0-beta.102
  - @effect/platform-node@4.0.0-beta.102

## 0.5.2

### Patch Changes

- 3b595aa: Remove duplicate logger

## 0.5.1

### Patch Changes

- 0b3b34e: Typecheck examples deeply nested within namespaces

## 0.5.0

### Minor Changes

- 8a0eb55: Support custom code fences when rendering examples

## 0.4.7

### Patch Changes

- e3ae139: Typecheck namespace examples

## 0.4.6

### Patch Changes

- fcd5649: Support examples enclosed in Extended Markdown [code blocks](https://www.markdownguide.org/extended-syntax/#fenced-code-blocks)
- 95f136e: Support deeply nested namespaces.

  Previously, the docgen would fail with a `[Markdown] Unsupported namespace nesting: 4` error. With this change all namespace headers at depth level 3 and above would be rendered using H4 elements.

## 0.4.5

### Patch Changes

- 8959440: Fixes the type checking and execution of examples on Windows

## 0.4.4

### Patch Changes

- 00ce7a0: upgrade ts-morph to 23.0.0
- 5b888e5: srcDir and outDir fields in docgen.json are currently ignored. With this patch, they are taken into account

## 0.4.3

### Patch Changes

- 7add2b9: update dependencies

## 0.4.2

### Patch Changes

- 619a0e3: use @effect/markdown-toc instead of github dependency

## 0.4.1

### Patch Changes

- b9bfab0: add reporting of `tsc` and `tsx` errors, closes #66

## 0.4.0

### Minor Changes

- 5fbec18: update effect

### Patch Changes

- 08e8347: use ConfigProvider to load configuration for docgen

## 0.3.8

### Patch Changes

- 8abf24f: Core: do not swallow examples errors

## 0.3.7

### Patch Changes

- 2573662: update effect

## 0.3.6

### Patch Changes

- d58b355: chore: add defaults to `schema.json`

## 0.3.5

### Patch Changes

- bcaf971: fix glob pattern on windows

## 0.3.4

### Patch Changes

- 4e72aee: Re-added schema.json

## 0.3.3

### Patch Changes

- 3ee6dd1: Improve error output when spawning child process fails
- 73a1d93: build with tsup

## 0.3.2

### Patch Changes

- 16fc976: Updated dependencies

## 0.3.1

### Patch Changes

- b799243: add `--no-examples` option

## 0.3.0

### Minor Changes

- e08edb1: Modernized and switched to a `tsc` and `tsx` based setup with support for `NodeNext` module resolution.

## 0.2.1

### Patch Changes

- 2677b9d: updated effect
- 743ce06: change theme default

## 0.2.0

### Minor Changes

- ecd00a5: update effect and add effect/platform-node dependency

## 0.1.8

### Patch Changes

- 5411c71: Support for parsing "export \* as namespace"

## 0.1.7

### Patch Changes

- b94de9f: add support for `export * from ...`

## 0.1.6

### Patch Changes

- 172ac81: Fix parsing regression caused by compilerOptions parsing

## 0.1.5

### Patch Changes

- 85301ea: Add support for resolving compilerOptions from tsconfig files

## 0.1.4

### Patch Changes

- 8be0092: add support for namespaces
- 8be0092: BugFix: remove stale modules from /docs folder

## 0.1.3

### Patch Changes

- d8006f3: patch markdown-toc to prevent duplicate links
- 514f73f: update to effect framework package

## 0.1.2

### Patch Changes

- 115b996: fix formatting of the \_config.yml output by docgen
- 115b996: upgrade dependencies

## 0.1.1

### Patch Changes

- 2a909a1: fix config handling

## 0.1.0

### Minor Changes

- eb5ef08: rename docs-ts.json to docgen.json

## 0.0.3

### Patch Changes

- d139f78: ignore internal classes

## 0.0.2

### Patch Changes

- 4e88501: fix shebang line

## 0.0.1

### Patch Changes

- 4faa066: add initial code
