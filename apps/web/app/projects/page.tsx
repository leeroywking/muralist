import { ProjectsDashboard } from "../ProjectsDashboard";

export const metadata = {
  title: "Projects – Muralist",
  description:
    "Your saved Muralist projects: open, delete, or restore a trashed palette."
};

// Server Component shell. All session + fetch logic lives in the client
// `ProjectsDashboard` component so the page stays compatible with the static
// `output: "export"` target configured in next.config.mjs — no server actions,
// no dynamic server functions.
export default function ProjectsPage() {
  return (
    <main className="page-shell">
      <ProjectsDashboard />
    </main>
  );
}
