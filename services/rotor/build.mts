import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, statSync, readdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// Read package.json to get dependency versions
const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));

// Native modules that need to be external and installed
const nativeModules = ["isolated-vm", "@confluentinc/kafka-javascript", "@mongodb-js/zstd"];
// pg-native is optional for pg package, mark as external but don't install
const externalModules = [...nativeModules, "pg-native"];

// Extract versions from package.json dependencies
const nativeDeps = Object.fromEntries(
  nativeModules.map((mod) => [mod, packageJson.dependencies[mod]])
);

// Bundle the app
await esbuild.build({
  entryPoints: ["./src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "./dist/main.js",
  sourcemap: true,
  minify: false,
  external: externalModules,
  logLevel: "info",
});

mkdirSync("dist", { recursive: true });
writeFileSync("dist/package.json", JSON.stringify({ dependencies: nativeDeps }, null, 2));

// Install native deps
console.log("Installing native dependencies...");
execSync("cd dist && npm install --prod --no-package-lock", { stdio: "inherit" });

// Show sizes
function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const files = readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = join(dirPath, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += statSync(filePath).size;
      }
    }
  } catch (e) {
    // ignore errors
  }
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const nodeModulesSize = getDirSize("dist/node_modules");
const distSize = getDirSize("dist");

console.log(`\nnode_modules size: ${formatBytes(nodeModulesSize)}`);
console.log(`dist total size: ${formatBytes(distSize)}`);
console.log("\nBuild complete!");
