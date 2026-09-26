import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/commands/core";
import { bundleVersion, compareVersions, installTool, olderThanProject, readToolVersion } from "../../src/core/tool";
import { BUNDLE, cli, projectTool, tempProject } from "../helpers";

const pkgVersion = JSON.parse(readFileSync(join(BUNDLE, "../../package.json"), "utf8")).version as string;

/** Pretends the project's copy of the tool is another version (the marker is on the bundle's second line). */
function setProjectVersion(root: string, v: string): void {
  const path = join(root, "context-cube/.tool/cube.mjs");
  writeFileSync(path, readFileSync(path, "utf8").replace(/__CUBE_TOOL_VERSION__ = "[^"]+"/, `__CUBE_TOOL_VERSION__ = "${v}"`));
}

describe("the tool's version", () => {
  it("compares release versions by their numbers", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
  });

  it("is written at the top of the bundle and read back from a project's copy", async () => {
    expect(bundleVersion(BUNDLE)).toBe(pkgVersion);
    const root = tempProject();
    await init({ cwd: root });
    expect(readToolVersion(root)).toBe(pkgVersion);
  });

  it("an older tool refuses to run against a project set up with a newer one; the project's copy runs", async () => {
    const root = tempProject();
    await init({ cwd: root });
    setProjectVersion(root, "9.9.9");
    expect(olderThanProject(root, pkgVersion, BUNDLE)).toContain(`This project uses Context Cube 9.9.9, and you ran ${pkgVersion}`);
    expect(olderThanProject(root, pkgVersion, join(root, "context-cube/.tool/cube.mjs"))).toBeUndefined();
    expect(olderThanProject(root, "0.0.0-dev", BUNDLE)).toBeUndefined();
    const r = cli(["status"], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npx context-cube@latest");
    expect(projectTool(root, ["status"]).status).toBe(0);
    // Nor does it replace the newer copy.
    expect(() => installTool(root)).toThrow(/newer than this one/);
    expect(readToolVersion(root)).toBe("9.9.9");
  });

  it("a newer tool replaces an older copy and says so", async () => {
    const root = tempProject();
    await init({ cwd: root });
    setProjectVersion(root, "0.0.1");
    expect(installTool(root).updatedFrom).toBe("0.0.1");
    expect(readToolVersion(root)).toBe(pkgVersion);
  });
});
