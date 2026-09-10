export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";

// ACP v2 renamed these wire types. Keep the aliases while downstream adapters
// migrate their internal vocabulary; every runtime schema still comes from v2.
export {
  CancelSessionNotification as CancelNotification,
  LoginAuthRequest as AuthenticateRequest,
  LoginAuthResponse as AuthenticateResponse,
  LogoutAuthRequest as LogoutRequest,
  LogoutAuthResponse as LogoutResponse,
  ResumeSessionRequest as LoadSessionRequest,
  ResumeSessionResponse as LoadSessionResponse,
  UpdateSessionNotification as SessionNotification,
} from "./_generated/schema.gen.ts";
