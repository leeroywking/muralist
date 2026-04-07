import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const packageJsonPath = path.join(rootDir, "package.json");
const appJsonPath = path.join(rootDir, "app.json");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));

const failures = [];

if (packageJson.main !== "./index.ts") {
  failures.push(
    `Expected apps/mobile/package.json main to be ./index.ts, received ${packageJson.main ?? "undefined"}.`
  );
}

const entryFilePath = path.join(rootDir, "index.ts");
if (!fs.existsSync(entryFilePath)) {
  failures.push("Expected apps/mobile/index.ts to exist.");
} else {
  const entryFile = fs.readFileSync(entryFilePath, "utf8");
  if (!entryFile.includes("registerRootComponent(App)")) {
    failures.push(
      "Expected apps/mobile/index.ts to register App with registerRootComponent(App)."
    );
  }
}

if (!appJson.expo?.android?.package) {
  failures.push("Expected apps/mobile/app.json to define expo.android.package.");
}

if (!appJson.expo?.ios?.bundleIdentifier) {
  failures.push("Expected apps/mobile/app.json to define expo.ios.bundleIdentifier.");
}

if (failures.length > 0) {
  console.error("Mobile configuration validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Mobile configuration validation passed.");
