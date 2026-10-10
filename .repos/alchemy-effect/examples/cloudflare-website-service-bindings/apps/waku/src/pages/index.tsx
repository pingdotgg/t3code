export default function Page() {
  return <h1>Waku service binding</h1>;
}
export const getConfig = async () => ({ render: "dynamic" }) as const;
