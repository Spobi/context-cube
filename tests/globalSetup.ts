import { execFileSync } from "node:child_process";

// End-to-end tests run the real bundle, so build it once before the suite.
export default function setup() {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
}
