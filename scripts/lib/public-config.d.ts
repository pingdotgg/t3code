export interface T3CodePublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}
type Environment = Readonly<Record<string, string | undefined>>;
export declare function loadRepoEnv({
  baseEnv,
  repoRoot,
}?: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
}): Record<string, string | undefined>;
export declare function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig;
export {};
