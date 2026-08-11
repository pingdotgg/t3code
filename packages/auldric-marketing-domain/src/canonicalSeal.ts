// @effect-diagnostics nodeBuiltinImport:off - the seal is a local SQLite integrity digest.
import * as NodeCrypto from "node:crypto";

export interface CanonicalSealReference {
  readonly referenceKind: string;
  readonly ordinal: number;
  readonly targetObjectId: string;
  readonly targetRevisionId: string;
  readonly targetVersion: number;
}

export interface CanonicalSealFact {
  readonly factKey: string;
  readonly valueJson: string;
  readonly valueSha256: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Seals exactly the normalized revision children approved by the write transaction. Sorting here
 * keeps migration and live writes independent from a query planner's row order.
 */
export function canonicalRevisionChildrenSha256(
  references: ReadonlyArray<CanonicalSealReference>,
  facts: ReadonlyArray<CanonicalSealFact>,
): string {
  const normalizedReferences = [...references]
    .sort(
      (left, right) =>
        compareText(left.referenceKind, right.referenceKind) ||
        left.ordinal - right.ordinal ||
        compareText(left.targetObjectId, right.targetObjectId) ||
        compareText(left.targetRevisionId, right.targetRevisionId) ||
        left.targetVersion - right.targetVersion,
    )
    .map((reference) => ({
      referenceKind: reference.referenceKind,
      ordinal: reference.ordinal,
      targetObjectId: reference.targetObjectId,
      targetRevisionId: reference.targetRevisionId,
      targetVersion: reference.targetVersion,
    }));
  const normalizedFacts = [...facts]
    .sort(
      (left, right) =>
        compareText(left.factKey, right.factKey) ||
        compareText(left.valueSha256, right.valueSha256) ||
        compareText(left.valueJson, right.valueJson),
    )
    .map((fact) => ({
      factKey: fact.factKey,
      valueJson: fact.valueJson,
      valueSha256: fact.valueSha256,
    }));
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        format: "auldric-canonical-revision-children-v1",
        references: normalizedReferences,
        facts: normalizedFacts,
      }),
    )
    .digest("hex");
}
