#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const deps = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
  ...packageJson.optionalDependencies
};

const forbiddenPackages = ["express", "@types/express", "fastify", "koa", "hapi", "@hapi/hapi"];
const packageHits = forbiddenPackages.filter((name) => deps[name]);
if (packageHits.length) {
  throw new Error(`Worker-only backend violation: forbidden Node server packages in package.json: ${packageHits.join(", ")}`);
}

const tracked = execFileSync("git", ["ls-files"], { cwd: new URL("../..", import.meta.url), encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const forbiddenFiles = tracked.filter((file) => /^backend\/src\/(server|index)\.ts$/.test(file));
if (forbiddenFiles.length) {
  throw new Error(`Worker-only backend violation: remove standalone Node entrypoints: ${forbiddenFiles.join(", ")}`);
}

const ignoredContentFiles = new Set([
  "backend/scripts/check-worker-only.mjs",
  "backend/package-lock.json"
]);
const contentPatterns = [
  /from\s+["']express["']/i,
  /require\(["']express["']\)/i,
  /\.listen\s*\(/,
  /createServer\s*\(/
];

const contentHits = [];
for (const file of tracked) {
  if (!file.startsWith("backend/")) continue;
  if (ignoredContentFiles.has(file)) continue;
  if (file.includes("/node_modules/") || file.includes("/dist/")) continue;
  if (!/\.(ts|tsx|js|mjs|cjs|json|md|toml|yml|yaml)$/.test(file)) continue;
  let text;
  try {
    text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") continue;
    throw err;
  }
  for (const pattern of contentPatterns) {
    if (pattern.test(text)) contentHits.push(`${file}: ${pattern}`);
  }
}

if (contentHits.length) {
  throw new Error(`Worker-only backend violation:\n${contentHits.join("\n")}`);
}

console.log("Worker-only backend check passed: APIs are Wrangler/Cloudflare Worker based.");
