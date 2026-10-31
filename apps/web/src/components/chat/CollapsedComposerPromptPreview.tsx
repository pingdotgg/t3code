import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import type { KnownComposerContextKind, ServerProviderSkill } from "@t3tools/contracts";
import { assistantCitationLabel } from "@t3tools/shared/assistantCitations";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { fileBasename } from "@t3tools/shared/path";
import {
  CircleDashedIcon,
  ImageIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MousePointerClickIcon,
  QuoteIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ContextChipShell } from "../contextChipParts";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { SkillChipIcon } from "./SkillInlineText";

type Theme = "light" | "dark";

// Draft records (PR state, upload progress) live with the editor, so the row shows each
// reference by its kind alone.
const CONTEXT_REFERENCE_ICONS: Record<
  KnownComposerContextKind,
  (label: string, theme: Theme) => ReactElement
> = {
  image: () => <ImageIcon />,
  file: (label, theme) => <PierreEntryIcon pathValue={label} kind="file" theme={theme} />,
  terminal: () => <TerminalIcon />,
  element: () => <MousePointerClickIcon />,
  "preview-annotation": () => <MousePointerClickIcon />,
  "review-comment": () => <MessageCircleIcon />,
  mention: (label, theme) => <PierreEntryIcon pathValue={label} kind="file" theme={theme} />,
  skill: () => <SkillChipIcon />,
  thread: () => <MessagesSquareIcon />,
  environment: () => <MonitorIcon />,
};

function isKnownContextKind(kind: string): kind is KnownComposerContextKind {
  return Object.hasOwn(CONTEXT_REFERENCE_ICONS, kind);
}

/**
 * The draft as the editor's chips, drawn inert: the collapsed row is a single button that
 * expands the composer, so these chips carry no popovers, links or focus stops.
 */
export function CollapsedComposerPromptPreview(props: {
  prompt: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  theme: Theme;
}) {
  let offset = 0;
  return splitPromptIntoComposerSegments(props.prompt).map((segment) => {
    const key = offset;
    offset += segment.type === "text" ? segment.text.length : segment.source.length;
    switch (segment.type) {
      case "text":
        return segment.text;
      case "citation":
        return (
          <ContextChip key={key} kind="citation">
            <QuoteIcon aria-hidden="true" />
            <ContextChipLabel className="max-w-[16em]">
              {assistantCitationLabel(segment.citation)}
            </ContextChipLabel>
          </ContextChip>
        );
      case "mention":
        return (
          <ContextChipShell
            key={key}
            kind="mention"
            icon={<PierreEntryIcon pathValue={segment.path} kind="file" theme={props.theme} />}
            label={fileBasename(segment.path)}
          />
        );
      case "context-reference":
        return isKnownContextKind(segment.kind) ? (
          <ContextChipShell
            key={key}
            kind={segment.kind}
            icon={CONTEXT_REFERENCE_ICONS[segment.kind](segment.label, props.theme)}
            label={segment.label}
          />
        ) : (
          <ContextChipShell
            key={key}
            state="unresolved"
            icon={<CircleDashedIcon />}
            label={segment.label}
          />
        );
      case "skill": {
        const skill = props.skills.find(
          (candidate) => candidate.name === segment.name && isProviderSkillUserInvocable(candidate),
        );
        return skill ? (
          <ContextChip key={key} kind="skill" data-markdown-copy={segment.source}>
            <SkillChipIcon />
            <ContextChipLabel>{formatProviderSkillDisplayName(skill)}</ContextChipLabel>
          </ContextChip>
        ) : (
          segment.source
        );
      }
    }
  });
}
