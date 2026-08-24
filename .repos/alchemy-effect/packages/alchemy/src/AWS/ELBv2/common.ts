import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Duration from "effect/Duration";
import type * as Redacted from "effect/Redacted";
import { toSeconds } from "../../Util/Duration.ts";
import type { TargetGroupArn } from "./TargetGroup.ts";

/**
 * A single forward target with an optional traffic weight. Used by the
 * weighted-forward action to split traffic across multiple target groups.
 */
export interface ForwardTarget {
  /**
   * The target group to forward to. Accepts a `TargetGroup` resource reference
   * — the engine resolves it to the ARN automatically (the `Input` machinery
   * applies deeply to nested props).
   */
  targetGroupArn: TargetGroupArn;
  /**
   * The weight applied to this target group when splitting traffic. The
   * proportion a target group receives is its weight divided by the sum of all
   * weights in the action.
   * @default 1
   */
  weight?: number;
}

/**
 * Forward action: routes the request to one or more target groups, optionally
 * with session stickiness so a client stays pinned to a single target group.
 */
export interface ForwardAction {
  /** Discriminator identifying this as a forward action. */
  type: "forward";
  /** One or more target groups to forward to (weighted). */
  targetGroups: ForwardTarget[];
  /** Session stickiness across the target groups in this action. */
  stickiness?: {
    /** Whether target-group stickiness is enabled. */
    enabled: boolean;
    /**
     * The time a client remains pinned to a target group — e.g. `"1 hour"`
     * or `Duration.hours(1)`. Sent to AWS as whole seconds.
     * @default "1 hour"
     */
    duration?: Duration.Input;
  };
}

/**
 * Redirect action: returns an HTTP redirect (301/302) to a computed URL. Any
 * component (protocol, host, path, query, port) may use the reserved keywords
 * `#{protocol}`, `#{host}`, `#{path}`, `#{query}`, `#{port}` to copy from the
 * original request.
 */
export interface RedirectAction {
  /** Discriminator identifying this as a redirect action. */
  type: "redirect";
  /** The redirect status code. */
  statusCode: "HTTP_301" | "HTTP_302";
  /** The protocol (`HTTP`, `HTTPS`, or `#{protocol}`). */
  protocol?: string;
  /** The port. */
  port?: string;
  /** The hostname. */
  host?: string;
  /** The absolute path, starting with `/`. */
  path?: string;
  /** The query parameters, not including the leading `?`. */
  query?: string;
}

/**
 * Fixed-response action: returns a static HTTP response directly from the load
 * balancer without forwarding to any target.
 */
export interface FixedResponseAction {
  /** Discriminator identifying this as a fixed-response action. */
  type: "fixedResponse";
  /** The HTTP response status code (2XX/4XX/5XX). */
  statusCode: string;
  /** The content type of the response body. */
  contentType?: string;
  /** The response body. */
  messageBody?: string;
}

/**
 * Authenticate-OIDC action: authenticates the request through an OpenID Connect
 * (OIDC) identity provider before forwarding to the next action.
 */
export interface AuthenticateOidcAction {
  /** Discriminator identifying this as an authenticate-OIDC action. */
  type: "authenticateOidc";
  /** The OIDC issuer identifier of the identity provider (IdP). */
  issuer: string;
  /** The authorization endpoint of the IdP. */
  authorizationEndpoint: string;
  /** The token endpoint of the IdP. */
  tokenEndpoint: string;
  /** The user info endpoint of the IdP. */
  userInfoEndpoint: string;
  /** The OAuth 2.0 client identifier registered with the IdP. */
  clientId: string;
  /** Required on first use; omit with `useExistingClientSecret: true` to keep the existing one. */
  clientSecret?: Redacted.Redacted<string>;
  /**
   * The set of user claims requested from the IdP.
   * @default "openid"
   */
  scope?: string;
  /**
   * The name of the cookie used to maintain session information.
   * @default "AWSELBAuthSessionCookie"
   */
  sessionCookieName?: string;
  /** The maximum duration of the authentication session — e.g. `"7 days"`. Sent to AWS as whole seconds. */
  sessionTimeout?: Duration.Input;
  /**
   * Behavior when the user is not authenticated (`deny`, `allow`, or `authenticate`).
   * @default "authenticate"
   */
  onUnauthenticatedRequest?: "deny" | "allow" | "authenticate";
  /** Set to `true` on updates to keep the client secret already stored on the action. */
  useExistingClientSecret?: boolean;
}

