// Bump only the two direct browser-use dependencies in the profile manifest.
const fs = require("fs");

const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const json = JSON.parse(text);

const WANT = {
  "@deepseek-ai/dsh-browser-use": "0.2.1-rc.2",
  "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp": "0.2.1-rc.2",
};

for (const [name, version] of Object.entries(WANT)) {
  if (!json.dependencies || json.dependencies[name] === undefined) {
    throw new Error("dependency not present: " + name);
  }
  console.log("  " + name + ": " + json.dependencies[name] + " -> " + version);
  json.dependencies[name] = version;
}

fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
console.log("manifest written");
