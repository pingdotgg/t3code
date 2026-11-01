import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  EnvironmentId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  type ProviderInstanceId,
  type PullRequestMergeMethod,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { AndroidNavigationStyle } from "../lib/androidNavigationStyle";
import type { ComposerEnterBehavior } from "../lib/composerEnterBehavior";
import type { FollowUpBehavior } from "../lib/followUpBehavior";
import { isMicrophoneKind, type MicrophoneEntry } from "../lib/microphonePriority";
import { MOBILE_THEME_IDS, type MobileThemeId, type MobileThemeMode } from "../lib/mobileTheme";
import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";

const PREFERENCES_KEY = "t3code.preferences";
const PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

export const PullRequestListControls = Schema.Struct({
  state: PullRequestListState,
  involvement: PullRequestInvolvement,
  filters: PullRequestListFilters,
  projectId: Schema.optional(Schema.String),
  projectEnvironmentId: Schema.optional(Schema.String),
  sort: Schema.Literals(["updated", "created", "oldest"]),
});
export type PullRequestListControls = typeof PullRequestListControls.Type;

const ThreadListFilters = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  projectKey: Schema.NullOr(Schema.String),
});
export type ThreadListFilters = typeof ThreadListFilters.Type;

const PullRequestListPreferences = Schema.Struct({
  environmentId: Schema.NullOr(Schema.String),
  controls: Schema.Record(Schema.String, PullRequestListControls),
});
export type PullRequestListPreferences = typeof PullRequestListPreferences.Type;

/**
 * The page each workspace tab last showed, reopened when the tab returns with columns. `key` is
 * that page's route key: reopening under the same key reuses the screen a tab kept mounted.
 */
const WorkspaceSelections = Schema.Struct({
  threads: Schema.optional(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      key: Schema.optional(Schema.String),
    }),
  ),
  pullRequests: Schema.optional(
    Schema.Struct({
      environmentId: Schema.String,
      projectId: Schema.String,
      repository: Schema.String,
      number: Schema.Number,
      host: Schema.optional(Schema.String),
      key: Schema.optional(Schema.String),
    }),
  ),
  settings: Schema.optional(Schema.String),
  settingsKey: Schema.optional(Schema.String),
  /** A draft the threads tab showed after its last chat; only meaningful in its session. */
  threadsDraft: Schema.optional(Schema.Struct({ key: Schema.String, params: Schema.Unknown })),
});
export type WorkspaceSelections = typeof WorkspaceSelections.Type;

const isThreadListFilters = Schema.is(ThreadListFilters);
const isWorkspaceSelections = Schema.is(WorkspaceSelections);
const isPullRequestListPreferences = Schema.is(PullRequestListPreferences);
const ThreadProject = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
});
const isThreadProject = Schema.is(ThreadProject);

export interface Preferences {
  readonly navigationTabOrder?: readonly string[];
  readonly hiddenNavigationTabs?: readonly string[];
  readonly pullRequestHideTestFiles?: boolean;
  readonly pullRequestMergeMethod?: PullRequestMergeMethod;
  readonly liveActivitiesEnabled?: boolean;
  readonly themeId?: MobileThemeId;
  readonly lightThemeId?: MobileThemeId;
  readonly darkThemeId?: MobileThemeId;
  readonly themeMode?: MobileThemeMode;
  readonly androidNavigationStyle?: AndroidNavigationStyle;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  readonly mathRenderingEnabled?: boolean;
  /** Unset means on: crash reports are sent unless the user turns them off. */
  readonly crashReportsEnabled?: boolean;
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
  readonly dismissedDatabaseStorageNotices?: readonly string[];
  /** Hardware Return behavior is iOS-only. */
  readonly composerEnterBehavior?: ComposerEnterBehavior;
  readonly followUpBehavior?: FollowUpBehavior;
  readonly microphones?: ReadonlyArray<MicrophoneEntry>;
  readonly projectGroupingEnabled?: boolean;
  readonly projectGroupingMode?: SidebarProjectGroupingMode;
  readonly planModeEnabled?: boolean;
  readonly workingShelfEnabled?: boolean;
  readonly useLastProjectForNewThreads?: boolean;
  readonly lastThreadProject?: typeof ThreadProject.Type;
  readonly modelFavorites?: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
  readonly threadListSettledShelfExpanded?: boolean;
  readonly threadListSnoozedShelfExpanded?: boolean;
  readonly threadListWorkingShelfExpanded?: boolean;
  readonly threadListFilters?: ThreadListFilters;
  readonly pullRequestListFilters?: PullRequestListPreferences;
  readonly workspaceSelections?: WorkspaceSelections;
}

