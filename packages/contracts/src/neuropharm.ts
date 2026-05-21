import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const QUERY_MAX_LENGTH = 512;
const DOCUMENT_CONTENT_MAX_LENGTH = 500_000;
const EVIDENCE_SNIPPET_MAX_LENGTH = 8_000;

export const NeuropharmSourceKind = Schema.Literals([
  "chembl",
  "pubchem",
  "iuphar",
  "pubmed",
  "url",
  "csv",
  "local",
  "user_pdf",
  "user_note",
]);
export type NeuropharmSourceKind = typeof NeuropharmSourceKind.Type;

export const NeuropharmDomain = Schema.Literals([
  "receptors",
  "cognitive_enhancement",
  "compound_profile",
  "pk_pd",
  "interactions",
  "literature_review",
  "latex_report",
  "diagramming",
  "stack_checker",
]);
export type NeuropharmDomain = typeof NeuropharmDomain.Type;

export const NeuropharmAnalysisMode = Schema.Literals([
  "compound_profile",
  "receptor_explorer",
  "stack_checker",
]);
export type NeuropharmAnalysisMode = typeof NeuropharmAnalysisMode.Type;

export const NeuropharmGraphKind = Schema.Literals([
  "dose_response",
  "receptor_selectivity_radar",
  "pk_timeline",
  "interaction_risk_heatmap",
  "effect_size_forest",
  "inverted_u_curve",
  "task_domain_matrix",
  "molecule_property_card",
  "target_network",
  "similarity_map",
  "admet_radar",
]);
export type NeuropharmGraphKind = typeof NeuropharmGraphKind.Type;

export const NeuropharmConfidence = Schema.Literals(["low", "moderate", "high"]);
export type NeuropharmConfidence = typeof NeuropharmConfidence.Type;

export const NeuropharmEvidenceGrade = Schema.Literals(["measured", "inferred", "speculative"]);
export type NeuropharmEvidenceGrade = typeof NeuropharmEvidenceGrade.Type;

export const NeuropharmDatabaseSource = Schema.Literals([
  "pubchem",
  "chembl",
  "iuphar",
  "pubmed",
  "bindingdb",
]);
export type NeuropharmDatabaseSource = typeof NeuropharmDatabaseSource.Type;

export const NeuropharmSyncStatus = Schema.Literals(["idle", "running", "succeeded", "failed"]);
export type NeuropharmSyncStatus = typeof NeuropharmSyncStatus.Type;

export const NeuropharmLocalDatabaseSource = Schema.Literals([
  "iuphar",
  "iuphar_ligands",
  "iuphar_targets",
  "iuphar_physchem",
  "bindingdb",
  "bindingdb_chembl",
  "bindingdb_patents",
  "bindingdb_pubchem",
  "bindingdb_articles",
  "bindingdb_assays",
  "bindingdb_pdsp",
  "bindingdb_rsid",
]);
export type NeuropharmLocalDatabaseSource = typeof NeuropharmLocalDatabaseSource.Type;

export const NeuropharmLocalDatabaseStatus = Schema.Literals([
  "not_downloaded",
  "downloading",
  "downloaded",
  "importing",
  "imported",
  "failed",
]);
export type NeuropharmLocalDatabaseStatus = typeof NeuropharmLocalDatabaseStatus.Type;

export const NeuropharmSourceRecord = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  source: NeuropharmSourceKind,
  title: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
  citation: Schema.optional(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
  tags: Schema.Array(TrimmedNonEmptyString),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(EVIDENCE_SNIPPET_MAX_LENGTH))),
});
export type NeuropharmSourceRecord = typeof NeuropharmSourceRecord.Type;

