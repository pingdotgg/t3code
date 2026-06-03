import {
  ActivityIcon,
  BrainIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  NetworkIcon,
  ShieldCheckIcon,
  SigmaIcon,
} from "lucide-react";

const items = [
  {
    icon: FlaskConicalIcon,
    label: "Compound profiles",
    text: "Analyze receptor binding, pharmacokinetics, drug interactions, and mechanism of action. Generates graphs and confidence-rated summaries.",
  },
  {
    icon: NetworkIcon,
    label: "Receptor atlas",
    text: "Explore neurotransmitter receptors, transporters, and signaling pathways. Maps connections to cognitive functions.",
  },
  {
    icon: ShieldCheckIcon,
    label: "Interaction checker",
    text: "Identifies drug-drug interactions, metabolic conflicts, and safety concerns when combining compounds.",
  },
  {
    icon: BrainIcon,
    label: "Cognitive effects",
    text: "Evaluates impact on attention, memory, and executive function. Includes dose-response curves and tolerance patterns.",
  },
  {
    icon: ActivityIcon,
    label: "Pharmacokinetics",
    text: "Estimates onset time, peak concentration, half-life, and active metabolites based on published data.",
  },
  {
    icon: DatabaseIcon,
    label: "Evidence database",
    text: "Integrates data from PubMed, PubChem, ChEMBL, and IUPHAR. Tracks sources and confidence for all claims.",
  },
  {
    icon: SigmaIcon,
    label: "Visualizations",
    text: "Generates receptor selectivity radars, dose-response curves, interaction heatmaps, and pharmacokinetic timelines.",
  },
  {
    icon: FileTextIcon,
    label: "Export reports",
    text: "Creates formatted research documents with citations, figures, and confidence ratings. Exports to LaTeX.",
  },
];

export function NeuropharmWorkspacePanel() {
  return (
    <div className="grid gap-3 text-left sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border border-border/70 bg-background/80 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <item.icon className="size-4 text-emerald-600" />
            {item.label}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{item.text}</p>
        </div>
      ))}
    </div>
  );
}
