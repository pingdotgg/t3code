import { issueHostKey } from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";

export function issueUrlConnectionId(
  url: string,
  source: {
    readonly tracker: string;
    readonly host: string;
    readonly connectionId?: string | undefined;
  },
): string | undefined {
  const target = parseIssueUrl(url, source);
  return target?.tracker === source.tracker &&
    issueHostKey(target.host) === issueHostKey(source.host)
    ? source.connectionId
    : undefined;
}
