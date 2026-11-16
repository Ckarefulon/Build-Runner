// Extract the downloaded tarballs straight into the profile's node_modules.
// Deliberately does NOT run pnpm: a live Host holds handles on other packages,
// and pnpm's swap phase empties a package dir before it fails.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TGZDIR = process.argv[2];
const NM = process.argv[3];

const manifest = JSON.parse(fs.readFileSync(path.join(TGZDIR, "manifest.json"), "utf8"));
const scratch = path.join(TGZDIR, "_stage");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

for (const entry of manifest) {
  const unpack = path.join(scratch, entry.name.replace(/[/@]/g, "_"));
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync("tar", ["-xzf", entry.file, "-C", unpack], { stdio: "ignore" });

  const src = path.join(unpack, "package");
  const dest = path.join(NM, ...entry.name.split("/"));

  // Replace the package wholesale; remove only what this package owns.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, item), path.join(dest, item), { recursive: true });
  }

  const got = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
  const ok = got.version === entry.version;
  console.log((ok ? "OK   " : "BAD  ") + entry.name + " -> installed " + got.version +
    (ok ? "" : " (wanted " + entry.version + ")"));
  if (!ok) process.exitCode = 1;
}
