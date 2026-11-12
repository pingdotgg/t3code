import type { LucideIcon, LucideProps } from "lucide-react";
export function ReviewIcon({ icon: Icon, ...props }: LucideProps & { readonly icon: LucideIcon }) {
  return <Icon {...props} />;
}
