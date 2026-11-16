// Build the new profile manifests in the workspace so they can be reviewed
// before anything under ~/.dsh is touched.
const fs = require("fs");
const path = require("path");

const P = "C:/Users/Vxiao/.dsh/profiles/desktop";
const OUT = process.argv[2];

const TARGET = "0.2.1-rc.2";
const BUMP = [
  "@deepseek-ai/dsh-browser-use",
  "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp",
];

// ---- package.json ----
const pkg = JSON.parse(fs.readFileSync(path.join(P, "package.json"), "utf8"));
for (const name of BUMP) {
  if (!pkg.dependencies || pkg.dependencies[name] === undefined) {
    throw new Error("dependency not present in manifest: " + name);
  }
  console.log("dep " + name + ": " + pkg.dependencies[name] + " -> " + TARGET);
  pkg.dependencies[name] = TARGET;
}
// The git bundle is what pins 0.2.0-rc.2: it declares those versions as its own
// dependencies, so leaving it installed makes pnpm reintroduce the old copy.
// Its only job is inserting the two rows, which the profile patch now owns.
const bi = (pkg.dsh.profile.bundles || []).indexOf("dsh-chrome-devtools");
if (bi === -1) throw new Error("dsh-chrome-devtools not in bundles");
pkg.dsh.profile.bundles.splice(bi, 1);
console.log("bundle dsh-chrome-devtools removed from dsh.profile.bundles");
if (pkg.dependencies["dsh-chrome-devtools"] !== undefined) {
  delete pkg.dependencies["dsh-chrome-devtools"];
  console.log("dep dsh-chrome-devtools removed (pinned 0.2.0-rc.2)");
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");

// ---- cordis.patch.yml ----
const patchFile = path.join(P, "cordis.patch.yml");
let yml = fs.readFileSync(patchFile, "utf8");

const OLD_START = "# Browser Use — official Chrome DevTools MCP provider.";
const OLD_END_MARK = "executablePath: 'C:\\Users\\Vxiao\\AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe'";
const start = yml.indexOf(OLD_START);
const endAt = yml.indexOf(OLD_END_MARK);
if (start === -1 || endAt === -1) throw new Error("browser-use block boundaries not found");
const end = endAt + OLD_END_MARK.length;
const before = yml.slice(0, start);
const after = yml.slice(end);

const NEW_BLOCK = [
  "# Browser Use — official Chrome DevTools MCP provider.",
  "# Only one browser-use provider may be registered per composition: do not also",
  "# mount the Playwright or Stagehand providers.",
  "#",
  "# These two rows are inserted HERE rather than by the dsh-chrome-devtools bundle.",
  "# That bundle declares 0.2.0-rc.2 as its own dependency, which the dsh 0.2.1",
  "# compatibility preflight refuses, so keeping it would drag the old copy back in.",
  "- insert:",
  "    - id: browser-use",
  "      name: '@deepseek-ai/dsh-browser-use'",
  "    - id: browser-use-chrome-devtools",
  "      name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'",
  "      config:",
  "        mode: launch",
  "        # true runs without a visible window; set false to watch the browser work.",
  "        headless: true",
  "        # No Google Chrome on this machine, so drive Edge Canary instead.",
  "        executablePath: 'C:\\Users\\Vxiao\\AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe'",
].join("\n");

fs.writeFileSync(path.join(OUT, "cordis.patch.yml"), before + NEW_BLOCK + after, "utf8");
console.log("cordis.patch.yml rewritten (" + (before.length + NEW_BLOCK.length + after.length) + " bytes)");
