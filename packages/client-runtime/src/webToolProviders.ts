import type { WebToolProvider } from "@t3tools/contracts";

type ApiProvider = Exclude<WebToolProvider, "builtin">;

export const WEB_TOOL_PROVIDER_LABELS: Record<WebToolProvider, string> = {
  firecrawl: "Firecrawl",
  exa: "Exa",
  tavily: "Tavily",
  builtin: "Built-in",
};

/** What the Settings → Web picker says about each choice, on every client. */
export const WEB_PROVIDER_DESCRIPTION =
  "The service behind the web_search and web_fetch tools T3 Code gives every agent. While one is selected, agents are asked to use it first and keep their own web search and fetch as the fallback; Built-in leaves them on their own.";

/** Where each provider's write-only API key lives in `settings.web`, and how to get one. */
export const WEB_TOOL_API_KEYS: Record<
  ApiProvider,
  {
    readonly field: "firecrawlApiKey" | "exaApiKey" | "tavilyApiKey";
    readonly description: string;
    readonly link: string;
  }
> = {
  firecrawl: {
    field: "firecrawlApiKey",
    description:
      "Optional. Without a key, Firecrawl's keyless tier is used on eligible networks; a key raises the rate limits.",
    link: "https://www.firecrawl.dev/app/api-keys",
  },
  exa: {
    field: "exaApiKey",
    description: "Required for Exa.",
    link: "https://dashboard.exa.ai/api-keys",
  },
  tavily: {
    field: "tavilyApiKey",
    description: "Required for Tavily.",
    link: "https://app.tavily.com/home",
  },
};
