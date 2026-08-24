const fs = require("fs");
const path = require("path");

// Dynamically find the project root (checks if node_modules is in the current folder or one level up)
const rootDir = fs.existsSync(path.join(__dirname, "node_modules")) 
    ? __dirname 
    : path.join(__dirname, "..");

const candidates = [
  path.join(rootDir, "node_modules", "@imgly", "background-removal-data", "dist"),
  path.join(rootDir, "node_modules", "@imgly", "background-removal", "dist"),
];

const src = candidates.find((p) => fs.existsSync(p));

if (!src) {
  console.error("❌ Couldn't find imgly model assets.");
  console.error("Please make sure you have installed the package by running:");
  console.error("npm install @imgly/background-removal");
  process.exit(1);
}

// Target the public/imgly-assets directory
const dest = path.join(rootDir, "public", "imgly-assets");

// Wipe stale files and copy fresh assets
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`✅ Successfully copied imgly assets!`);
console.log(`   From: ${src}`);
console.log(`   To:   ${dest}`);