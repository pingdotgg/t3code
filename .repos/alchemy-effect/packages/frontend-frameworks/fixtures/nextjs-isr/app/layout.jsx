export const metadata = {
  title: "fixtures-nextjs-isr",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
