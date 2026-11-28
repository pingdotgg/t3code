import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  effectiveUpstreamClientThreadVisibility,
  type EnvironmentId,
  type TeamCreateMobilePairingLinkResult,
  type TeamMember,
  type TeamMobilePairingLinkSummary,
  type TeamUpstreamClientThreadVisibility,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { CheckIcon, CopyIcon, QrCodeIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatExpiresInLabel } from "~/timestampFormat";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "../settings/pairingUrls";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { formatTeamRoleLabel } from "./TeamJoinForm";

function resolveMobilePairingUrl(serverBaseUrl: string, credential: string): string | null {
  const trimmed = serverBaseUrl.trim();
  if (!trimmed || !URL.canParse(trimmed)) return null;
  return (
    resolveHostedPairingUrl(trimmed, credential) ?? resolveDesktopPairingUrl(trimmed, credential)
  );
}

function CopyableMobileValueRow({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "mobile pairing credential",
      unavailableMessage: msg(
        "Clipboard API is unavailable while copying mobile pairing credential.",
      ),
      failureMessage: msg("Failed to copy mobile pairing credential to the clipboard."),
    },
  });

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input value={value} readOnly data-testid={testId} />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => copyToClipboard(value)}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? gt("Copied") : gt("Copy")}
        </Button>
      </div>
    </div>
  );
}

