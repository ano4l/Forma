const fs = require("node:fs");
const path = require("node:path");
const parser = require("pgsql-parser");

const directory = path.resolve(__dirname, "..", "supabase", "migrations");
for (const filename of fs.readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
  parser.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
  console.log(`parsed ${filename}`);
}
