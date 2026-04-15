import { loadPaintBrandCatalog } from "@muralist/config";
import { PrototypeApp } from "./PrototypeApp";

// Build-time hydration: the catalog ships inlined with the static export so the
// client never waits on an API call for defaults.
// TODO: wire a quarterly automated refresh of config/paint-brands.yaml so
// coverage / price / finish drift does not silently invalidate these defaults.
export default async function HomePage() {
  const catalog = await loadPaintBrandCatalog();
  return <PrototypeApp catalog={catalog} />;
}
