import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

execFileSync(process.execPath, ["scripts/verify-push-target.mjs"], {
  stdio: "inherit",
});
accessSync(".githooks/pre-push", constants.X_OK);
execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"]);
execFileSync("git", ["config", "--local", "remote.pushDefault", "origin"]);
console.log("Git push guards installed for this checkout.");
