interface PlatformErrorReasonLike {
  readonly _tag: string;
  readonly module?: string;
  readonly method?: string;
  readonly syscall?: string;
  readonly pathOrDescriptor?: unknown;
  readonly cause?: unknown;
}

export interface PlatformErrorLike {
  readonly _tag: "PlatformError";
  readonly reason: PlatformErrorReasonLike;
  readonly message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isPlatformErrorLike = (error: unknown): error is PlatformErrorLike =>
  isRecord(error) &&
  error._tag === "PlatformError" &&
  isRecord(error.reason) &&
  typeof error.reason._tag === "string";

export const isPlatformNotFoundErrorLike = (error: unknown): error is PlatformErrorLike =>
  isPlatformErrorLike(error) && error.reason._tag === "NotFound";
