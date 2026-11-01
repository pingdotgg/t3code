import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "vinext on Cloudflare",
};

const pageLinks = [
  ["/", "Home"],
  ["/static", "Static"],
  ["/isr", "Cached"],
  ["/use-cache", "use cache"],
  ["/notes", "Notes"],
] as const;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 p-8 text-slate-900">
        <nav className="mb-8 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {pageLinks.map(([href, label]) => (
            <Link key={href} className="underline" href={href}>
              {label}
            </Link>
          ))}
        </nav>
        {children}
      </body>
    </html>
  );
}
