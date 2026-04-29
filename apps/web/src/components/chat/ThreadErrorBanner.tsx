import { memo } from "react";
import { ErrorAlert } from "~/components/ui/error-alert";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <ErrorAlert message={error} {...(onDismiss ? { onDismiss } : {})} />
    </div>
  );
});
