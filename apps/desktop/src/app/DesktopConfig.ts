import { OtlpHeadersFromString, OtlpProtocol } from "@t3tools/shared/observability";
import { T3_LEARN_HOME_ENV, T3_LEARN_LEGACY } from "@t3tools/shared/t3LearnIdentity";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

export const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const resolveT3LearnHomeFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const current = env[T3_LEARN_HOME_ENV]?.trim();
  if (current) return current;
  const legacy = env[T3_LEARN_LEGACY.homeEnv]?.trim();
  return legacy || undefined;
};

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedString("T3CODE_HOME"),
  // A packaged T3 Learn ignores T3CODE_HOME so an exported T3 Code home never becomes its own.
  t3LearnHome: Config.all({
    current: trimmedString(T3_LEARN_HOME_ENV),
    legacy: trimmedString(T3_LEARN_LEGACY.homeEnv),
  }).pipe(
    Config.map(({ current, legacy }) =>
      Option.fromUndefinedOr(
        resolveT3LearnHomeFromEnv({
          [T3_LEARN_HOME_ENV]: Option.getOrUndefined(current),
          [T3_LEARN_LEGACY.homeEnv]: Option.getOrUndefined(legacy),
        }),
      ),
    ),
  ),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("T3CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("T3CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("T3CODE_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("T3CODE_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("T3CODE_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  desktopLauncherPath: trimmedString("T3CODE_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("T3CODE_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
