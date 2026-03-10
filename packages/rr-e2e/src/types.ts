export interface ReplayRef {
  readonly $ref: string;
}

export interface ReplayInteraction {
  readonly name: string;
  readonly service: string;
  readonly match?: Record<string, unknown>;
  readonly whenState?: Record<string, unknown>;
  readonly capture?: Record<string, string>;
  readonly setState?: Record<string, unknown>;
  readonly result?: unknown;
  readonly notifications?: ReadonlyArray<unknown>;
  readonly error?: {
    readonly message: string;
  };
}

export interface ReplayFixture<ProviderStatus = unknown> {
  readonly version: 1;
  readonly state?: Record<string, unknown>;
  readonly providerStatuses?: ReadonlyArray<ProviderStatus>;
  readonly interactions: ReadonlyArray<ReplayInteraction>;
}

export interface ReplayScopes {
  readonly request: unknown;
  readonly state: Record<string, unknown>;
}

export interface ResolvedInteraction<T> {
  readonly interaction: ReplayInteraction;
  readonly result: T;
  readonly notifications: ReadonlyArray<unknown>;
}
