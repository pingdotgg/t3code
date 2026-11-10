// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export declare class OkResponse extends Response {
  static readonly status = 200;
  constructor(body: BodyInit | null, init?: ResponseInit);
}
export declare class NotFoundResponse extends Response {
  static readonly status = 404;
  constructor(...[body, init]: ConstructorParameters<typeof Response>);
}
export declare class NoIntentResponse extends NotFoundResponse {
  constructor();
}
export declare class MethodNotAllowedResponse extends Response {
  static readonly status = 405;
  constructor(...[body, init]: ConstructorParameters<typeof Response>);
}
export declare class InternalServerErrorResponse extends Response {
  static readonly status = 500;
  constructor(_: Error, init?: ResponseInit);
}
export declare class NotModifiedResponse extends Response {
  static readonly status = 304;
  constructor(...[_body, init]: ConstructorParameters<typeof Response>);
}
export declare class MovedPermanentlyResponse extends Response {
  static readonly status = 301;
  constructor(location: string, init?: ResponseInit);
}
export declare class FoundResponse extends Response {
  static readonly status = 302;
  constructor(location: string, init?: ResponseInit);
}
export declare class SeeOtherResponse extends Response {
  static readonly status = 303;
  constructor(location: string, init?: ResponseInit);
}
export declare class TemporaryRedirectResponse extends Response {
  static readonly status = 307;
  constructor(location: string, init?: ResponseInit);
}
export declare class PermanentRedirectResponse extends Response {
  static readonly status = 308;
  constructor(location: string, init?: ResponseInit);
}
//# sourceMappingURL=responses.d.ts.map
