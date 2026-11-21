import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface CloudflareAccessSettings {
  readonly issuer: string;
  readonly certsUrl: string;
  readonly audience: string;
  readonly allowedEmails: ReadonlySet<string>;
}

export type CloudflareAccessConfig =
  | { readonly _tag: "Disabled" }
  | {
      readonly _tag: "Misconfigured";
      readonly reason: "incomplete" | "team_domain" | "emails" | "unreadable";
    }
  | { readonly _tag: "Enabled"; readonly settings: CloudflareAccessSettings };

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrElse(value, () => "").trim()),
  );

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const parseCloudflareAccessConfig = (input: {
  readonly teamDomain: string;
  readonly audience: string;
  readonly emails: string;
}): CloudflareAccessConfig => {
  const set = [input.teamDomain, input.audience, input.emails].filter((value) => value !== "");
  if (set.length === 0) return { _tag: "Disabled" };
  if (set.length < 3) return { _tag: "Misconfigured", reason: "incomplete" };
  const host = input.teamDomain
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!HOSTNAME.test(host)) return { _tag: "Misconfigured", reason: "team_domain" };
  const emails = input.emails
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  if (emails.length === 0 || emails.some((email) => !email.includes("@"))) {
    return { _tag: "Misconfigured", reason: "emails" };
  }
  return {
    _tag: "Enabled",
    settings: {
      issuer: `https://${host}`,
      certsUrl: `https://${host}/cdn-cgi/access/certs`,
      audience: input.audience,
      allowedEmails: new Set(emails),
    },
  };
};

/** Off unless all three variables are set; anything malformed keeps it off. */
export const readCloudflareAccessConfig: Effect.Effect<CloudflareAccessConfig> = Config.all({
  teamDomain: optionalString("T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN"),
  audience: optionalString("T3CODE_CLOUDFLARE_ACCESS_AUD"),
  emails: optionalString("T3CODE_CLOUDFLARE_ACCESS_EMAILS"),
}).pipe(
  Effect.map(parseCloudflareAccessConfig),
  Effect.orElseSucceed((): CloudflareAccessConfig => ({
    _tag: "Misconfigured",
    reason: "unreadable",
  })),
);
