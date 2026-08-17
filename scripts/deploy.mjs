// Copies the built plugin artifacts into a vault's plugin folder.
// Target resolution: SYNC_SENTINEL_DEPLOY env var, else the `.deploy-target`
// file (gitignored) at the project root. The target must be a plugin folder.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"]; // styles.css optional

function resolveTarget() {
  if (process.env.SYNC_SENTINEL_DEPLOY) return process.env.SYNC_SENTINEL_DEPLOY.trim();
  const f = path.join(ROOT, ".deploy-target");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return null;
}

const target = resolveTarget();
if (!target) {
  console.error(
    "No deploy target. Set SYNC_SENTINEL_DEPLOY or create a .deploy-target file\n" +
      "containing the absolute path to <vault>/.obsidian/plugins/sync-sentinel"
  );
  process.exit(1);
}

// Sanity check: refuse to write somewhere that isn't a plugin folder.
if (!target.includes(`${path.sep}plugins${path.sep}`) && !target.includes("/plugins/")) {
  console.error(`Refusing to deploy: "${target}" doesn't look like a plugins folder.`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
let copied = 0;
for (const a of ARTIFACTS) {
  const src = path.join(ROOT, a);
  if (!fs.existsSync(src)) {
    if (a === "styles.css") continue; // optional
    console.error(`Missing artifact: ${a} (run the build first)`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(target, a));
  copied++;
  console.log(`  → ${a}`);
}
console.log(`Deployed ${copied} artifact(s) to ${target}`);
