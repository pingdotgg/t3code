// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export class OkResponse extends Response {
  static readonly status = 200;

  constructor(body: BodyInit | null, init?: ResponseInit) {
    super(body, {
      ...init,
      status: OkResponse.status,
    });
  }
}

export class NotFoundResponse extends Response {
  static readonly status = 404;

  constructor(...[body, init]: ConstructorParameters<typeof Response>) {
    super(body, {
      ...init,
      status: NotFoundResponse.status,
      statusText: "Not Found",
    });
  }
}

// A magical response type which is used to signal that a user worker should be invoked if one is present.
export class NoIntentResponse extends NotFoundResponse {
  constructor() {
    super();
  }
}

export class MethodNotAllowedResponse extends Response {
  static readonly status = 405;

  constructor(...[body, init]: ConstructorParameters<typeof Response>) {
    super(body, {
      ...init,
      status: MethodNotAllowedResponse.status,
      statusText: "Method Not Allowed",
    });
  }
}

export class InternalServerErrorResponse extends Response {
  static readonly status = 500;

  constructor(_: Error, init?: ResponseInit) {
    super(null, {
      ...init,
      status: InternalServerErrorResponse.status,
    });
  }
}

export class NotModifiedResponse extends Response {
  static readonly status = 304;

  constructor(...[_body, init]: ConstructorParameters<typeof Response>) {
    super(null, {
      ...init,
      status: NotModifiedResponse.status,
      statusText: "Not Modified",
    });
  }
}

export class MovedPermanentlyResponse extends Response {
  static readonly status = 301;

  constructor(location: string, init?: ResponseInit) {
    super(null, {
      ...init,
      status: MovedPermanentlyResponse.status,
      statusText: "Moved Permanently",
      headers: {
        ...init?.headers,
        Location: location,
      },
    });
  }
}

export class FoundResponse extends Response {
  static readonly status = 302;

  constructor(location: string, init?: ResponseInit) {
    super(null, {
      ...init,
      status: FoundResponse.status,
      statusText: "Found",
      headers: {
        ...init?.headers,
        Location: location,
      },
    });
  }
}

export class SeeOtherResponse extends Response {
  static readonly status = 303;

  constructor(location: string, init?: ResponseInit) {
    super(null, {
      ...init,
      status: SeeOtherResponse.status,
      statusText: "See Other",
      headers: {
        ...init?.headers,
        Location: location,
      },
    });
  }
}

export class TemporaryRedirectResponse extends Response {
  static readonly status = 307;

  constructor(location: string, init?: ResponseInit) {
    super(null, {
      ...init,
      status: TemporaryRedirectResponse.status,
      statusText: "Temporary Redirect",
      headers: {
        ...init?.headers,
        Location: location,
      },
    });
  }
}

export class PermanentRedirectResponse extends Response {
  static readonly status = 308;

  constructor(location: string, init?: ResponseInit) {
    super(null, {
      ...init,
      status: PermanentRedirectResponse.status,
      statusText: "Permanent Redirect",
      headers: {
        ...init?.headers,
        Location: location,
      },
    });
  }
}
