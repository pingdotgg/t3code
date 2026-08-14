import { insertRankedSearchResult, scoreQueryMatch } from "./searchRanking.ts";

export interface TaskReferenceSearchItem {
  readonly id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly updatedAt: string;
}

interface IndexedTask<T extends TaskReferenceSearchItem> {
  readonly item: T;
  readonly title: string;
  readonly branch: string;
  readonly id: string;
  readonly terms: ReadonlyMap<string, number>;
  readonly length: number;
  readonly updatedAt: number;
}

export interface TaskReferenceSearchIndex<T extends TaskReferenceSearchItem> {
  readonly documents: ReadonlyArray<IndexedTask<T>>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageDocumentLength: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const TITLE_WEIGHT = 4;
const BRANCH_WEIGHT = 2;
const ID_WEIGHT = 1;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DEFAULT_LIMIT = 8;

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value).match(TOKEN_PATTERN) ?? [];
}

function addWeightedTerms(
  target: Map<string, number>,
  terms: ReadonlyArray<string>,
  weight: number,
) {
  for (const term of terms) {
    target.set(term, (target.get(term) ?? 0) + weight);
  }
}

export function buildTaskReferenceSearchIndex<T extends TaskReferenceSearchItem>(
  items: ReadonlyArray<T>,
): TaskReferenceSearchIndex<T> {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  const documents = items.map((item) => {
    const title = normalize(item.title);
    const branch = normalize(item.branch ?? "");
    const id = normalize(item.id);
    const terms = new Map<string, number>();
    addWeightedTerms(terms, tokenize(title), TITLE_WEIGHT);
    addWeightedTerms(terms, tokenize(branch), BRANCH_WEIGHT);
    addWeightedTerms(terms, tokenize(id), ID_WEIGHT);
    const length = [...terms.values()].reduce((total, frequency) => total + frequency, 0);
    totalLength += length;
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    return {
      item,
      title,
      branch,
      id,
      terms,
      length,
      updatedAt: Date.parse(item.updatedAt) || 0,
    };
  });

  return {
    documents,
    documentFrequency,
    averageDocumentLength: documents.length === 0 ? 1 : Math.max(1, totalLength / documents.length),
  };
}

function bm25TermScore<T extends TaskReferenceSearchItem>(
  index: TaskReferenceSearchIndex<T>,
  document: IndexedTask<T>,
  term: string,
): number {
  const frequency = document.terms.get(term) ?? 0;
  if (frequency === 0) return 0;
  const documentCount = index.documents.length;
  const matchingDocuments = index.documentFrequency.get(term) ?? 0;
  const inverseDocumentFrequency = Math.log(
    1 + (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5),
  );
  const lengthNormalization =
    BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageDocumentLength));
  return (
    inverseDocumentFrequency * ((frequency * (BM25_K1 + 1)) / (frequency + lengthNormalization))
  );
}

function fuzzyFieldScore(value: string, query: string, weight: number): number {
  const rank = scoreQueryMatch({
    value,
    query,
    exactBase: 0,
    prefixBase: 8,
    boundaryBase: 18,
    includesBase: 30,
    fuzzyBase: 80,
  });
  return rank === null ? 0 : weight / (1 + rank);
}

function scoreDocument<T extends TaskReferenceSearchItem>(
  index: TaskReferenceSearchIndex<T>,
  document: IndexedTask<T>,
  query: string,
  queryTerms: ReadonlyArray<string>,
): number | null {
  let score = 0;
  let matchedTerms = 0;
  for (const term of queryTerms) {
    const exact = bm25TermScore(index, document, term);
    let best = exact;
    if (best === 0) {
      for (const documentTerm of document.terms.keys()) {
        if (documentTerm.startsWith(term)) {
          const prefixDocumentFrequency = index.documentFrequency.get(documentTerm) ?? 1;
          const idf = Math.log(1 + index.documents.length / prefixDocumentFrequency);
          best = Math.max(best, idf * (0.6 + 0.4 * (term.length / documentTerm.length)));
        }
      }
    }
    if (best > 0) matchedTerms += 1;
    score += best;
  }

  score += fuzzyFieldScore(document.title, query, 24);
  score += fuzzyFieldScore(document.branch, query, 8);
  score += fuzzyFieldScore(document.id, query, 4);
  if (score === 0) return null;

  // Multi-word searches should strongly prefer tasks matching every term.
  score *= 0.35 + 0.65 * (matchedTerms / queryTerms.length);
  return score;
}

export function searchTaskReferences<T extends TaskReferenceSearchItem>(
  index: TaskReferenceSearchIndex<T>,
  queryInput: string,
  limit = DEFAULT_LIMIT,
): T[] {
  const query = normalize(queryInput.trim().replace(/^@+/, ""));
  const ranked: Array<{ item: T; score: number; tieBreaker: string }> = [];

  if (!query) {
    for (const document of index.documents) {
      insertRankedSearchResult(
        ranked,
        {
          item: document.item,
          score: -document.updatedAt,
          tieBreaker: `${document.title}\u0000${document.id}`,
        },
        limit,
      );
    }
    return ranked.map(({ item }) => item);
  }

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];
  for (const document of index.documents) {
    const relevance = scoreDocument(index, document, query, queryTerms);
    if (relevance === null) continue;
    insertRankedSearchResult(
      ranked,
      {
        item: document.item,
        score: -relevance,
        tieBreaker: `${document.title}\u0000${document.id}`,
      },
      limit,
    );
  }
  return ranked.map(({ item }) => item);
}
