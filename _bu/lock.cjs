// Rewrite pnpm-lock.yaml to match what is now on disk.
// Text-level edits only: the lockfile is machine-generated, and regenerating it
// with pnpm would require the swap this whole approach avoids.
const fs = require("fs");

const file = process.argv[2];
let t = fs.readFileSync(file, "utf8");
const before = t;

const D = "@deepseek-ai/";
const OLD = "0.2.0-rc.2";
const NEW = "0.2.1-rc.2";

// 1. importer specs
t = t.replace(
  `      '${D}dsh-browser-use':\n        specifier: ${OLD}\n        version: ${OLD}`,
  `      '${D}dsh-browser-use':\n        specifier: ${NEW}\n        version: ${NEW}`,
);
t = t.replace(
  `      '${D}dsh-experimental-browser-use-chrome-devtools-mcp':\n        specifier: ${OLD}\n        version: ${OLD}(${D}dsh-browser-use@${OLD})`,
  `      '${D}dsh-experimental-browser-use-chrome-devtools-mcp':\n        specifier: ${NEW}\n        version: ${NEW}(${D}dsh-browser-use@${NEW})`,
);

// 2. drop the git bundle from the importer
t = t.replace(
  /      dsh-chrome-devtools:\n        specifier: git\+https:\/\/github\.com\/DevTarlow\/dsh-chrome-devtools\.git\n        version: git\+https:\/\/github\.com\/DevTarlow\/dsh-chrome-devtools\.git#[0-9a-f]+\n/,
  "",
);

// 3. packages / snapshots entries
t = t.split(`${D}dsh-browser-use@${OLD}`).join(`${D}dsh-browser-use@${NEW}`);
t = t.split(`${D}dsh-experimental-browser-use-runtime@${OLD}`).join(`${D}dsh-experimental-browser-use-runtime@${NEW}`);
t = t.split(`${D}dsh-experimental-browser-use-chrome-devtools-mcp@${OLD}`).join(`${D}dsh-experimental-browser-use-chrome-devtools-mcp@${NEW}`);

// 4. the new runtime depends on schemastery 3.18.5
t = t.replace(
  /(@deepseek-ai\/dsh-experimental-browser-use-runtime@0\.2\.1-rc\.2\([^)]*\):\n    dependencies:\n      '@deepseek-ai\/dsh-browser-use': 0\.2\.1-rc\.2\n      '@deepseek-ai\/schemastery': )3\.18\.4/,
  "$13.18.5",
);
t = t.split(`${D}schemastery@3.18.4`).join(`${D}schemastery@3.18.5`);
t = t.replace(
  /(@deepseek-ai\/schemastery@3\.18\.5:\n    dependencies:\n      '@deepseek-ai\/cosmokit': )1\.8\.5/,
  "$11.8.6",
);
t = t.split(`${D}cosmokit@1.8.5`).join(`${D}cosmokit@1.8.6`);

// 5. remove the git bundle's own package + snapshot records
t = t.replace(/\n  dsh-chrome-devtools@git\+[^:]+:\n(?:    .*\n|\n)*?(?=\n  \S|\n\n\S)/g, "\n");

fs.writeFileSync(file, t, "utf8");
console.log("lockfile rewritten, " + before.length + " -> " + t.length + " bytes");
for (const s of [OLD]) {
  const left = t.split(s).length - 1;
  console.log("  remaining '" + s + "' occurrences: " + left);
}
console.log("  dsh-chrome-devtools refs: " + (t.split("dsh-chrome-devtools").length - 1));
