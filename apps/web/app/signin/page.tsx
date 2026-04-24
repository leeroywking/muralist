import { SignInButtons } from "../SignInButtons";

export const metadata = {
  title: "Sign in – Muralist",
  description: "Sign in to Muralist to save palettes and access your projects."
};

// Server Component shell. All interactive bits live in `SignInButtons` so the
// page stays compatible with the static `output: "export"` target configured in
// next.config.mjs.
export default function SignInPage() {
  return (
    <main className="page-shell">
      <section className="panel signin-container">
        <div className="section-head">
          <h1>Sign in to Muralist</h1>
          <p>
            Sign in to save your mural projects, palettes, and brand settings
            across devices. Guest mode still works on the home page if you'd
            rather not create an account.
          </p>
        </div>
        <SignInButtons />
      </section>
    </main>
  );
}
