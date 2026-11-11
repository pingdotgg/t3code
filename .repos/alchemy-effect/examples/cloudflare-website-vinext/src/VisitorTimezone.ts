const HEADER = "x-visitor-timezone";

export function visitorTimezoneHeader(): string {
  return HEADER;
}

export function timezoneFromRequest(request: Request): string {
  const cf = (request as Request & { cf?: { timezone?: string } }).cf;
  return cf?.timezone ?? "UTC";
}
