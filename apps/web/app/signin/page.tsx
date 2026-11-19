import Link from "next/link";
import { SignInButtons } from "../SignInButtons";

export const metadata = {
  title: "Sign in – Muraliste",
  description: "Sign in to Muraliste to save palettes and access your projects."
};

// Server Component shell. All interactive bits live in `SignInButtons` so the
// page stays compatible with the static `output: "export"` target configured in
// next.config.mjs.
export default function SignInPage() {
  return (
    <main className="page-shell">
      <section className="panel signin-container">
        <div className="section-head">
          <h1>Sign in to Muraliste</h1>
          <p>
            Sign in to save your mural projects, palettes, and brand settings
            across devices. Guest mode still works on the home page if you'd
            rather not create an account.
          </p>
        </div>
        <SignInButtons />
        <p className="signin-legal">
          By signing in you agree to the <Link href="/terms">Terms of Service</Link> and{" "}
          <Link href="/privacy">Privacy Policy</Link>. Saved projects store a reduced copy of your image and a
          thumbnail; analysis itself runs in your browser.
        </p>
      </section>
    </main>
  );
}