export const NeuropharmEvidenceRecord = Schema.Struct({
  evidenceId: TrimmedNonEmptyString,
  sourceId: TrimmedNonEmptyString,
  source: NeuropharmSourceKind,
  title: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
  citation: Schema.optional(TrimmedNonEmptyString),
  snippet: Schema.String.check(Schema.isMaxLength(EVIDENCE_SNIPPET_MAX_LENGTH)),
  tags: Schema.Array(TrimmedNonEmptyString),
  importedAt: IsoDateTime,
});
export type NeuropharmEvidenceRecord = typeof NeuropharmEvidenceRecord.Type;

export const NeuropharmEstimateResult = Schema.Struct({
  query: TrimmedNonEmptyString,
  summary: Schema.String,
  confidence: NeuropharmConfidence,
  assumptions: Schema.Array(TrimmedNonEmptyString),
  riskFlags: Schema.Array(TrimmedNonEmptyString),
  evidence: Schema.Array(NeuropharmEvidenceRecord),
});
export type NeuropharmEstimateResult = typeof NeuropharmEstimateResult.Type;

export const NeuropharmGraphDatum = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: Schema.Number,
  group: Schema.optional(TrimmedNonEmptyString),
  unit: Schema.optional(TrimmedNonEmptyString),
});
export type NeuropharmGraphDatum = typeof NeuropharmGraphDatum.Type;

