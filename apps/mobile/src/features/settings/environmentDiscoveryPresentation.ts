export function environmentDiscoveryPresentation(input: {
  readonly hasRows: boolean;
  readonly isRefreshing: boolean;
  readonly error: string | null;
}) {
  return {
    showRows: input.hasRows,
    showLoading: !input.hasRows && input.isRefreshing,
    showError: input.error !== null,
    showEmpty: !input.hasRows && !input.isRefreshing && input.error === null,
  };
}
