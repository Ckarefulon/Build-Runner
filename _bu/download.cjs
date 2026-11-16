// Download the exact 0.2.1-rc.2 browser-use packages (plus the transitive
// schemastery/cosmokit pair the new runtime needs) into a temp folder.
const fs = require("fs");
const path = require("path");

const outDir = process.argv[2];
const PKGS = [
  ["@deepseek-ai/dsh-browser-use", "0.2.1-rc.2"],
  ["@deepseek-ai/dsh-experimental-browser-use-runtime", "0.2.1-rc.2"],
  ["@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp", "0.2.1-rc.2"],
  ["@deepseek-ai/schemastery", "3.18.5"],
  ["@deepseek-ai/cosmokit", "1.8.6"],
];

(async () => {
  const out = [];
  for (const [name, version] of PKGS) {
    const metaUrl = "https://registry.npmjs.org/" + name.replace("/", "%2f");
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) throw new Error("metadata " + metaRes.status + " for " + name);
    const meta = await metaRes.json();
    const v = meta.versions[version];
    if (!v) throw new Error("version " + version + " not found for " + name);
    const res = await fetch(v.dist.tarball);
    if (!res.ok) throw new Error("tarball " + res.status + " for " + name);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(outDir, name.split("/").pop() + "-" + version + ".tgz");
    fs.writeFileSync(file, buf);
    out.push({ name, version, file, bytes: buf.length });
    console.log("  " + name + "@" + version + " -> " + buf.length + " bytes");
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error("FAIL " + e.message);
  process.exit(1);
});
