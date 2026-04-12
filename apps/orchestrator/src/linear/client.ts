const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_CLIENT_CREDENTIALS_SCOPE = "read,write,comments:create,app:mentionable";

interface LinearClientCredentialsTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

interface LinearAuthorizationCodeTokenResponse {
  readonly access_token: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
}

interface LinearCommentCreateResponse {
  readonly commentCreate?: {
    readonly comment?: {
      readonly body?: string | null;
      readonly id?: string | null;
      readonly url?: string | null;
    } | null;
    readonly success?: boolean | null;
  } | null;
}

let cachedLinearAccessToken: {
  readonly accessToken: string;
  readonly expiresAt: number;
} | null = null;

function readRequiredEnvVar(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Linear environment variable: ${name}`);
  }

  return value;
}

async function fetchLinearJson<TResponse>(input: {
  readonly accessToken: string;
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}) {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: input.query,
      variables: input.variables ?? {},
    }),
  });

  const json = (await response.json()) as {
    readonly data?: TResponse;
    readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  };
  if (!response.ok || json.errors?.length) {
    const messages = json.errors?.map((error) => error.message ?? "Unknown error").join("; ");
    throw new Error(
      `Linear GraphQL request failed (${response.status}): ${messages ?? "Unknown error"}`,
    );
  }

  if (json.data === undefined) {
    throw new Error("Linear GraphQL request completed without a data payload");
  }

  return json.data;
}

async function fetchLinearClientCredentialsToken() {
  const clientId = readRequiredEnvVar("LINEAR_CLIENT_ID");
  const clientSecret = readRequiredEnvVar("LINEAR_CLIENT_SECRET");
  const scope =
    process.env.LINEAR_CLIENT_CREDENTIALS_SCOPE?.trim() ?? DEFAULT_CLIENT_CREDENTIALS_SCOPE;

  const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Linear client credentials token request failed (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as LinearClientCredentialsTokenResponse;
}

export async function getLinearAccessToken() {
  const directAccessToken = process.env.LINEAR_ACCESS_TOKEN?.trim();
  if (directAccessToken) {
    return directAccessToken;
  }

  if (cachedLinearAccessToken !== null && cachedLinearAccessToken.expiresAt > Date.now()) {
    return cachedLinearAccessToken.accessToken;
  }

  const token = await fetchLinearClientCredentialsToken();
  cachedLinearAccessToken = {
    accessToken: token.access_token,
    // Refresh early so callback handling doesn't race an expiring token.
    expiresAt: Date.now() + Math.max(0, token.expires_in - 300) * 1000,
  };
  return cachedLinearAccessToken.accessToken;
}

export async function exchangeLinearOAuthCode(input: {
  readonly code: string;
  readonly redirectUri: string;
}) {
  const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: readRequiredEnvVar("LINEAR_CLIENT_ID"),
      client_secret: readRequiredEnvVar("LINEAR_CLIENT_SECRET"),
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Linear OAuth code exchange failed (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as LinearAuthorizationCodeTokenResponse;
}

export async function postLinearComment(input: {
  readonly issueId: string;
  readonly parentId?: string;
  readonly body: string;
}) {
  const accessToken = await getLinearAccessToken();
  const data = await fetchLinearJson<LinearCommentCreateResponse>({
    accessToken,
    query: `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
            body
            url
          }
        }
      }
    `,
    variables: {
      input: {
        issueId: input.issueId,
        body: input.body,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      },
    },
  });

  const comment = data.commentCreate?.comment;
  if (!data.commentCreate?.success || !comment?.id) {
    throw new Error("Linear commentCreate did not return a comment id");
  }

  return {
    commentId: comment.id,
    body: comment.body ?? input.body,
    url: comment.url ?? undefined,
  };
}
