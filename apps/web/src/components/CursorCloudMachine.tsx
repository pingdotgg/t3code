import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  CURSOR_CLOUD_INSTANCE_ID,
  type CursorCloudMachineState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { CURSOR_CLOUD_MACHINE_LABELS } from "@t3tools/client-runtime/state/cursorCloud";
import { readLocalApi } from "../localApi";
import { cursorCloud } from "../state/cursorCloud";
import { useEnvironment, useEnvironmentProviders } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import { toastManager } from "./ui/toast";

const MACHINE_STATES: Record<
  CursorCloudMachineState,
  {
    readonly variant: "outline" | "warning" | "success" | "secondary" | "error";
    readonly detail: string;
  }
> = {
  pending: {
    variant: "outline",
    detail: "Cursor creates this thread's machine when you send the first message.",
  },
  starting: {
    variant: "warning",
    detail: "The machine is starting. Files, Git, and terminals connect once it is up.",
  },
  running: {
    variant: "success",
    detail: "Files, Git, and terminals in this thread run on the machine.",
  },
  asleep: {
    variant: "secondary",
    detail: "Cursor stops idle machines. Wake it to browse files and Git; a message also wakes it.",
  },
  expired: {
    variant: "outline",
    detail: "Cursor removed this machine. Pushed branches keep its work.",
  },
  error: {
    variant: "error",
    detail: "The cloud agent reported an error.",
  },
};

/** The thread's Cursor Cloud VM: whether it is up, and the ways to wake or open it. */
export function CursorCloudMachineBadge({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const machine = useEnvironmentQuery(cursorCloud.machine({ environmentId, input: { threadId } }));
  const wake = useAtomCommand(cursorCloud.wakeMachine, { reportFailure: false });
  const canWake = useAtomValue(cursorCloud.wakeMachine.permissionAtom(environmentId));
  const [waking, setWaking] = useState(false);
  const status = machine.data;
  const state = waking && status?.state === "asleep" ? "starting" : (status?.state ?? null);
  const presentation = state === null ? null : MACHINE_STATES[state];
  const agentWorking = status?.agentStatus === "running";
  const agentUrl = status?.agentUrl;
  const wakeMachine = async () => {
    setWaking(true);
    const result = await wake({ environmentId, input: { threadId } });
    setWaking(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not wake the Cursor Cloud machine" });
    }
  };
  const openAgent = (url: string) => {
    const api = readLocalApi();
    if (api) void api.shell.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Badge
            render={<button type="button" aria-label="Cursor Cloud machine" />}
            variant={presentation?.variant ?? (machine.error ? "error" : "outline")}
            size="lg"
          />
        }
      >
        Cloud ·{" "}
        {state === null
          ? machine.error
            ? "Unavailable"
            : "Checking"
          : CURSOR_CLOUD_MACHINE_LABELS[state]}
        {agentWorking && state === "running" ? " · Working" : ""}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Cursor Cloud machine</MenuGroupLabel>
          <p className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground">
            {machine.error ?? presentation?.detail ?? "Checking the machine..."}
          </p>
        </MenuGroup>
        {state === "asleep" || agentUrl !== undefined ? <MenuSeparator /> : null}
        {state === "asleep" ? (
          <MenuItem disabled={!canWake || waking} onClick={() => void wakeMachine()}>
            Wake machine
          </MenuItem>
        ) : null}
        {agentUrl !== undefined ? (
          <MenuItem onClick={() => openAgent(agentUrl)}>Open in Cursor</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function CursorCloudConnection({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.cursorCloud === true;
  const status = useEnvironmentQuery(
    supported ? cursorCloud.status({ environmentId, input: {} }) : null,
  );
  const connect = useAtomCommand(cursorCloud.connect);
  const disconnect = useAtomCommand(cursorCloud.disconnect);
  const canConnect = useAtomValue(cursorCloud.connect.permissionAtom(environmentId));
  const canDisconnect = useAtomValue(cursorCloud.disconnect.permissionAtom(environmentId));
  const providers = useEnvironmentProviders();
  const accounts = (providers.get(environmentId) ?? []).filter(
    (provider) =>
      provider.driver === "cursor" &&
      provider.enabled &&
      provider.instanceId !== CURSOR_CLOUD_INSTANCE_ID,
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  const account = accounts.find((provider) => provider.instanceId === accountId) ?? accounts[0];
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const changeConnection = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = status.data?.enabled
      ? await disconnect({ environmentId, input: {} })
      : account
        ? await connect({ environmentId, input: { instanceId: account.instanceId } })
        : null;
    inFlight.current = false;
    setBusy(false);
    if (result?._tag === "Success") setAccountId(null);
  };
  if (!supported) return null;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        Select Cursor Cloud in a project's Run on picker, then send messages in the normal composer.
        Runs use your Cursor account and the project's pushed GitHub commit. Configure repository
        access in Cursor first.
      </p>
      {status.error ? <p role="alert">{status.error}</p> : null}
      {status.data?.enabled ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost-muted"
            disabled={busy || !canDisconnect}
            onClick={() => void changeConnection()}
          >
            Disconnect
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Disconnecting disables this cloud machine. Your Cursor sign-in and running tasks stay in
            Cursor.
          </p>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void changeConnection();
          }}
        >
          {accounts.length > 0 ? (
            <div className="w-full">
              <Select
                value={account?.instanceId ?? null}
                onValueChange={(value) => setAccountId(value)}
              >
                <SelectTrigger aria-label="Cursor account">
                  <SelectValue>
                    {account?.displayName ?? "Cursor"}
                    {account?.auth.email ? ` · ${account.auth.email}` : ""}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {accounts.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName ?? "Cursor"}
                      {provider.auth.email ? ` · ${provider.auth.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <Button variant="outline" render={<Link to="/settings/providers" />}>
            Sign in with Cursor
          </Button>
          <Button
            type="submit"
            disabled={
              busy || account?.auth.status !== "authenticated" || !canConnect || !status.isSuccess
            }
          >
            Connect Cursor Cloud
          </Button>
        </form>
      )}
    </div>
  );
}
