import { useEnvironmentQuery } from "~/state/query";
import { cloudSandboxStatusAtom } from "~/connection/cloudSandbox";
import { Tv } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { MenuItem } from "../ui/menu";

export function CloudSandboxMenuItem({
  environmentId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly onOpen: () => void;
}) {
  const query = useEnvironmentQuery(
    environmentId !== null ? cloudSandboxStatusAtom(environmentId) : null,
  );
  const status = query.data;
  if (status === null || status === undefined) return null;
  return status.capabilities.desktopStreaming ? (
    <MenuItem onClick={onOpen}>
      <Tv />
      Cloud desktop
    </MenuItem>
  ) : null;
}