/**
 * Authenticate-Cognito action: authenticates the request through an Amazon
 * Cognito user pool before forwarding to the next action.
 */
export interface AuthenticateCognitoAction {
  /** Discriminator identifying this as an authenticate-Cognito action. */
  type: "authenticateCognito";
  /** The ARN of the Cognito user pool. */
  userPoolArn: string;
  /** The ID of the Cognito user pool client. */
  userPoolClientId: string;
  /** The domain prefix or fully-qualified domain of the Cognito user pool. */
  userPoolDomain: string;
  /**
   * The set of user claims requested from Cognito.
   * @default "openid"
   */
  scope?: string;
  /**
   * The name of the cookie used to maintain session information.
   * @default "AWSELBAuthSessionCookie"
   */
  sessionCookieName?: string;
  /** The maximum duration of the authentication session — e.g. `"7 days"`. Sent to AWS as whole seconds. */
  sessionTimeout?: Duration.Input;
  /**
   * Behavior when the user is not authenticated (`deny`, `allow`, or `authenticate`).
   * @default "authenticate"
   */
  onUnauthenticatedRequest?: "deny" | "allow" | "authenticate";
}

/**
 * A listener/rule action. The terminal action of a listener default-action or a
 * rule must be `forward`, `redirect`, or `fixedResponse`; authentication
 * actions are non-terminal and are ordered before the terminal action.
 */
export type ListenerAction =
  | ForwardAction
  | RedirectAction
  | FixedResponseAction
  | AuthenticateOidcAction
  | AuthenticateCognitoAction;

// At reconcile time the engine has already resolved Input/resource refs to
// plain ARN strings.
const resolveTargetGroupArn = (ref: TargetGroupArn): string => ref;

/**
 * Serialize a list of {@link ListenerAction} into the wire `Action[]` shape AWS
 * expects, assigning `Order` so authentication actions run before the terminal
 * action. Shared by both Listener default-actions and ListenerRule actions.
 */
export const serializeActions = (actions: ListenerAction[]): elbv2.Action[] =>
  actions.map((action, index): elbv2.Action => {
    const Order = index + 1;
    switch (action.type) {
      case "forward":
        return {
          Type: "forward",
          Order,
          ForwardConfig: {
            TargetGroups: action.targetGroups.map((t) => ({
              TargetGroupArn: resolveTargetGroupArn(t.targetGroupArn),
              Weight: t.weight,
            })),
            TargetGroupStickinessConfig: action.stickiness
              ? {
                  Enabled: action.stickiness.enabled,
                  DurationSeconds: toSeconds(action.stickiness.duration),
                }
              : undefined,
          },
          // For a single, unweighted target group, AWS also accepts the legacy
          // top-level TargetGroupArn; sending only ForwardConfig is canonical.
          TargetGroupArn:
            action.targetGroups.length === 1 &&
            action.targetGroups[0].weight === undefined
              ? resolveTargetGroupArn(action.targetGroups[0].targetGroupArn)
              : undefined,
        };
      case "redirect":
        return {
          Type: "redirect",
          Order,
          RedirectConfig: {
            StatusCode: action.statusCode,
            Protocol: action.protocol,
            Port: action.port,
            Host: action.host,
            Path: action.path,
            Query: action.query,
          },
        };
      case "fixedResponse":
        return {
          Type: "fixed-response",
          Order,
          FixedResponseConfig: {
            StatusCode: action.statusCode,
            ContentType: action.contentType,
            MessageBody: action.messageBody,
          },
        };
      case "authenticateOidc":
        return {
          Type: "authenticate-oidc",
          Order,
          AuthenticateOidcConfig: {
            Issuer: action.issuer,
            AuthorizationEndpoint: action.authorizationEndpoint,
            TokenEndpoint: action.tokenEndpoint,
            UserInfoEndpoint: action.userInfoEndpoint,
            ClientId: action.clientId,
            // Redacted end-to-end: distilled's AuthenticateOidcActionConfig
            // marks ClientSecret sensitive, so the Redacted passes straight
            // through and is only unwrapped by the wire serializer.
            ClientSecret: action.clientSecret,
            Scope: action.scope,
            SessionCookieName: action.sessionCookieName,
            SessionTimeout: toSeconds(action.sessionTimeout),
            OnUnauthenticatedRequest: action.onUnauthenticatedRequest,
            UseExistingClientSecret: action.useExistingClientSecret,
          },
        };
      case "authenticateCognito":
        return {
          Type: "authenticate-cognito",
          Order,
          AuthenticateCognitoConfig: {
            UserPoolArn: action.userPoolArn,
            UserPoolClientId: action.userPoolClientId,
            UserPoolDomain: action.userPoolDomain,
            Scope: action.scope,
            SessionCookieName: action.sessionCookieName,
            SessionTimeout: toSeconds(action.sessionTimeout),
            OnUnauthenticatedRequest: action.onUnauthenticatedRequest,
          },
        };
    }
  });