export const NeuropharmGraphSpec = Schema.Struct({
  kind: NeuropharmGraphKind,
  title: TrimmedNonEmptyString,
  xLabel: Schema.optional(TrimmedNonEmptyString),
  yLabel: Schema.optional(TrimmedNonEmptyString),
  data: Schema.Array(NeuropharmGraphDatum),
  notes: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmGraphSpec = typeof NeuropharmGraphSpec.Type;

export const NeuropharmLatexArtifact = Schema.Struct({
  title: TrimmedNonEmptyString,
  latex: Schema.String,
  citations: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmLatexArtifact = typeof NeuropharmLatexArtifact.Type;

export const NeuropharmGraphNodeKind = Schema.Literals([
  "compound",
  "target",
  "pathway",
  "study",
  "claim",
  "risk",
  "report",
  "stack",
]);
export type NeuropharmGraphNodeKind = typeof NeuropharmGraphNodeKind.Type;

export const NeuropharmGraphNode = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  kind: NeuropharmGraphNodeKind,
  label: TrimmedNonEmptyString,
  confidence: NeuropharmConfidence,
  tags: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmGraphNode = typeof NeuropharmGraphNode.Type;

export const NeuropharmGraphEdge = Schema.Struct({
  edgeId: TrimmedNonEmptyString,
  fromNodeId: TrimmedNonEmptyString,
  toNodeId: TrimmedNonEmptyString,
  relation: TrimmedNonEmptyString,
  confidence: NeuropharmConfidence,
  evidenceIds: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmGraphEdge = typeof NeuropharmGraphEdge.Type;

export const NeuropharmDiagramArtifact = Schema.Struct({
  title: TrimmedNonEmptyString,
  format: Schema.Literals(["mermaid", "network_json"]),
  content: Schema.String,
  notes: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmDiagramArtifact = typeof NeuropharmDiagramArtifact.Type;

export const NeuropharmCompoundIdentity = Schema.Struct({
  compoundId: TrimmedNonEmptyString,
  preferredName: TrimmedNonEmptyString,
  synonyms: Schema.Array(TrimmedNonEmptyString),
  pubchemCid: Schema.optional(TrimmedNonEmptyString),
  chemblId: Schema.optional(TrimmedNonEmptyString),
  iupharLigandId: Schema.optional(TrimmedNonEmptyString),
  molecularFormula: Schema.optional(TrimmedNonEmptyString),
  canonicalSmiles: Schema.optional(TrimmedNonEmptyString),
  inchiKey: Schema.optional(TrimmedNonEmptyString),
  sourceIds: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmCompoundIdentity = typeof NeuropharmCompoundIdentity.Type;

export const NeuropharmTargetRecord = Schema.Struct({
  targetId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  family: Schema.optional(TrimmedNonEmptyString),
  organism: Schema.optional(TrimmedNonEmptyString),
  sourceIds: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmTargetRecord = typeof NeuropharmTargetRecord.Type;

export const NeuropharmInteractionRecord = Schema.Struct({
  interactionId: TrimmedNonEmptyString,
  compoundId: TrimmedNonEmptyString,
  targetId: TrimmedNonEmptyString,
  compoundName: TrimmedNonEmptyString,
  targetName: TrimmedNonEmptyString,
  source: NeuropharmDatabaseSource,
  evidenceGrade: NeuropharmEvidenceGrade,
  action: Schema.optional(TrimmedNonEmptyString),
  measurementType: Schema.optional(TrimmedNonEmptyString),
  value: Schema.optional(Schema.Number),
  relation: Schema.optional(TrimmedNonEmptyString),
  units: Schema.optional(TrimmedNonEmptyString),
  assayContext: Schema.optional(
    Schema.String.check(Schema.isMaxLength(EVIDENCE_SNIPPET_MAX_LENGTH)),
  ),
  publicationIds: Schema.Array(TrimmedNonEmptyString),
  sourceIds: Schema.Array(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type NeuropharmInteractionRecord = typeof NeuropharmInteractionRecord.Type;

export const NeuropharmPublicationRecord = Schema.Struct({
  publicationId: TrimmedNonEmptyString,
  source: Schema.Literal("pubmed"),
  title: TrimmedNonEmptyString,
  abstract: Schema.optional(Schema.String.check(Schema.isMaxLength(EVIDENCE_SNIPPET_MAX_LENGTH))),
  journal: Schema.optional(TrimmedNonEmptyString),
  year: Schema.optional(Schema.Int),
  url: Schema.optional(TrimmedNonEmptyString),
  sourceIds: Schema.Array(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type NeuropharmPublicationRecord = typeof NeuropharmPublicationRecord.Type;

export const NeuropharmDatabaseSourceStatus = Schema.Struct({
  source: NeuropharmDatabaseSource,
  status: NeuropharmSyncStatus,
  records: Schema.Int,
  fetchedAt: Schema.optional(IsoDateTime),
  error: Schema.optional(Schema.String),
});
export type NeuropharmDatabaseSourceStatus = typeof NeuropharmDatabaseSourceStatus.Type;

export const NeuropharmDatabaseSyncInput = Schema.Struct({
  compounds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  sources: Schema.optional(Schema.Array(NeuropharmDatabaseSource)),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type NeuropharmDatabaseSyncInput = typeof NeuropharmDatabaseSyncInput.Type;

export const NeuropharmDatabaseSyncResult = Schema.Struct({
  syncId: TrimmedNonEmptyString,
  status: NeuropharmSyncStatus,
  compounds: Schema.Array(NeuropharmCompoundIdentity),
  targets: Schema.Array(NeuropharmTargetRecord),
  interactions: Schema.Array(NeuropharmInteractionRecord),
  publications: Schema.Array(NeuropharmPublicationRecord),
  sourceStatus: Schema.Array(NeuropharmDatabaseSourceStatus),
});
export type NeuropharmDatabaseSyncResult = typeof NeuropharmDatabaseSyncResult.Type;

export const NeuropharmLocalDatabaseManifestEntry = Schema.Struct({
  source: NeuropharmLocalDatabaseSource,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  downloadUrl: TrimmedNonEmptyString,
  fileName: TrimmedNonEmptyString,
  estimatedSizeBytes: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  importMode: Schema.Literals(["tsv", "zip_archive"]),
  priority: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
});
export type NeuropharmLocalDatabaseManifestEntry = typeof NeuropharmLocalDatabaseManifestEntry.Type;

export const NeuropharmLocalDatabaseSnapshot = Schema.Struct({
  source: NeuropharmLocalDatabaseSource,
  status: NeuropharmLocalDatabaseStatus,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  downloadUrl: TrimmedNonEmptyString,
  filePath: Schema.optional(TrimmedNonEmptyString),
  fileName: TrimmedNonEmptyString,
  version: Schema.optional(TrimmedNonEmptyString),
  downloadedAt: Schema.optional(IsoDateTime),
  importedAt: Schema.optional(IsoDateTime),
  bytes: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checksumSha256: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(Schema.String),
});
export type NeuropharmLocalDatabaseSnapshot = typeof NeuropharmLocalDatabaseSnapshot.Type;

export const NeuropharmLocalDatabaseStatusInput = Schema.Struct({});
export type NeuropharmLocalDatabaseStatusInput = typeof NeuropharmLocalDatabaseStatusInput.Type;

export const NeuropharmLocalDatabaseStatusResult = Schema.Struct({
  baseDirectory: TrimmedNonEmptyString,
  manifest: Schema.Array(NeuropharmLocalDatabaseManifestEntry),
  snapshots: Schema.Array(NeuropharmLocalDatabaseSnapshot),
  totalBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type NeuropharmLocalDatabaseStatusResult = typeof NeuropharmLocalDatabaseStatusResult.Type;

export const NeuropharmLocalDatabaseDownloadInput = Schema.Struct({
  sources: Schema.optional(Schema.Array(NeuropharmLocalDatabaseSource)),
  forceRefresh: Schema.optional(Schema.Boolean),
  importAfterDownload: Schema.optional(Schema.Boolean),
});
export type NeuropharmLocalDatabaseDownloadInput = typeof NeuropharmLocalDatabaseDownloadInput.Type;

export const NeuropharmLocalDatabaseDownloadResult = Schema.Struct({
  downloadId: TrimmedNonEmptyString,
  status: NeuropharmSyncStatus,
  baseDirectory: TrimmedNonEmptyString,
  snapshots: Schema.Array(NeuropharmLocalDatabaseSnapshot),
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmLocalDatabaseDownloadResult =
  typeof NeuropharmLocalDatabaseDownloadResult.Type;

export const NeuropharmLocalSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  sources: Schema.optional(Schema.Array(NeuropharmLocalDatabaseSource)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type NeuropharmLocalSearchInput = typeof NeuropharmLocalSearchInput.Type;

export const NeuropharmLocalSearchResult = Schema.Struct({
  query: TrimmedNonEmptyString,
  compounds: Schema.Array(NeuropharmCompoundIdentity),
  targets: Schema.Array(NeuropharmTargetRecord),
  interactions: Schema.Array(NeuropharmInteractionRecord),
  snapshots: Schema.Array(NeuropharmLocalDatabaseSnapshot),
});
export type NeuropharmLocalSearchResult = typeof NeuropharmLocalSearchResult.Type;

export const NeuropharmCompoundLookupInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  includeInteractions: Schema.optional(Schema.Boolean),
  includePublications: Schema.optional(Schema.Boolean),
});
export type NeuropharmCompoundLookupInput = typeof NeuropharmCompoundLookupInput.Type;

export const NeuropharmCompoundLookupResult = Schema.Struct({
  compound: Schema.optional(NeuropharmCompoundIdentity),
  targets: Schema.Array(NeuropharmTargetRecord),
  interactions: Schema.Array(NeuropharmInteractionRecord),
  publications: Schema.Array(NeuropharmPublicationRecord),
  sourceStatus: Schema.Array(NeuropharmDatabaseSourceStatus),
});
export type NeuropharmCompoundLookupResult = typeof NeuropharmCompoundLookupResult.Type;

export const NeuropharmCompoundComparisonInput = Schema.Struct({
  compounds: Schema.Array(TrimmedNonEmptyString),
  focus: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  includeSpeculative: Schema.optional(Schema.Boolean),
});
export type NeuropharmCompoundComparisonInput = typeof NeuropharmCompoundComparisonInput.Type;

export const NeuropharmCompoundComparisonResult = Schema.Struct({
  comparisonId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  compounds: Schema.Array(NeuropharmCompoundIdentity),
  targets: Schema.Array(NeuropharmTargetRecord),
  interactions: Schema.Array(NeuropharmInteractionRecord),
  publications: Schema.Array(NeuropharmPublicationRecord),
  graphSpecs: Schema.Array(NeuropharmGraphSpec),
  evidenceSummary: Schema.Array(TrimmedNonEmptyString),
  safetyNotices: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmCompoundComparisonResult = typeof NeuropharmCompoundComparisonResult.Type;

export const NeuropharmAnalysisInput = Schema.Struct({
  mode: NeuropharmAnalysisMode,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  compounds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  targets: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  includeLatex: Schema.optional(Schema.Boolean),
  includeDiagrams: Schema.optional(Schema.Boolean),
  powerUser: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type NeuropharmAnalysisInput = typeof NeuropharmAnalysisInput.Type;

export const NeuropharmAnalysisResult = Schema.Struct({
  analysisId: TrimmedNonEmptyString,
  mode: NeuropharmAnalysisMode,
  title: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  estimate: NeuropharmEstimateResult,
  graphSpecs: Schema.Array(NeuropharmGraphSpec),
  graphNodes: Schema.Array(NeuropharmGraphNode),
  graphEdges: Schema.Array(NeuropharmGraphEdge),
  diagrams: Schema.Array(NeuropharmDiagramArtifact),
  latex: Schema.optional(NeuropharmLatexArtifact),
  powerUserNotes: Schema.Array(TrimmedNonEmptyString),
  safetyNotices: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmAnalysisResult = typeof NeuropharmAnalysisResult.Type;

export const NeuropharmSearchSourcesInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  domains: Schema.optional(Schema.Array(NeuropharmDomain)),
  sources: Schema.optional(Schema.Array(NeuropharmSourceKind)),
});
export type NeuropharmSearchSourcesInput = typeof NeuropharmSearchSourcesInput.Type;

export const NeuropharmSearchSourcesResult = Schema.Struct({
  records: Schema.Array(NeuropharmSourceRecord),
});
export type NeuropharmSearchSourcesResult = typeof NeuropharmSearchSourcesResult.Type;

export const NeuropharmImportDocumentInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  source: NeuropharmSourceKind,
  content: Schema.String.check(Schema.isMaxLength(DOCUMENT_CONTENT_MAX_LENGTH)),
  url: Schema.optional(TrimmedNonEmptyString),
  citation: Schema.optional(TrimmedNonEmptyString),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type NeuropharmImportDocumentInput = typeof NeuropharmImportDocumentInput.Type;

export const NeuropharmBasicsPackInput = Schema.Struct({
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type NeuropharmBasicsPackInput = typeof NeuropharmBasicsPackInput.Type;

export const NeuropharmBasicsPackResult = Schema.Struct({
  packId: TrimmedNonEmptyString,
  imported: Schema.Array(NeuropharmEvidenceRecord),
  topics: Schema.Array(TrimmedNonEmptyString),
});
export type NeuropharmBasicsPackResult = typeof NeuropharmBasicsPackResult.Type;

export const NeuropharmSearchLibraryInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type NeuropharmSearchLibraryInput = typeof NeuropharmSearchLibraryInput.Type;

export const NeuropharmEvidencePackInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type NeuropharmEvidencePackInput = typeof NeuropharmEvidencePackInput.Type;

export const NeuropharmEvidencePackResult = Schema.Struct({
  estimate: NeuropharmEstimateResult,
});
export type NeuropharmEvidencePackResult = typeof NeuropharmEvidencePackResult.Type;

export const NeuropharmGenerateGraphSpecInput = Schema.Struct({
  kind: NeuropharmGraphKind,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(QUERY_MAX_LENGTH))),
});
export type NeuropharmGenerateGraphSpecInput = typeof NeuropharmGenerateGraphSpecInput.Type;

export class NeuropharmError extends Schema.TaggedErrorClass<NeuropharmError>()("NeuropharmError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
