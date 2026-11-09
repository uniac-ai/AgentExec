// One file with nothing to install: what a host runs with `node agentexec.js`. The licences of
// what is bundled into it go beside it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const { metafile } = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/agentexec.js",
  metafile: true,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  legalComments: "none",
});

const folders = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) folders.add(match[1]);
}
const sections = [...folders].sort().map((folder) => {
  const { name, version, license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const file = readdirSync(folder).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  if (!file && !existsSync(join(folder, "LICENSE")))
    return `${name} ${version} (${license})\nSee https://www.npmjs.com/package/${name}\n`;
  return `${name} ${version} (${license})\n\n${readFileSync(join(folder, file), "utf8").trim()}\n`;
});
writeFileSync("dist/THIRD_PARTY_LICENSES.txt", sections.join(`\n${"=".repeat(72)}\n\n`));
console.log(`Bundled ${folders.size} packages.`);
