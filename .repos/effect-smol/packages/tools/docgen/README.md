An opinionated documentation generator for Effect projects.

# Credits

This library was inspired by the following projects:

- [docs-ts](https://github.com/gcanti/docs-ts)

# Setup

1. Install `@effect/docgen` as a dev dependency:

```shell
pnpm add @effect/docgen -D
```

2. (Optional) Add a `docgen.json` configuration file.

```json
{
  "$schema": "node_modules/@effect/docgen/schema.json"
}
```

3. Add the following script to your `package.json` file:

```json
{
  "scripts": {
    "docgen": "docgen"
  }
}
```

> [!WARNING]
> To use "@effect/docgen", Node.js v18 or above is required.

## Example Configuration

The `docgen.json` configuration file allows you to customize `docgen`'s behavior. Here's an example configuration:

```json
{
  "exclude": ["src/internal/**/*.ts"],
  "parseCompilerOptions": {
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "paths": {
      "@effect/<project-name>": ["./src/index.js"],
      "@effect/<project-name>/test/*": ["./test/*.js"],
      "@effect/<project-name>/examples/*": ["./examples/*.js"],
      "@effect/<project-name>/*": ["./src/*.js"]
    }
  },
  "examplesCompilerOptions": {
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "paths": {
      "@effect/<project-name>": ["../../src/index.js"],
      "@effect/<project-name>/test/*": ["../../test/*.js"],
      "@effect/<project-name>/examples/*": ["../../examples/*.js"],
      "@effect/<project-name>/*": ["../../src/*.js"]
    }
  }
}
```

# Supported JSDoc Tags

| Tag           | Description                                                                                                                                                                                                                                    | Default   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `@category`   | Groups associated module exports together in the generated documentation.                                                                                                                                                                      | `'utils'` |
| `@example`    | Allows usage examples to be provided for your source code. All examples are type checked using `tsc`. Examples are also run using `tsx` and the NodeJS [assert](https://nodejs.org/api/assert.html) module can be used for on-the-fly testing. |           |
| `@since`      | Allows for documenting most recent library version in which a given piece of source code was updated.                                                                                                                                          |           |
| `@deprecated` | Marks source code as deprecated, which will ~~strikethrough~~ the name of the annotated module or function in the generated documentation.                                                                                                     | `false`   |
| `@internal`   | Prevents `docgen` from generating documentation for the annotated block of code. Additionally, if the `stripInternal` flag is set to `true` in `tsconfig.json`, TypeScript will not emit declarations for the annotated code.                  |           |
| `@ignore`     | Prevents `docgen` from generating documentation for the annotated block of code.                                                                                                                                                               |           |

By default, `docgen` will search for files in the `src` directory and will output generated files into a `docs` directory. For information on how to configure `docgen`, see the [Configuration](#configuration) section below.

# Configuration

`docgen` is meant to be a zero-configuration command-line tool by default. However, there are several configuration settings that can be specified for `docgen`. To customize the configuration of `docgen`, create a `docgen.json` file in the root directory of your project and indicate the custom configuration parameters that the tool should use when generating documentation.

The `docgen.json` configuration file adheres to the following interface:

```ts
interface Config {
  readonly projectHomepage?: string
  readonly srcLink?: string
  readonly srcDir?: string
  readonly outDir?: string
  readonly theme?: string
  readonly enableSearch?: boolean
  readonly enforceDescriptions?: boolean
  readonly enforceExamples?: boolean
  readonly enforceVersion?: boolean
  readonly tscExecutable?: string
  readonly exclude?: ReadonlyArray<string>
  readonly parseCompilerOptions?: string | Record<string, unknown>
  readonly examplesCompilerOptions?: string | Record<string, unknown>
}
```

The following table describes each configuration parameter, its purpose, and its default value.

| Parameter               | Description                                                                                                                                                                         | Default Value                      |
| :---------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------- |
| projectHomepage         | Will link to the project homepage from the [Auxiliary Links](https://pmarsceill.github.io/just-the-docs/docs/navigation-structure/#auxiliary-links) of the generated documentation. | `homepage` in `package.json`       |
| srcLink                 | Will link to the project source code.                                                                                                                                               | `{projectHomepage}/blob/main/src/` |
| srcDir                  | The directory in which `docgen` will search for TypeScript files to parse.                                                                                                          | `'src'`                            |
| outDir                  | The directory to which `docgen` will generate its output markdown documents.                                                                                                        | `'docs'`                           |
| theme                   | The theme that `docgen` will specify should be used for GitHub Docs in the generated `_config.yml` file.                                                                            | `'mikearnaldi/just-the-docs'`      |
| enableSearch            | Whether or not search should be enabled for GitHub Docs in the generated `_config.yml` file.                                                                                        | `true`                             |
| enforceDescriptions     | Whether or not descriptions for each module export should be required.                                                                                                              | `false`                            |
| enforceExamples         | Whether or not `@example` tags for each module export should be required. (**Note**: examples will not be enforced in module documentation)                                         | `false`                            |
| enforceVersion          | Whether or not `@since` tags for each module export should be required.                                                                                                             | `true`                             |
| tscExecutable           | The path to the TypeScript compiler executable that docgen should use when invoking the compiler programmatically.                                                                  | `'tsc'`                            |
| exclude                 | An array of glob strings specifying files that should be excluded from the documentation.                                                                                           | `[]`                               |
| parseCompilerOptions    | tsconfig for parsing options (or path to a tsconfig)                                                                                                                                | {}                                 |
| examplesCompilerOptions | tsconfig for the examples options (or path to a tsconfig)                                                                                                                           | {}                                 |

# FAQ

**Q:** For functions that have overloaded definitions, is it possible to document each overload separately?

**A:** No, `docgen` will use the documentation provided for the first overload of a function in its generated output.

# License

The MIT License (MIT)
