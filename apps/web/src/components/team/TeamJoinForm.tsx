import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TeamInviteJoinResult } from "@t3tools/client-runtime/team";
import {
  normalizeTeamPseudo,
  type TeamInvitePreviewResult,
  type TeamRole,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { previewTeamInvite, redeemTeamInvite } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export function formatTeamRoleLabel(role: TeamRole, gt: ReturnType<typeof useGT>): string {
  switch (role) {
    case "owner":
      return gt("Owner", { $context: "team member role" });
    case "admin":
      return gt("Admin", { $context: "team member role" });
    case "modo":
      return gt("Modo", { $context: "team member role" });
    case "regular":
      return gt("Regular", { $context: "team member role" });
  }
}

export function TeamJoinForm({
  initialServerUrl,
  initialToken,
  initialPseudo,
  onJoined,
  onCancel,
}: {
  readonly initialServerUrl: string;
  readonly initialToken: string;
  readonly initialPseudo: string | null;
  readonly onJoined: (result: TeamInviteJoinResult) => void;
  readonly onCancel?: () => void;
}) {
  const gt = useGT();
  const hasInitialInvite = initialServerUrl.trim().length > 0 && initialToken.trim().length > 0;
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [token, setToken] = useState(initialToken);
  const [pseudo, setPseudo] = useState(initialPseudo ?? "");
  const [preview, setPreview] = useState<TeamInvitePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(hasInitialInvite);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runPreview = useAtomCommand(previewTeamInvite, { reportFailure: false });
  const runRedeem = useAtomCommand(redeemTeamInvite, { reportFailure: false });

  const fetchPreview = useEffectEvent((targetServerUrl: string, targetToken: string) =>
    runPreview({
      serverUrl: targetServerUrl.trim(),
      token: targetToken.trim(),
    }),
  );

  const applyPreviewResult = useEffectEvent((result: Awaited<ReturnType<typeof runPreview>>) => {
    setPreviewing(false);
    if (result._tag === "Success") {
      setPreview(result.value);
      if (result.value.prefilledPseudo) {
        setPseudo((current) =>
          current.trim().length === 0 ? (result.value.prefilledPseudo ?? "") : current,
        );
      }
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setErrorMessage(thrownErrorMessage(error, m) ?? gt("Could not verify this team invite."));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads invite preview metadata when opening a team join link
  useEffect(() => {
    if (!hasInitialInvite) return;
    let cancelled = false;
    void fetchPreview(initialServerUrl, initialToken).then((result) => {
      if (!cancelled) applyPreviewResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [hasInitialInvite, initialServerUrl, initialToken]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedServer = serverUrl.trim();
    const trimmedToken = token.trim();
    const normalizedPseudo = normalizeTeamPseudo(pseudo);
    if (trimmedServer.length === 0) {
      setErrorMessage(gt("Enter a team server URL."));
      return;
    }
    if (trimmedToken.length === 0) {
      setErrorMessage(gt("Enter a team invite token."));
      return;
    }
    if (normalizedPseudo.length < 2) {
      setErrorMessage(gt("Choose a pseudo with at least 2 characters."));
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    const result = await runRedeem({
      serverUrl: trimmedServer,
      token: trimmedToken,
      pseudo: normalizedPseudo,
    });
    setSubmitting(false);

    if (result._tag === "Success") {
      onJoined(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setErrorMessage(thrownErrorMessage(error, m) ?? gt("Could not join the team."));
  };

  return (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
      {previewing ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Spinner />
          <span>
            <T>Checking team invite…</T>
          </span>
        </div>
      ) : preview ? (
        <div
          className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-3"
          data-testid="team-join-preview"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{preview.teamName}</span>
            <Badge variant="secondary" size="sm">
              {formatTeamRoleLabel(preview.role, gt)}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            <T>
              Server: <Var>{serverUrl}</Var>
            </T>
          </p>
        </div>
      ) : null}

      {initialServerUrl.trim().length === 0 ? (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground" htmlFor="team-join-server">
            <T>Team server URL</T>
          </label>
          <Input
            id="team-join-server"
            type="url"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.currentTarget.value)}
            placeholder="https://team.example.com"
            disabled={submitting}
          />
        </div>
      ) : null}

      {initialToken.trim().length === 0 ? (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground" htmlFor="team-join-token">
            <T>Invite token</T>
          </label>
          <Input
            id="team-join-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            placeholder="t3team_..."
            disabled={submitting}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground" htmlFor="team-join-pseudo">
          <T>Your pseudo</T>
        </label>
        <Input
          id="team-join-pseudo"
          data-testid="team-join-pseudo-input"
          value={pseudo}
          onChange={(event) => setPseudo(event.currentTarget.value)}
          placeholder={gt("e.g. alice")}
          autoComplete="off"
          disabled={submitting}
        />
        <p className="text-xs text-muted-foreground">
          <T>
            Threads you start on this team server appear with your pseudo prefix (for example,
            alice: Fix login bug).
          </T>
        </p>
      </div>

      {errorMessage ? (
        <p className="text-xs text-destructive" role="alert" data-testid="team-join-error">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel ? (
          <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
            <T>Cancel</T>
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting} data-testid="team-join-submit">
          {submitting ? (
            <>
              <Spinner />
              <T>Joining…</T>
            </>
          ) : (
            <T>Join team</T>
          )}
        </Button>
      </div>
    </form>
  );
}
