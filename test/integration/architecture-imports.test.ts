import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

interface ImportBoundaryViolation {
  file: string;
  specifier: string;
  rule: string;
}

interface ImportRule {
  fromLayer: string;
  forbiddenLayers: readonly string[];
  forbiddenPackages: readonly string[];
  explanation: string;
}

const sourceRoot = resolve("src");

const importRules: readonly ImportRule[] = [
  {
    fromLayer: "transport",
    forbiddenLayers: ["agent"],
    forbiddenPackages: ["@openai/codex", "@openai/codex-sdk", "supermemory"],
    explanation: "transport must never invoke model or memory runtimes",
  },
  {
    fromLayer: "agent",
    forbiddenLayers: ["transport"],
    forbiddenPackages: ["spectrum-ts"],
    explanation: "agents must never send Spectrum messages",
  },
  {
    fromLayer: "security",
    forbiddenLayers: ["agent"],
    forbiddenPackages: ["@openai/codex", "@openai/codex-sdk"],
    explanation: "security policy must remain deterministic and model-free",
  },
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

function layerForFile(file: string): string | undefined {
  const [layer] = relative(sourceRoot, file).split(sep);
  return layer;
}

function importedLayer(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const target = resolve(dirname(file), specifier.replace(/\.(?:js|ts)$/u, ""));
  const [layer] = relative(sourceRoot, target).split(sep);
  return layer;
}

function packageMatches(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function importSpecifiers(file: string, source: string): string[] {
  const specifiers: string[] = [];
  const staticImportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImportPattern =
    /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu;

  for (const pattern of [staticImportPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }

  // Include the file in failures from malformed scanners without logging source.
  void file;
  return specifiers;
}

function findViolations(file: string, source: string): ImportBoundaryViolation[] {
  const fromLayer = layerForFile(file);
  if (fromLayer === undefined) {
    return [];
  }

  return importRules.flatMap((rule) => {
    if (rule.fromLayer !== fromLayer) {
      return [];
    }

    return importSpecifiers(file, source).flatMap((specifier) => {
      const targetLayer = importedLayer(file, specifier);
      const violatesLayer =
        targetLayer !== undefined && rule.forbiddenLayers.includes(targetLayer);
      const violatesPackage = rule.forbiddenPackages.some((packageName) =>
        packageMatches(specifier, packageName),
      );

      return violatesLayer || violatesPackage
        ? [
            {
              file: relative(resolve("."), file),
              specifier,
              rule: rule.explanation,
            },
          ]
        : [];
    });
  });
}

describe("architecture import boundaries", () => {
  it("keeps the repository source graph inside the frozen boundaries", () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) =>
      findViolations(file, readFileSync(file, "utf8")),
    );

    expect(violations).toEqual([]);
  });

  it("detects transport-to-agent and security-to-Codex regressions", () => {
    expect(
      findViolations(
        resolve("src/transport/message-loop.ts"),
        'import { runAgent } from "../agent/codex-client.js";',
      ),
    ).toHaveLength(1);
    expect(
      findViolations(
        resolve("src/security/authorize-sender.ts"),
        'import { Codex } from "@openai/codex-sdk";',
      ),
    ).toHaveLength(1);
  });

  it("allows environment reads only in the validated environment module", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((file) => !file.endsWith(`${sep}config${sep}env.ts`))
      .filter((file) => /\bprocess\.env\b/u.test(readFileSync(file, "utf8")))
      .map((file) => relative(resolve("."), file));

    expect(offenders).toEqual([]);
  });
});
