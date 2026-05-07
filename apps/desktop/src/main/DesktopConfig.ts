import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export interface DesktopConfigShape {
  readonly home: Option.Option<string>;
  readonly userProfile: Option.Option<string>;
  readonly homeDrive: Option.Option<string>;
  readonly homePath: Option.Option<string>;
  readonly appDataDirectory: Option.Option<string>;
  readonly xdgConfigHome: Option.Option<string>;
  readonly t3Home: Option.Option<string>;
  readonly devServerUrl: Option.Option<URL>;
  readonly devRemoteT3ServerEntryPath: Option.Option<string>;
  readonly configuredBackendPort: Option.Option<number>;
  readonly commitHashOverride: Option.Option<string>;
  readonly desktopLanHostOverride: Option.Option<string>;
  readonly desktopHttpsEndpointUrls: readonly string[];
  readonly appImagePath: Option.Option<string>;
  readonly disableAutoUpdate: boolean;
  readonly desktopUpdateGithubToken: Option.Option<string>;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number;
}

export class DesktopConfig extends Context.Service<DesktopConfig, DesktopConfigShape>()(
  "t3/desktop/Config",
) {}

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

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

const firstSomeOf = <A>(values: ReadonlyArray<Option.Option<A>>): Option.Option<A> =>
  Option.firstSomeOf(values);

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const EnvDesktopConfig = Config.all({
  home: trimmedString("HOME"),
  userProfile: trimmedString("USERPROFILE"),
  homeDrive: trimmedString("HOMEDRIVE"),
  homePath: trimmedString("HOMEPATH"),
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  t3Home: trimmedString("T3CODE_HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.port("T3CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("T3CODE_DISABLE_AUTO_UPDATE"),
  desktopUpdateGithubToken: trimmedString("T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN"),
  ghToken: trimmedString("GH_TOKEN"),
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
}).pipe(
  Config.map(
    (config): DesktopConfigShape => ({
      home: config.home,
      userProfile: config.userProfile,
      homeDrive: config.homeDrive,
      homePath: config.homePath,
      appDataDirectory: config.appDataDirectory,
      xdgConfigHome: config.xdgConfigHome,
      t3Home: config.t3Home,
      devServerUrl: config.devServerUrl,
      devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
      configuredBackendPort: config.configuredBackendPort,
      commitHashOverride: config.commitHashOverride,
      desktopLanHostOverride: config.desktopLanHostOverride,
      desktopHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
      appImagePath: config.appImagePath,
      disableAutoUpdate: config.disableAutoUpdate,
      desktopUpdateGithubToken: firstSomeOf([config.desktopUpdateGithubToken, config.ghToken]),
      mockUpdates: config.mockUpdates,
      mockUpdateServerPort: config.mockUpdateServerPort,
    }),
  ),
);

export const layer = Layer.effect(
  DesktopConfig,
  Effect.gen(function* () {
    return yield* EnvDesktopConfig;
  }),
);

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }))));
