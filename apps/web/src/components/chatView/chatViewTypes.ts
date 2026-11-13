import type { UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { type EnvironmentId, type ServerProvider, type ThreadId } from "@t3tools/contracts";
import { type CodexFeedbackSubmission } from "@t3tools/client-runtime/state/threads";
import { type SideChatParentPanel } from "~/lib/sideChatPane";
import { DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation } from "../../state/environments";
import { type ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";

export const EMPTY_PROVIDERS: ServerProvider[] = [];
export const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
export const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
export const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
export const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
export const EMPTY_TURN_ITEMS: ThreadStructure["turnItems"] = [];
export const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];
export const EMPTY_COMPOSER_BANNER_ITEMS: ReadonlyArray<ComposerBannerStackItem> = [];

export const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

export type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      /** A side chat in its parent's right panel; the parent keeps the keyboard and workspace UI. */
      embedded?: SideChatParentPanel;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      embedded?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

export const DismissedFallbackWindowSchema = Schema.NullOr(Schema.String);
