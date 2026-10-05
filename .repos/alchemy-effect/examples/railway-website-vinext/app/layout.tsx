import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "vinext on Railway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 p-8 text-slate-900">
        <nav className="mb-6 flex gap-4">
          <Link href="/">Home</Link>
          <Link href="/isr">ISR</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
