export interface CardProps {
  title: string;
  body: string;
}

export function Card({ title, body }: CardProps) {
  return (
    <div className="mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-slate-600">{body}</p>
    </div>
  );
}
