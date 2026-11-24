export function TeamPseudoPrefix({ pseudo }: { readonly pseudo: string | null }) {
  if (pseudo === null) return null;
  return (
    <span className="text-muted-foreground" data-team-pseudo={pseudo}>
      {pseudo}:{" "}
    </span>
  );
}
