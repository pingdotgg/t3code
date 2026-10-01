# Providing an API

Start with the workspace reader unless your feature needs its own API.

[api.ts](api.ts) owns the public contract; [extension.ts](extension.ts) declares it, and [server.ts](server.ts) implements it with the actual ServerExtension type. Keep server code separate from the browser entry. Build adds the empty tools array and checks every declared entry even if tsconfig excludes it.

Copy these files into a starter project to try the provider. A consumer imports the same contract, declares a named plugin dependency with its API range, and calls it through useApiRead or bindApi. See [the independent consumer](../api-consumer/).
