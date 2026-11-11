import type * as AcpSchema from "effect-acp/compat";

const MINIMAX_CODE_AGENT = "minimax-code";
const MINIMAX_CODE_LOGIN = "minimax-code-login";

// mcode advertises one terminal login. Without `--region` it reuses the saved
// account's region or falls back to Mainland China, so Global accounts could
// not sign in. Offer both regions, keeping the advertised ID for Mainland China
// so a configured authMethodId still selects the same login.
export function withMinimaxCodeRegions(
  agentKey: string,
  methods: ReadonlyArray<AcpSchema.AuthMethod> | undefined,
): ReadonlyArray<AcpSchema.AuthMethod> | undefined {
  const login = methods?.find((method) => method.id === MINIMAX_CODE_LOGIN);
  if (
    agentKey !== MINIMAX_CODE_AGENT ||
    methods === undefined ||
    login?.type !== "terminal" ||
    methods.some((method) => method.type === "terminal" && method.args?.includes("--region"))
  )
    return methods;
  const args = login.args ?? [];
  return methods.flatMap((method) =>
    method === login
      ? [
          {
            ...login,
            id: `${MINIMAX_CODE_LOGIN}:global`,
            name: `${login.name} (Global)`,
            args: [...args, "--region", "global"],
          },
          {
            ...login,
            name: `${login.name} (Mainland China)`,
            args: [...args, "--region", "cn"],
          },
        ]
      : [method],
  );
}
