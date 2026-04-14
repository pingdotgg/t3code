# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

## Development

Start Metro for the dev client:

```bash
bun run dev:client
```

Build and run the local iOS dev client:

```bash
bun run ios:dev
```

Build and run the local iOS preview app:

```bash
bun run ios:preview
```

Inspect the resolved Expo config for a variant:

```bash
bun run config:dev
bun run config:preview
```

## EAS Builds

Create a cloud dev-client build:

```bash
bun run eas:ios:dev
```

Create a persistent preview build:

```bash
bun run eas:ios:preview
```

Android equivalents:

```bash
bun run eas:android:dev
bun run eas:android:preview
```
