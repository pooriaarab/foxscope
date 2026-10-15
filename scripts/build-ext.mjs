// Builds extension/ into dist-ext/: esbuild bundles each script, and the
// other files are copied. It stops when the manifest version is not the
// package.json version, so AMO signs the version that npm publishes.
// --e2e builds dist-e2e/: the same, with the page API also on 127.0.0.1 and
// localhost, where the local E2E serves e2e/site (never in dist-ext/, which
// release.yml signs; check:amo stops if a local host reaches it).
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

const e2e = process.argv.includes("--e2e");
const out = e2e ? "dist-e2e" : "dist-ext";
rmSync(out, { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`),
  outdir: out,
  bundle: true,
  format: "iife",
  target: "firefox153",
  logLevel: "warning",
});
// amo-metadata.json is the AMO listing, not a part of the add-on.
for (const file of files.filter((f) => !f.endsWith(".js") && f !== "amo-metadata.json")) cpSync(`extension/${file}`, `${out}/${file}`, { recursive: true });
if (e2e) {
  const local = { ...manifest, content_scripts: manifest.content_scripts.map((cs) => ({ ...cs, matches: [...cs.matches, "http://127.0.0.1/*", "http://localhost/*"] })) };
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(local, null, 2)}\n`);
}
console.log(`Built ${out}/ (version ${pkg.version}).`);
