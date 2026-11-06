export type CredentialType =
  | "CREDENTIAL_TYPE_UNSPECIFIED"
  | "USERNAME_AND_PASSWORD"
  | "API_KEY"
  | "OAUTH2_AUTHORIZATION_CODE"
  | "OAUTH2_IMPLICIT"
  | "OAUTH2_CLIENT_CREDENTIALS"
  | "OAUTH2_RESOURCE_OWNER_CREDENTIALS"
  | "JWT"
  | "AUTH_TOKEN"
  | "SERVICE_ACCOUNT"
  | "CLIENT_CERTIFICATE_ONLY"
  | "OIDC_TOKEN"
  | (string & {});

export type AuthConfigVisibility =
  | "AUTH_CONFIG_VISIBILITY_UNSPECIFIED"
  | "PRIVATE"
  | "CLIENT_VISIBLE"
  | (string & {});

export type UsernameAndPassword = {
  /** Username used to authenticate. */
  username?: string;
  /** Password used to authenticate. */
  password?: string;
};

export type AuthToken = {
  /** Token type (`Basic`, `Bearer`, …). */
  type?: string;
  /** Token value. */
  token?: string;
};

export type JwtCredential = {
  /** JWT header JSON. */
  jwtHeader?: string;
  /** JWT payload JSON. */
  jwtPayload?: string;
  /** Shared secret used to sign the token. */
  secret?: string;
};

export type ServiceAccountCredentials = {
  /** Service account email. */
  serviceAccount?: string;
  /** Space-delimited OAuth scopes. */
  scope?: string;
};

export type OidcToken = {
  /** Service account email used as the token identity. */
  serviceAccountEmail?: string;
  /** Audience claim. */
  audience?: string;
};

export type DecryptedCredential = {
  /** Credential type matching `credentialType` on the auth config. */
  credentialType?: CredentialType;
  /** Username and password credential. */
  usernameAndPassword?: UsernameAndPassword;
  /** HTTP Authorization token. */
  authToken?: AuthToken;
  /** JWT credential. */
  jwt?: JwtCredential;
  /** Service account credential. */
  serviceAccountCredentials?: ServiceAccountCredentials;
  /** Google OIDC ID token. */
  oidcToken?: OidcToken;
};

export type TriggerType =
  | "TRIGGER_TYPE_UNSPECIFIED"
  | "CRON"
  | "API"
  | "SFDC_CHANNEL"
  | "CLOUD_PUBSUB_EXTERNAL"
  | "SFDC_CDC_CHANNEL"
  | "CLOUD_SCHEDULER"
  | "INTEGRATION_CONNECTOR_TRIGGER"
  | "PRIVATE_TRIGGER"
  | "CLOUD_PUBSUB"
  | "EVENTARC_TRIGGER"
  | (string & {});

export type TriggerConfig = {
  /** User-created label. */
  label?: string;
  /** Trigger type. */
  triggerType?: TriggerType;
  /** Unique number within the integration UI. */
  triggerNumber?: string;
  /**
   * Trigger id. For API triggers this is `api_trigger/{name}` when
   * `properties` contains `Trigger name`.
   */
  triggerId?: string;
  /** Configurable trigger properties (`Trigger name`, …). */
  properties?: Record<string, string | undefined>;
  /** Human-readable description. */
  description?: string;
};

export type ClientCertificate = {
  /** PEM-encoded X.509 certificate, including BEGIN/END lines. */
  sslCertificate?: string;
  /** PEM-encoded private key, including BEGIN/END lines. */
  encryptedPrivateKey?: string;
  /** Passphrase if the private key is encrypted. */
  passphrase?: string;
};

export const credentialBody = (
  credential: DecryptedCredential | undefined,
  defaultType?: CredentialType,
) =>
  credential === undefined
    ? undefined
    : {
        credentialType: credential.credentialType ?? defaultType,
        usernameAndPassword: credential.usernameAndPassword,
        authToken: credential.authToken,
        jwt: credential.jwt,
        serviceAccountCredentials: credential.serviceAccountCredentials,
        oidcToken: credential.oidcToken,
      };
