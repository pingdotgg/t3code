function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

export function encodeTicketDeepLink(input: {
  readonly environmentId: string;
  readonly boardId: string;
  readonly ticketId: string;
}): string | null {
  if (
    input.environmentId.length === 0 ||
    input.boardId.length === 0 ||
    input.ticketId.length === 0
  ) {
    return null;
  }
  return `/tickets/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.boardId)}/${encodeURIComponent(input.ticketId)}`;
}

// Canonical ticket push deep-link contract: `/tickets/{env}/{board}/{ticket}`.
// The server dispatcher
// (apps/server/src/workflow/Layers/WorkflowBoardNotificationDispatcher.ts) emits
// exactly this shape. Query-string/fragment forms are rejected; the structured
// boardId/ticketId/environmentId fields in `extractAgentNotificationDeepLink`
// remain a defensive fallback if `deepLink` is ever absent.
export function normalizeTicketDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "tickets") {
    return null;
  }

  try {
    return encodeTicketDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      boardId: decodeURIComponent(parts[3] ?? ""),
      ticketId: decodeURIComponent(parts[4] ?? ""),
    });
  } catch {
    return null;
  }
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string") {
    const normalizedThreadDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedThreadDeepLink) {
      return normalizedThreadDeepLink;
    }
    const normalizedTicketDeepLink = normalizeTicketDeepLink(deepLink);
    if (normalizedTicketDeepLink) {
      return normalizedTicketDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string" && threadId.length > 0) {
    const threadDeepLink = encodeThreadDeepLink({ environmentId, threadId });
    if (threadDeepLink) {
      return threadDeepLink;
    }
  }

  const boardId = data?.boardId;
  const ticketId = data?.ticketId;
  if (
    typeof environmentId === "string" &&
    typeof boardId === "string" &&
    typeof ticketId === "string"
  ) {
    return encodeTicketDeepLink({ environmentId, boardId, ticketId });
  }

  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
}
