import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const loadConfigProvider = (envFile: Option.Option<string>) => {
  if (Option.isSome(envFile)) {
    return ConfigProvider.fromDotEnv({ path: envFile.value }).pipe(
      Effect.map((dotEnv) =>
        ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv()),
      ),
    );
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(".env");
    if (!exists) {
      return ConfigProvider.fromEnv();
    }
    return ConfigProvider.orElse(
      yield* ConfigProvider.fromDotEnv({ path: ".env" }),
      ConfigProvider.fromEnv(),
    );
  });
};
