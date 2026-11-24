import { parseTeamJoinLink } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { TeamJoinForm } from "../components/team/TeamJoinForm";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { toastManager } from "../components/ui/toast";

interface TeamJoinRouteParams {
  readonly serverUrl: string;
  readonly token: string;
  readonly pseudo: string | null;
}

let lastParsedTeamJoinParams: TeamJoinRouteParams | null = null;

function consumeTeamJoinParamsFromLocation(): TeamJoinRouteParams {
  if (typeof window === "undefined") {
    return { serverUrl: "", token: "", pseudo: null };
  }
  const parsed = parseTeamJoinLink(window.location.href);
  if (parsed !== null) {
    const resolved: TeamJoinRouteParams = {
      serverUrl: parsed.serverUrl,
      token: parsed.token,
      pseudo: parsed.prefilledPseudo,
    };
    lastParsedTeamJoinParams = resolved;
    // Strip the invite secret from the URL bar once captured in route context.
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("token");
    cleaned.hash = "";
    window.history.replaceState(null, "", `${cleaned.pathname}${cleaned.search}`);
    return resolved;
  }
  const url = new URL(window.location.href);
  const serverFromQuery = url.searchParams.get("server")?.trim() ?? "";
  if (
    lastParsedTeamJoinParams !== null &&
    (serverFromQuery.length === 0 || lastParsedTeamJoinParams.serverUrl === serverFromQuery)
  ) {
    return lastParsedTeamJoinParams;
  }
  return {
    serverUrl: serverFromQuery,
    token: "",
    pseudo: url.searchParams.get("pseudo")?.trim() || null,
  };
}

function TeamJoinRouteView() {
  const gt = useGT();
  const navigate = useNavigate();
  const { teamJoinParams } = Route.useRouteContext();

  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("Team invite")}
        title={gt("Join a team server")}
        description={gt(
          "Confirm your pseudo to redeem this invite and link the shared team server to your app.",
        )}
      />
      <div className="mt-6">
        <TeamJoinForm
          initialServerUrl={teamJoinParams.serverUrl}
          initialToken={teamJoinParams.token}
          initialPseudo={teamJoinParams.pseudo}
          onCancel={() => {
            lastParsedTeamJoinParams = null;
            void navigate({ to: "/", replace: true });
          }}
          onJoined={(result) => {
            lastParsedTeamJoinParams = null;
            toastManager.add({
              type: "success",
              title: gt("Joined {teamName}", { teamName: result.team.name }),
              description: gt("Connected as {pseudo}.", { pseudo: result.member.pseudo }),
            });
            void navigate({ to: "/", replace: true });
          }}
        />
      </div>
    </StandalonePage>
  );
}

export const Route = createFileRoute("/team/join")({
  beforeLoad: () => ({
    teamJoinParams: consumeTeamJoinParamsFromLocation(),
  }),
  component: TeamJoinRouteView,
});
