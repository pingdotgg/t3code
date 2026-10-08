import { AuthMcpClientAccess } from "@t3tools/contracts";
import { useId } from "react";

import { AccessOption } from "../auth/ConnectAgentSurface";
import { RadioGroup } from "../ui/radio-group";

/** What agents here may do in an environment being linked, with what that does not allow. */
export function LinkAccessPicker({
  value,
  onChange,
}: {
  readonly value: AuthMcpClientAccess;
  readonly onChange: (access: AuthMcpClientAccess) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <span id={labelId} className="block text-xs font-medium">
        What agents here may do there
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onChange(next as AuthMcpClientAccess)}
      >
        {AuthMcpClientAccess.literals.map((option) => (
          <AccessOption key={option} access={option} selected={option === value} />
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        An agent here never gets more there than its own mode here either. Threads it starts there
        cannot change that environment's own threads, projects or settings.
      </p>
    </div>
  );
}
