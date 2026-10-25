export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export function badRequest(): never {
  throw new HttpError(400, 'invalid_request');
}

export function tooLarge(): never {
  throw new HttpError(413, 'size_limit');
}

export function unavailable(): never {
  throw new HttpError(503, 'unavailable');
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const messages: Record<number, string> = {
    400: 'Invalid request',
    401: 'Invalid credentials',
    403: 'Write not permitted',
    404: 'Not found',
    413: 'Request too large',
    429: 'Rate limit exceeded',
    500: 'Operation failed',
    503: 'Service unavailable',
  };
  return new Response(messages[status] ?? messages[500], {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(status === 429 || status === 503 ? { 'Retry-After': '60' } : {}),
    },
  });
}