/**
 * A condition under which a {@link ListenerRule} matches a request. Exactly one
 * of the config fields should be set per condition; multiple conditions on a
 * rule are AND-ed together, while values within a single condition are OR-ed.
 */
export interface ListenerRuleCondition {
  /** Match on the `Host` header. Supports `*` and `?` wildcards. */
  hostHeader?: { values?: string[]; regexValues?: string[] };
  /** Match on the request path. Supports `*` and `?` wildcards. */
  pathPattern?: { values?: string[]; regexValues?: string[] };
  /** Match on a named HTTP header. */
  httpHeader?: {
    name: string;
    values?: string[];
    regexValues?: string[];
  };
  /** Match on query-string key/value pairs. Supports `*` and `?` wildcards. */
  queryString?: { values: { key?: string; value: string }[] };
  /** Match on the HTTP request method (GET, POST, ...). */
  httpRequestMethod?: { values: string[]; regexValues?: string[] };
  /** Match on the source IP CIDR. */
  sourceIp?: { values: string[] };
}

/**
 * Serialize a list of {@link ListenerRuleCondition} into the wire
 * `RuleCondition[]` shape AWS expects.
 */
export const serializeConditions = (
  conditions: ListenerRuleCondition[],
): elbv2.RuleCondition[] =>
  conditions.flatMap((condition): elbv2.RuleCondition[] => {
    const out: elbv2.RuleCondition[] = [];
    if (condition.hostHeader) {
      out.push({
        Field: "host-header",
        HostHeaderConfig: {
          Values: condition.hostHeader.values,
          RegexValues: condition.hostHeader.regexValues,
        },
      });
    }
    if (condition.pathPattern) {
      out.push({
        Field: "path-pattern",
        PathPatternConfig: {
          Values: condition.pathPattern.values,
          RegexValues: condition.pathPattern.regexValues,
        },
      });
    }
    if (condition.httpHeader) {
      out.push({
        Field: "http-header",
        HttpHeaderConfig: {
          HttpHeaderName: condition.httpHeader.name,
          Values: condition.httpHeader.values,
          RegexValues: condition.httpHeader.regexValues,
        },
      });
    }
    if (condition.queryString) {
      out.push({
        Field: "query-string",
        QueryStringConfig: {
          Values: condition.queryString.values.map((v) => ({
            Key: v.key,
            Value: v.value,
          })),
        },
      });
    }
    if (condition.httpRequestMethod) {
      out.push({
        Field: "http-request-method",
        HttpRequestMethodConfig: {
          Values: condition.httpRequestMethod.values,
        },
      });
    }
    if (condition.sourceIp) {
      out.push({
        Field: "source-ip",
        SourceIpConfig: { Values: condition.sourceIp.values },
      });
    }
    return out;
  });
