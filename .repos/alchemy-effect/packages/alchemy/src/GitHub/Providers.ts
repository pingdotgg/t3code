import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { type GitHubAuthOptions, makeGitHubAuth } from "./AuthProvider.ts";
import {
  BranchProtection,
  BranchProtectionProvider,
} from "./BranchProtection.ts";
import { Collaborator, CollaboratorProvider } from "./Collaborator.ts";
import { Comment, CommentProvider } from "./Comment.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Label, LabelProvider } from "./Label.ts";
import { Milestone, MilestoneProvider } from "./Milestone.ts";
import { Issue, IssueProvider } from "./Issue.ts";
import { PullRequest, PullRequestProvider } from "./PullRequest.ts";
import { Release, ReleaseProvider } from "./Release.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Ruleset, RulesetProvider } from "./Ruleset.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { TeamAccess, TeamAccessProvider } from "./TeamAccess.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";
import { WikiPage, WikiPageProvider } from "./WikiPage.ts";

export { GitHubCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GitHub",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ProvidersOptions extends GitHubAuthOptions {}

/**
 * GitHub resource providers and the GitHub AuthProvider discovered by the CLI.
 *
 * Pass `baseUrl` to pin every GitHub resource to a GitHub Enterprise host
 * without relying on the auth provider's configuration:
 *
 * ```typescript
 * providers: GitHub.providers({ baseUrl: "github.example.com" })
 * ```
 *
 * The auth provider receives the same value, so the configure flow skips the
 * host prompt and authenticates against the pinned host (`gh auth token
 * --hostname`, enterprise token env vars). Individual resources can still
 * override the host per-resource via their own `baseUrl` prop.
 */
export const providers = (options?: ProvidersOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([
      BranchProtection,
      Collaborator,
      Comment,
      Environment,
      Label,
      Milestone,
      Issue,
      PullRequest,
      Release,
      Repository,
      Ruleset,
      Secret,
      TeamAccess,
      Variable,
      Webhook,
      WikiPage,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BranchProtectionProvider(),
        CollaboratorProvider(),
        CommentProvider(),
        EnvironmentProvider(),
        LabelProvider(),
        MilestoneProvider(),
        IssueProvider(),
        PullRequestProvider(),
        ReleaseProvider(),
        RepositoryProvider(),
        RulesetProvider(),
        SecretProvider(),
        TeamAccessProvider(),
        VariableProvider(),
        WebhookProvider(),
        WikiPageProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider(options)),
    Layer.provideMerge(makeGitHubAuth(options)),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
