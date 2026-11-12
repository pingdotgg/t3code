import { Notice } from "./Notice";

export function ErrorBanner(props: { readonly message: string }) {
  return <Notice tone="danger" message={props.message} />;
}
