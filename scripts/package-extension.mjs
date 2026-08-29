import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const output = resolve(dist, "codex-paper-reader-extension.zip");

mkdirSync(dist, { recursive: true });
rmSync(output, { force: true });
execFileSync("zip", ["-qr", output, ".", "-x", "test/*"], { cwd: resolve(root, "extension"), stdio: "inherit" });
console.log(output);
