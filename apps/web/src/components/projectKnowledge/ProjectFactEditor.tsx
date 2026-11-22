import { useId, useState } from "react";
import { T, useGT, useMessages } from "gt-react";
import { KNOWLEDGE_FACT_KIND_LABEL } from "@t3tools/client-runtime/projectKnowledge";
import {
  CommandId,
  ProjectFactId,
  type KnowledgeFactSource,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeMutation,
} from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const FACT_KINDS = ["decision", "constraint", "convention", "note"] as const;
type FactKind = (typeof FACT_KINDS)[number];
export type EditableFact = Extract<ProjectFact, { content: string }>;

/** What the editor starts from: a new fact (optionally cited) or an existing revision. */
export type FactEditorSeed =
  | {
      readonly mode: "create";
      readonly content: string;
      readonly sources: ReadonlyArray<KnowledgeFactSource>;
    }
  | { readonly mode: "edit" | "supersede"; readonly base: EditableFact };

const labels = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  ),
];

// The editor owns its unsaved fields; the base revision is captured when editing starts so a
// concurrent change is rejected by the server instead of being overwritten.
export function ProjectFactEditor(props: {
  readonly projectId: ProjectId;
  readonly seed: FactEditorSeed;
  readonly historyAvailable: boolean;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onSubmit: (input: ProjectKnowledgeMutation) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { seed } = props;
  const base = seed.mode === "create" ? null : seed.base;
  const [superseding, setSuperseding] = useState(seed.mode === "supersede");
  const [content, setContent] = useState(
    base?.content ?? (seed.mode === "create" ? seed.content : ""),
  );
  const [entities, setEntities] = useState(base?.entities.join(", ") ?? "");
  const [tags, setTags] = useState(base?.tags.join(", ") ?? "");
  const [kind, setKind] = useState<FactKind>(base?.kind ?? "note");
  const kindLabelId = useId();
  const sources: ReadonlyArray<KnowledgeFactSource> = base
    ? base.sources.length
      ? base.sources
      : [{ kind: "user" }]
    : seed.mode === "create" && seed.sources.length
      ? seed.sources
      : [{ kind: "user" }];
  const title = base ? (superseding ? gt("Supersede fact") : gt("Edit fact")) : gt("Save a fact");
  return (
    <form
      aria-label={title}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = {
          commandId: CommandId.make(randomUUID()),
          projectId: props.projectId,
          content,
          entities: labels(entities),
          tags: labels(tags),
          kind,
          sources,
        };
        props.onSubmit(
          base
            ? {
                ...fields,
                factId: base.id,
                expectedRevision: base.revision,
                ...(superseding
                  ? {
                      action: "supersede" as const,
                      replacementFactId: ProjectFactId.make(randomUUID()),
                    }
                  : { action: "edit" as const }),
              }
            : { ...fields, action: "create", factId: ProjectFactId.make(randomUUID()) },
        );
      }}
    >
      <h3 className="font-medium text-sm">{title}</h3>
      {base && superseding ? (
        <p className="text-muted-foreground text-sm">
          <T>The original stays readable but is no longer recalled once replaced.</T>
        </p>
      ) : null}
      <Textarea
        aria-label={gt("Fact content")}
        autoFocus
        value={content}
        maxLength={12000}
        onChange={(event) => setContent(event.target.value)}
        required
      />
      <Input
        aria-label={gt("Entities, comma separated")}
        placeholder={gt("Entities, comma separated")}
        value={entities}
        onChange={(event) => setEntities(event.target.value)}
      />
      <Input
        aria-label={gt("Tags, comma separated")}
        placeholder={gt("Tags, comma separated")}
        value={tags}
        onChange={(event) => setTags(event.target.value)}
      />
      <div className="flex items-center gap-2 text-sm">
        <span id={kindLabelId}>
          <T context="project fact kind">Kind</T>
        </span>
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value !== null) setKind(value);
          }}
        >
          <SelectTrigger size="sm" aria-labelledby={kindLabelId} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {FACT_KINDS.map((value) => (
              <SelectItem hideIndicator key={value} value={value}>
                {m(KNOWLEDGE_FACT_KIND_LABEL[value])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-muted-foreground text-sm">
        {sources.some((ref) => ref.kind === "message")
          ? gt("Saved with the selected message citation.")
          : gt("Saved as your assertion.")}
      </p>
      {!props.canMutate ? (
        <p className="text-sm">
          <T>This environment grants read access only.</T>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!props.canMutate || props.busy || content.trim() === ""}
          size="sm"
          type="submit"
        >
          {base ? (superseding ? gt("Save replacement") : gt("Save edit")) : gt("Save fact")}
        </Button>
        {base && props.historyAvailable ? (
          <Button size="sm" variant="ghost" onClick={() => setSuperseding((value) => !value)}>
            {superseding ? gt("Edit instead") : gt("Supersede instead")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}
