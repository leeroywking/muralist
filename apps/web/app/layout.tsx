import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Muralist",
  description: "Palette reduction and rough paint planning for muralists."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

