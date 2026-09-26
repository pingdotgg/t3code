# Consuming another plugin

Keep api-provider and api-consumer as sibling source directories. Copy the starter package.json/tsconfig.json into each, install the SDK, and build each independently. Only the resulting .t3-extension directories are installed.

[extension.ts](extension.ts) imports the provider's [contract](../api-provider/api.ts) instead of copying its schema. The named dependency pins the plugin and API ranges. Install both packages for the intended project; removing or disabling the provider makes the consumer unavailable.
