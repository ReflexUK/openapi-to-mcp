// scripts/embed-version.mjs
// Reads `version` from package.json and writes src/version.ts with the VERSION constant.
// Run via the `prebuild` npm script so src/version.ts is always up to date before compilation.

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "src/version.ts",
  `// AUTO-GENERATED — do not edit\nexport const VERSION = "${pkg.version}";\n`,
);

console.error(`embed-version: wrote src/version.ts with VERSION = "${pkg.version}"`);