export function TeamMobileCompatSection({
  environmentId,
  serverBaseUrl,
  currentMember,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverBaseUrl: string;
  readonly currentMember: TeamMember | null;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);

  const canUpdateVisibility = useAtomValue(
    teamEnvironment.updateMyMobileVisibility.permissionAtom(environmentId),
  );
  const canCreatePairing = useAtomValue(
    teamEnvironment.createMobilePairingLink.permissionAtom(environmentId),
  );
  const canRevokePairing = useAtomValue(
    teamEnvironment.revokeMyMobilePairingLink.permissionAtom(environmentId),
  );

  const runUpdateVisibility = useAtomCommand(teamEnvironment.updateMyMobileVisibility, {
    reportFailure: false,
  });
  const runCreatePairing = useAtomCommand(teamEnvironment.createMobilePairingLink, {
    reportFailure: false,
  });
  const runListPairings = useAtomCommand(teamEnvironment.listMyMobilePairingLinks, {
    reportFailure: false,
  });
  const runRevokePairing = useAtomCommand(teamEnvironment.revokeMyMobilePairingLink, {
    reportFailure: false,
  });

  const [savingVisibility, setSavingVisibility] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [creatingPairing, setCreatingPairing] = useState(false);
  const [latestPairingByEnv, setLatestPairingByEnv] = useState<
    Readonly<Record<string, TeamCreateMobilePairingLinkResult | undefined>>
  >({});
  const [pendingLinksByEnv, setPendingLinksByEnv] = useState<
    Readonly<Record<string, ReadonlyArray<TeamMobilePairingLinkSummary> | undefined>>
  >({});
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const currentMemberId = currentMember?.id ?? null;
  const loadPendingLinks = useEffectEvent((targetEnvironmentId: EnvironmentId) =>
    runListPairings({ environmentId: targetEnvironmentId, input: {} }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the caller's pending member-bound mobile pairing links from the Team Server when the selected team environment or member changes.
  useEffect(() => {
    if (currentMemberId === null) return;
    const targetEnvironmentId = environmentId;
    let cancelled = false;
    void loadPendingLinks(targetEnvironmentId).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setPendingLinksByEnv((prev) => ({
          ...prev,
          [targetEnvironmentId]: result.value.pairingLinks,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, currentMemberId]);

  if (currentMember === null) return null;

  const visibility = effectiveUpstreamClientThreadVisibility(currentMember);
  const visibilityLabels: Readonly<Record<TeamUpstreamClientThreadVisibility, string>> = {
    owned_and_followed: gt("My threads + followed (default)"),
    all_accessible: gt("All accessible team threads"),
  };

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const refreshPendingLinks = async (targetEnvironmentId: EnvironmentId = environmentId) => {
    const listed = await runListPairings({ environmentId: targetEnvironmentId, input: {} });
    if (listed._tag === "Success") {
      setPendingLinksByEnv((prev) => ({
        ...prev,
        [targetEnvironmentId]: listed.value.pairingLinks,
      }));
    }
  };

  const handleVisibilityChange = async (next: TeamUpstreamClientThreadVisibility) => {
    if (next === visibility || savingVisibility || !canUpdateVisibility) return;
    setSavingVisibility(true);
    const result = await runUpdateVisibility({
      environmentId,
      input: { upstreamClientThreadVisibility: next },
    });
    setSavingVisibility(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Mobile thread visibility updated"),
        description:
          next === "owned_and_followed"
            ? gt("Upstream mobile clients will show only your threads and threads you follow.")
            : gt("Upstream mobile clients will show all team threads you can access."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(
        gt("Could not update mobile thread visibility"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const handleCreateMobilePairing = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingPairing || !canCreatePairing) return;
    const targetEnvironmentId = environmentId;
    setCreatingPairing(true);
    const trimmedLabel = labelInput.trim();
    const result = await runCreatePairing({
      environmentId: targetEnvironmentId,
      input: trimmedLabel.length > 0 ? { label: trimmedLabel } : {},
    });
    setCreatingPairing(false);
    if (result._tag === "Success") {
      setLabelInput("");
      setLatestPairingByEnv((prev) => ({
        ...prev,
        [targetEnvironmentId]: result.value,
      }));
      await refreshPendingLinks(targetEnvironmentId);
      toastManager.add({
        type: "success",
        title: gt("Mobile pairing code created"),
        description: gt(
          "Scan the QR code or enter the code in the official T3 Code mobile app to connect as {pseudo}.",
          { pseudo: currentMember.pseudo },
        ),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not create mobile pairing code"), squashAtomCommandFailure(result));
    }
  };

  const handleRevokePairing = async (id: string) => {
    if (!canRevokePairing) return;
    const confirmed = await confirmTeamDestructiveAction(
      gt(
        "Revoke this mobile pairing code?\nDevices using this pending code will no longer be able to pair.",
      ),
    );
    if (!confirmed) return;
    const targetEnvironmentId = environmentId;
    setRevokingId(id);
    const result = await runRevokePairing({ environmentId: targetEnvironmentId, input: { id } });
    setRevokingId(null);
    if (result._tag === "Success") {
      setLatestPairingByEnv((prev) =>
        prev[targetEnvironmentId]?.id === id ? { ...prev, [targetEnvironmentId]: undefined } : prev,
      );
      await refreshPendingLinks(targetEnvironmentId);
      toastManager.add({
        type: "success",
        title: gt("Mobile pairing code revoked"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not revoke mobile pairing code"), squashAtomCommandFailure(result));
    }
  };

  const activeLatestPairing = latestPairingByEnv[environmentId] ?? null;
  const activeLatestPairingUrl = activeLatestPairing
    ? resolveMobilePairingUrl(serverBaseUrl, activeLatestPairing.credential)
    : null;
  const pendingLinks = pendingLinksByEnv[environmentId] ?? [];
  const activePendingLinks = pendingLinks.filter((link) => {
    const expiresMs = Date.parse(link.expiresAt);
    return Number.isNaN(expiresMs) || expiresMs > nowMs;
  });

  return (
    <SettingsSection
      id="teams-mobile-compat"
      title={gt("Upstream mobile app")}
      icon={<SmartphoneIcon className="size-4" />}
      data-testid="team-mobile-compat-section"
    >
      <SettingsRow
        id="teams-mobile-visibility"
        title={gt("Visible threads on upstream mobile")}
        description={gt(
          "Choose which team threads appear in the official T3 Code mobile app sidebar. Your Views, locks, and follow notifications remain enforced by the server.",
        )}
        control={
          <Select
            value={visibility}
            disabled={savingVisibility || !canUpdateVisibility}
            onValueChange={(value) => {
              if (value === "owned_and_followed" || value === "all_accessible") {
                void handleVisibilityChange(value);
              }
            }}
          >
            <SelectTrigger size="sm" data-testid="team-mobile-visibility-select">
              <SelectValue>{visibilityLabels[visibility]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="owned_and_followed">
                {visibilityLabels.owned_and_followed}
              </SelectItem>
              <SelectItem value="all_accessible">{visibilityLabels.all_accessible}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="teams-connect-mobile"
        title={gt("Connect mobile")}
        description={gt(
          "Generate a standard pairing QR code or code bound to {pseudo} ({role}) for the official upstream T3 Code iOS/Android app.",
          {
            pseudo: currentMember.pseudo,
            role: formatTeamRoleLabel(currentMember.role, gt),
          },
        )}
      >
        <form
          className="mt-2 space-y-3 pb-3"
          onSubmit={(event) => void handleCreateMobilePairing(event)}
          data-testid="team-mobile-connect-section"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                value={labelInput}
                onChange={(event) => setLabelInput(event.currentTarget.value)}
                placeholder={gt("Device label (optional, e.g. iPhone)")}
                disabled={creatingPairing || !canCreatePairing}
                data-testid="team-mobile-pairing-label-input"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={creatingPairing || !canCreatePairing}
              data-testid="team-mobile-pairing-create"
            >
              {creatingPairing ? (
                <>
                  <Spinner />
                  <T>Creating…</T>
                </>
              ) : (
                <>
                  <QrCodeIcon className="size-3.5" />
                  <T>Create pairing code</T>
                </>
              )}
            </Button>
          </div>

          {activeLatestPairing ? (
            <div
              className="space-y-3 rounded-lg border border-border/70 bg-muted/25 p-3"
              data-testid="team-mobile-pairing-generated"
            >
              <div className="flex flex-wrap items-start gap-4">
                {activeLatestPairingUrl ? (
                  <div
                    className="shrink-0 rounded-md bg-white p-2"
                    data-testid="team-mobile-pairing-qr"
                  >
                    <QRCodeSvg
                      value={activeLatestPairingUrl}
                      size={128}
                      marginSize={2}
                      title={gt("Team mobile pairing QR code")}
                    />
                  </div>
                ) : null}
                <div className="min-w-0 flex-1 space-y-2.5">
                  <CopyableMobileValueRow
                    label={gt("Pairing code")}
                    value={activeLatestPairing.credential}
                    testId="team-mobile-pairing-code"
                  />
                  {activeLatestPairingUrl ? (
                    <CopyableMobileValueRow
                      label={gt("Pairing link")}
                      value={activeLatestPairingUrl}
                      testId="team-mobile-pairing-url"
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      <T>
                        Bound to <Var>{currentMember.pseudo}</Var> ·{" "}
                        <Var>{formatExpiresInLabel(activeLatestPairing.expiresAt, nowMs, m)}</Var>
                      </T>
                    </span>
                    {canRevokePairing ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={revokingId === activeLatestPairing.id}
                        onClick={() => void handleRevokePairing(activeLatestPairing.id)}
                        data-testid="team-mobile-pairing-revoke"
                      >
                        <Trash2Icon />
                        <T>Revoke</T>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activePendingLinks.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                <T>Pending mobile pairing codes</T>
              </p>
              {activePendingLinks.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {link.label ?? gt("Mobile pairing code")}
                    </span>
                    <Badge variant="outline" size="sm">
                      {formatExpiresInLabel(link.expiresAt, nowMs, m)}
                    </Badge>
                  </div>
                  {canRevokePairing ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={revokingId === link.id}
                      onClick={() => void handleRevokePairing(link.id)}
                    >
                      <Trash2Icon />
                      <T>Revoke</T>
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </form>
      </SettingsRow>
    </SettingsSection>
  );
}
