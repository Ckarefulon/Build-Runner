// Offline "would the boot accept this?" check for the staged profile.
const fs = require("fs");
const path = require("path");
const semver = require("C:/Users/Vxiao/.dsh/profiles/desktop/node_modules/semver");
const yaml = require("C:/Users/Vxiao/.dsh/profiles/desktop/node_modules/js-yaml");

const STAGE = process.argv[2];
const TGZDIR = process.argv[3];
const RUNTIME = "0.2.1-rc.2";
const failures = [];

// Mirrors the host's unmetRequirements: engines.dsh decides alone, otherwise
// every @deepseek-ai/dsh or @deepseek-ai/dsh-* peer must match.
function unmetRequirements(fields, runtimeVersion) {
  const engines = fields.engines && typeof fields.engines === "object" ? fields.engines : {};
  if (Object.hasOwn(engines, "dsh")) {
    return semver.satisfies(runtimeVersion, engines.dsh) ? {} : { "engines.dsh": engines.dsh };
  }
  if (!fields.peerDependencies) return {};
  const unmet = {};
  for (const [name, range] of Object.entries(fields.peerDependencies)) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
    if (!semver.satisfies(runtimeVersion, range)) unmet[name] = range;
  }
  return unmet;
}

// --- 1. manifest no longer drags in the pinning bundle ---
const pkg = JSON.parse(fs.readFileSync(path.join(STAGE, "package.json"), "utf8"));
if (pkg.dependencies["dsh-chrome-devtools"]) failures.push("dsh-chrome-devtools still a dependency");
if ((pkg.dsh.profile.bundles || []).includes("dsh-chrome-devtools")) {
  failures.push("dsh-chrome-devtools still in dsh.profile.bundles");
}
console.log("1. dsh-chrome-devtools removed from manifest: " + (failures.length === 0));

// --- 2. patch parses and inserts both rows ---
const parsed = yaml.load(fs.readFileSync(path.join(STAGE, "cordis.patch.yml"), "utf8"));
const insertedIds = parsed.filter((p) => p && p.insert)
  .flatMap((p) => (p.insert || []).map((r) => r && r.id)).filter(Boolean);
console.log("2. patch parses; entries=" + parsed.length + "; insert rows=" + JSON.stringify(insertedIds));
for (const want of ["browser-use", "browser-use-chrome-devtools"]) {
  if (!insertedIds.includes(want)) failures.push("patch does not insert " + want);
}

// --- 3. the packages actually shipped in the tarballs pass the preflight ---
const manifest = JSON.parse(fs.readFileSync(path.join(TGZDIR, "manifest.json"), "utf8"));
const { execFileSync } = require("child_process");
const extractDir = path.join(TGZDIR, "_x");
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });

console.log("3. preflight against dsh " + RUNTIME + ":");
for (const entry of manifest) {
  const sub = path.join(extractDir, entry.name.replace(/[/@]/g, "_"));
  fs.mkdirSync(sub, { recursive: true });
  execFileSync("tar", ["-xzf", entry.file, "-C", sub], { stdio: "ignore" });
  const fields = JSON.parse(fs.readFileSync(path.join(sub, "package", "package.json"), "utf8"));
  const unmet = unmetRequirements(fields, RUNTIME);
  const ok = Object.keys(unmet).length === 0;
  console.log("   " + (ok ? "PASS " : "DENY ") + entry.name + "@" + entry.version +
    (ok ? "" : "  unmet=" + JSON.stringify(unmet)));
  // Only the two browser-use packages are mounted as rows; the rest are support libs.
  if (!ok && entry.name.startsWith("@deepseek-ai/dsh-browser-use")) {
    failures.push(entry.name + " would be refused at boot");
  }
  if (!ok && entry.name.includes("chrome-devtools-mcp")) {
    failures.push(entry.name + " would be refused at boot");
  }
}

console.log("");
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
