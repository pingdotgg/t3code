import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";

export type ConnectionProvider = WorkSourceProviderName;
export type JiraDeployment = "cloud" | "server";

export interface ConnectionFormState {
  readonly provider: ConnectionProvider;
  readonly displayName: string;
  readonly token: string;
  readonly jiraDeployment: JiraDeployment;
  readonly baseUrl: string;
  readonly email: string;
}

export interface CreateConnectionInput {
  readonly provider: ConnectionProvider;
  readonly displayName: string;
  readonly token: string;
  // Jira only: "basic" (Cloud) or "bearer" (Server/DC). Non-Jira connections
  // omit authMode and the server defaults them to "pat".
  readonly authMode?: "basic" | "bearer";
  readonly baseUrl?: string;
  readonly email?: string;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export function isConnectionFormValid(state: ConnectionFormState): boolean {
  if (!state.displayName.trim() || !state.token.trim()) return false;
  if (state.provider !== "jira") return true;
  if (!isHttpUrl(state.baseUrl)) return false;
  if (state.jiraDeployment === "cloud" && !state.email.trim()) return false;
  return true;
}

export function buildConnectionInput(state: ConnectionFormState): CreateConnectionInput {
  const displayName = state.displayName.trim();
  const token = state.token.trim();
  if (state.provider !== "jira") {
    return { provider: state.provider, displayName, token };
  }
  if (state.jiraDeployment === "cloud") {
    return {
      provider: "jira",
      displayName,
      token,
      authMode: "basic",
      baseUrl: state.baseUrl.trim(),
      email: state.email.trim(),
    };
  }
  return {
    provider: "jira",
    displayName,
    token,
    authMode: "bearer",
    baseUrl: state.baseUrl.trim(),
  };
}
