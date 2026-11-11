// A plain Solid component styled with Tailwind utility classes.
export default function Card(props: { title: string; body: string }) {
  return (
    <div class="mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold">{props.title}</h2>
      <p class="mt-2 text-slate-600">{props.body}</p>
    </div>
  );
}
