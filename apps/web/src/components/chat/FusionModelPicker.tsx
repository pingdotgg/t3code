import { useId, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DevinIcon } from "../Icons";
import { composerFloatingLayerProps } from "./composerEventScope";
import { getFusionChoices } from "@t3tools/client-runtime/fusionModels";
import { FusionWave } from "./FusionWave";
import type { ModelEsque } from "./providerIconUtils";

export function FusionModelPicker(props: {
  models: ReadonlyArray<ModelEsque>;
  model: string;
  providerName: string;
  onBack: () => void;
  onSelect: (model: string) => void;
}) {
  const labelId = useId();
  const [selectedSlug, setSelectedSlug] = useState(props.model);
  const selected = props.models.find((model) => model.slug === selectedSlug);
  const pairing = selected?.fusion;
  const choices = selected ? getFusionChoices(props.models, selected) : { lead: [], sidekick: [] };

  return (
    <div className="w-128 max-w-[calc(100vw-2rem)] bg-popover" data-model-picker-content="true">
      <div className="grid min-h-36 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pl-4 sm:gap-4 sm:pl-5">
        <div className="space-y-3 py-5">
          <h2 className="text-xl font-semibold tracking-tight">Fusion</h2>
          <div className="flex max-w-24 items-center gap-1.5 text-xs text-muted-foreground">
            <DevinIcon className="size-3.5 shrink-0" />
            <span className="truncate">{props.providerName}</span>
          </div>
        </div>
        {pairing ? (
          <div className="relative grid min-h-36 min-w-0 grid-cols-2 items-center gap-1 pr-12 pl-1 sm:gap-4 sm:pr-14 sm:pl-3">
            <FusionWave animated />
            {(["lead", "sidekick"] as const).map((role) => (
              <div key={role} className="relative min-w-0 space-y-1">
                <Select
                  value={role === "lead" ? pairing.lead.id : selectedSlug}
                  onValueChange={(value) => {
                    if (!value) return;
                    const slug =
                      role === "lead"
                        ? choices.lead.find((model) => model.fusion?.lead.id === value)?.slug
                        : value;
                    if (slug) setSelectedSlug(slug);
                  }}
                >
                  <SelectTrigger
                    aria-labelledby={`${labelId}-${role}`}
                    variant="ghost"
                    className="w-full min-w-0 px-1.5 text-xs font-medium text-foreground sm:text-sm"
                  >
                    <SelectValue className="truncate">{pairing[role].name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup {...composerFloatingLayerProps} data-model-picker-content="true">
                    {choices[role].map((choice) => (
                      <SelectItem
                        key={choice.slug}
                        value={role === "lead" ? choice.fusion?.lead.id : choice.slug}
                      >
                        {choice.fusion?.[role].name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span
                  id={`${labelId}-${role}`}
                  className="block px-2 text-xs text-muted-foreground"
                >
                  {role === "lead" ? "Lead" : "Sidekick"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            This pairing is no longer available. Go back to choose another model.
          </p>
        )}
      </div>
      <footer className="flex items-center justify-between border-t border-border/70 px-3 py-2.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={props.onBack}
          aria-label="Back to models"
          autoFocus
        >
          <ArrowLeftIcon className="size-3.5" />
          Models
        </Button>
        <Button
          size="sm"
          disabled={!selected}
          onClick={() => {
            if (selected) props.onSelect(selected.slug);
          }}
        >
          Use Fusion
        </Button>
      </footer>
    </div>
  );
}
