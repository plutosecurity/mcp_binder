import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PRIVATE_MARKERS = [
  new RegExp("black" + "hat", "i"),
  new RegExp("dev\\." + "pluto" + "\\.security", "i"),
  new RegExp("avishai" + "go", "i"),
  new RegExp("mcp-" + "existing", "i"),
  new RegExp("mcp-" + "rebind", "i")
];

const BLOCKED_TRACKED_PATHS = [
  /^dist\//,
  /^deployment\.framework-config\.json$/,
  /^my-lab\.framework-config\.json$/,
  /^reproduce\.md$/,
  /^draft\.md$/,
  /^\.DS_Store$/,
  /\/\.DS_Store$/,
  /token/i
];

const BLOCKED_LOCAL_PATHS = [
  /^docs\/\.DS_Store$/,
  /^docs\/assets\/\.DS_Store$/,
  /^dist\/mcp-binder-dashboard-token$/,
  /^dist\/mcp-binder-ingest-token$/
];

const trackedFiles = gitLines(["ls-files"]);
const trackedViolations = trackedFiles.filter((file) => BLOCKED_TRACKED_PATHS.some((pattern) => pattern.test(file)));
if (trackedViolations.length) {
  fail("blocked files are tracked", trackedViolations);
}

const markerViolations = [];
for (const file of trackedFiles) {
  if (!fs.existsSync(file)) {
    continue;
  }
  if (isBinaryCandidate(file)) {
    continue;
  }
  const body = fs.readFileSync(file, "utf8");
  for (const marker of PRIVATE_MARKERS) {
    if (marker.test(body)) {
      markerViolations.push(`${file}: ${marker}`);
    }
  }
}
if (markerViolations.length) {
  fail("private markers found in tracked files", markerViolations);
}

const localViolations = [];
for (const file of walk(".")) {
  if (BLOCKED_LOCAL_PATHS.some((pattern) => pattern.test(file))) {
    localViolations.push(file);
  }
}
if (localViolations.length) {
  fail("blocked local artifacts exist", localViolations);
}

console.log("release check ok");

function gitLines(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isBinaryCandidate(file) {
  const ext = path.extname(file).toLowerCase();
  return [".gif", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(ext);
}

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    const normalized = fullPath.replace(/^\.\//, "");
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(normalized);
    }
  }
  return files;
}

function fail(message, values) {
  console.error(`release check failed: ${message}`);
  for (const value of values) {
    console.error(`  - ${value}`);
  }
  process.exit(1);
}
