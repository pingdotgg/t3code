import { LogInIcon, ExternalLinkIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { GitPanelSection } from "./GitPanelSection";

interface GitHubAuthSectionProps {
  accountLogin: string | null;
  installed: boolean;
  authenticated: boolean;
  isFetching: boolean;
  isAuthenticating: boolean;
  githubRepoUrl: string | null;
  errorMessage: string | null;
  onAuthAction: () => void;
  onOpenRepo: () => void;
}

export function GitHubAuthSection({
  accountLogin,
  installed,
  authenticated,
  isFetching,
  isAuthenticating,
  githubRepoUrl,
  errorMessage,
  onAuthAction,
  onOpenRepo,
}: GitHubAuthSectionProps) {
  return (
    <GitPanelSection
      title="GitHub"
      actions={
        accountLogin && (
          <Badge variant="outline" size="sm">
            @{accountLogin}
          </Badge>
        )
      }
    >
      {!installed ? (
        <p className="text-xs text-muted-foreground">
          Install <code className="rounded bg-muted px-1">gh</code> CLI to enable GitHub features
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={authenticated ? isFetching : isAuthenticating}
            onClick={onAuthAction}
          >
            <LogInIcon className="size-3.5" />
            {authenticated
              ? isFetching
                ? "Verifying..."
                : "Verify"
              : isAuthenticating
                ? "Authenticating..."
                : "Authenticate"}
          </Button>
          {githubRepoUrl && (
            <Button variant="ghost" size="xs" onClick={onOpenRepo}>
              <ExternalLinkIcon className="size-3.5" />
              Open repo
            </Button>
          )}
          {errorMessage && (
            <span className="text-xs text-destructive-foreground">{errorMessage}</span>
          )}
        </div>
      )}
    </GitPanelSection>
  );
}
