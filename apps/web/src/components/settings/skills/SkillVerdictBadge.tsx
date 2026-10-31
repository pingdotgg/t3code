import type { SkillVerdict } from "@t3tools/contracts";

import { Badge } from "../../ui/badge";
import { verdictLabel, verdictReason } from "./skillsSettings.logic";

export function SkillVerdictBadge({ verdict }: { readonly verdict: SkillVerdict }) {
  const reason = verdictReason(verdict);
  return (
    <Badge
      variant={
        verdict.verdict === "helps" ? "success" : verdict.verdict === "hurts" ? "error" : "outline"
      }
      title={reason ?? undefined}
    >
      {verdictLabel(verdict)}
    </Badge>
  );
}