export class MobilePreferencesLoadError extends Schema.TaggedError<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedError<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: Preferences;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/persistence/MobilePreferencesStore") {}

function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    navigationTabOrder?: readonly string[];
    hiddenNavigationTabs?: readonly string[];
    pullRequestHideTestFiles?: boolean;
    pullRequestMergeMethod?: PullRequestMergeMethod;
    liveActivitiesEnabled?: boolean;
    themeId?: MobileThemeId;
    lightThemeId?: MobileThemeId;
    darkThemeId?: MobileThemeId;
    themeMode?: MobileThemeMode;
    androidNavigationStyle?: AndroidNavigationStyle;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    mathRenderingEnabled?: boolean;
    crashReportsEnabled?: boolean;
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
    dismissedDatabaseStorageNotices?: readonly string[];
    composerEnterBehavior?: ComposerEnterBehavior;
    followUpBehavior?: FollowUpBehavior;
    microphones?: ReadonlyArray<MicrophoneEntry>;
    projectGroupingEnabled?: boolean;
    projectGroupingMode?: SidebarProjectGroupingMode;
    planModeEnabled?: boolean;
    workingShelfEnabled?: boolean;
    useLastProjectForNewThreads?: boolean;
    lastThreadProject?: typeof ThreadProject.Type;
    modelFavorites?: Preferences["modelFavorites"];
    threadListSettledShelfExpanded?: boolean;
    threadListSnoozedShelfExpanded?: boolean;
    threadListWorkingShelfExpanded?: boolean;
    threadListFilters?: ThreadListFilters;
    pullRequestListFilters?: PullRequestListPreferences;
    workspaceSelections?: WorkspaceSelections;
  } = {};

  if (Array.isArray(parsed.hiddenNavigationTabs)) {
    preferences.hiddenNavigationTabs = parsed.hiddenNavigationTabs.filter(
      (tab): tab is string => typeof tab === "string",
    );
  }

  if (Array.isArray(parsed.navigationTabOrder)) {
    preferences.navigationTabOrder = parsed.navigationTabOrder.filter(
      (tab): tab is string => typeof tab === "string",
    );
  }

  if (typeof parsed.pullRequestHideTestFiles === "boolean") {
    preferences.pullRequestHideTestFiles = parsed.pullRequestHideTestFiles;
  }

  if (
    parsed.pullRequestMergeMethod === "squash" ||
    parsed.pullRequestMergeMethod === "merge" ||
    parsed.pullRequestMergeMethod === "rebase"
  ) {
    preferences.pullRequestMergeMethod = parsed.pullRequestMergeMethod;
  }

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (
    typeof parsed.themeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.themeId)
  ) {
    preferences.themeId = parsed.themeId as MobileThemeId;
  }
  if (
    typeof parsed.lightThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.lightThemeId)
  ) {
    preferences.lightThemeId = parsed.lightThemeId as MobileThemeId;
  }
  if (
    typeof parsed.darkThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.darkThemeId)
  ) {
    preferences.darkThemeId = parsed.darkThemeId as MobileThemeId;
  }
  if (
    parsed.themeMode === "system" ||
    parsed.themeMode === "light" ||
    parsed.themeMode === "dark"
  ) {
    preferences.themeMode = parsed.themeMode;
  }
  if (parsed.androidNavigationStyle === "one-ui" || parsed.androidNavigationStyle === "material") {
    preferences.androidNavigationStyle = parsed.androidNavigationStyle;
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  if (typeof parsed.mathRenderingEnabled === "boolean")
    preferences.mathRenderingEnabled = parsed.mathRenderingEnabled;
  if (typeof parsed.crashReportsEnabled === "boolean") {
    preferences.crashReportsEnabled = parsed.crashReportsEnabled;
  }
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (Array.isArray(parsed.dismissedDatabaseStorageNotices)) {
    preferences.dismissedDatabaseStorageNotices = parsed.dismissedDatabaseStorageNotices.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (parsed.composerEnterBehavior === "send" || parsed.composerEnterBehavior === "newline") {
    preferences.composerEnterBehavior = parsed.composerEnterBehavior;
  }
  if (parsed.followUpBehavior === "queue" || parsed.followUpBehavior === "steer") {
    preferences.followUpBehavior = parsed.followUpBehavior;
  }
  if (Array.isArray(parsed.microphones)) {
    preferences.microphones = parsed.microphones.flatMap((entry): MicrophoneEntry[] => {
      if (typeof entry !== "object" || entry === null || !isMicrophoneKind(entry.kind)) return [];
      if (!("uid" in entry)) return [{ kind: entry.kind }];
      return typeof entry.uid === "string" && typeof entry.name === "string"
        ? [{ kind: entry.kind, uid: entry.uid, name: entry.name }]
        : [];
    });
  }
  if (typeof parsed.projectGroupingEnabled === "boolean") {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }
  if (
    parsed.projectGroupingMode === "repository" ||
    parsed.projectGroupingMode === "repository_path" ||
    parsed.projectGroupingMode === "separate"
  ) {
    preferences.projectGroupingMode = parsed.projectGroupingMode;
  }
  if (typeof parsed.planModeEnabled === "boolean") {
    preferences.planModeEnabled = parsed.planModeEnabled;
  }
  if (typeof parsed.workingShelfEnabled === "boolean") {
    preferences.workingShelfEnabled = parsed.workingShelfEnabled;
  }
  if (typeof parsed.useLastProjectForNewThreads === "boolean") {
    preferences.useLastProjectForNewThreads = parsed.useLastProjectForNewThreads;
  }
  if (isThreadProject(parsed.lastThreadProject)) {
    preferences.lastThreadProject = parsed.lastThreadProject;
  }
  if (Array.isArray(parsed.modelFavorites)) {
    preferences.modelFavorites = parsed.modelFavorites.filter(
      (favorite) =>
        typeof favorite === "object" &&
        favorite !== null &&
        typeof favorite.provider === "string" &&
        favorite.provider.length > 0 &&
        typeof favorite.model === "string" &&
        favorite.model.trim().length > 0,
    );
  }
  if (typeof parsed.threadListSettledShelfExpanded === "boolean") {
    preferences.threadListSettledShelfExpanded = parsed.threadListSettledShelfExpanded;
  }
  if (typeof parsed.threadListSnoozedShelfExpanded === "boolean") {
    preferences.threadListSnoozedShelfExpanded = parsed.threadListSnoozedShelfExpanded;
  }
  if (typeof parsed.threadListWorkingShelfExpanded === "boolean") {
    preferences.threadListWorkingShelfExpanded = parsed.threadListWorkingShelfExpanded;
  }
  if (isThreadListFilters(parsed.threadListFilters)) {
    preferences.threadListFilters = parsed.threadListFilters;
  }
  if (isPullRequestListPreferences(parsed.pullRequestListFilters)) {
    preferences.pullRequestListFilters = parsed.pullRequestListFilters;
  }
  if (isWorkspaceSelections(parsed.workspaceSelections)) {
    preferences.workspaceSelections = parsed.workspaceSelections;
  }
  return preferences;
}

const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null): Preferences | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );
      return null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("payload" in parsed) ||
      typeof parsed.payload !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    const preferences = parsePayload(parsed.payload);
    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: unknown,
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);
    return [next, next] as const;
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, { payload, updatedAt: timestamp });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);
      return;
    }
    yield* secureStorage
      .removeItem(PREFERENCES_FALLBACK_KEY)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove the mobile preferences fallback.").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );
  });

  const loadUnlocked = Effect.gen(function* () {
    const databaseResult = yield* Effect.result(database.loadPreferencesJson);
    const databaseAvailable = databaseResult._tag === "Success";
    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    const fallbackResult = yield* Effect.result(secureStorage.getItem(PREFERENCES_FALLBACK_KEY));
    let fallbackJson: string | null = null;
    if (fallbackResult._tag === "Success") {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);
    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;
    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: Preferences | null = null;
    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));
      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));
      if (fallbackJson !== null) {
        yield* secureStorage
          .removeItem(PREFERENCES_FALLBACK_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove a stale mobile preferences fallback.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage.getItem(PREFERENCES_KEY);
      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;
      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(loadUnlocked)
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;
          const patch = yield* Effect.try({
            try: () => transform(current),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });
          const next: Preferences = { ...current, ...patch };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);
          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());
