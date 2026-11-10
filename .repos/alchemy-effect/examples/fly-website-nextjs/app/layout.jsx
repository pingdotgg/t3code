import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 p-8 text-slate-900">{children}</body>
    </html>
  );
}
