import * as UrlParams from "effect/http/UrlParams";

const credentialNames = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "code",
  "state",
  "client_secret",
  "password",
  "session",
  "sessionid",
  "wsTicket",
  "dpop",
  "pairingUrl",
  "challenge",
];

const redactTreeUrl = (value: string, names: ReadonlyArray<string | RegExp>) => {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted
    ? `${quoted[1]}${UrlParams.redactUrl(quoted[2]!, names)}${quoted[1]}`
    : UrlParams.redactUrl(value, names);
};

const redactText = (text: string, names: ReadonlyArray<string | RegExp>) => {
  if (URL.canParse(text, "https://preview.invalid") && !/\s/.test(text))
    return UrlParams.redactUrl(text, names);
  return text
    .split("\n")
    .map((line) => {
      const link = /^(\s*- \/url: )(.*)$/s.exec(line);
      if (link) return link[1] + redactTreeUrl(link[2]!, names);
      return line.replace(/\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi, (url) =>
        UrlParams.redactUrl(url, names),
      );
    })
    .join("\n");
};

const redactValue = <A>(value: A, names: ReadonlyArray<string | RegExp>): A => {
  if (typeof value === "string") return redactText(value, names) as A;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, names)) as A;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" && /^(?:url|pageUrl|href|src)$/i.test(key)
        ? UrlParams.redactUrl(entry, names)
        : redactValue(entry, names),
    ]),
  ) as A;
};

// Browser inputs and retained responses keep the URLs that perform navigation and downloads.
export const redactPreviewOutput = <A>(value: A, names: ReadonlyArray<string | RegExp>): A =>
  redactValue(value, [...names, ...credentialNames]);
