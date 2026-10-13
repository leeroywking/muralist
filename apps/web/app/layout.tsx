import type { Metadata } from "next";
import Link from "next/link";
import { HeaderSessionLink } from "./HeaderSessionLink";
import { ThemeToggle } from "./ThemeToggle";
import { themeInitScript } from "./themeScript";
import "./styles.css";

export const metadata: Metadata = {
  title: "Muraliste",
  description: "Palette reduction and rough paint planning for muralists."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // themeInitScript sets data-theme before hydration, so the client <html>
    // intentionally differs from the server markup.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <header className="site-header">
          <Link className="brand-link" href="/">
            Muraliste
          </Link>
          <nav className="site-nav">
            <Link href="/">App</Link>
            <Link href="/about">About</Link>
            <HeaderSessionLink />
            <ThemeToggle />
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
