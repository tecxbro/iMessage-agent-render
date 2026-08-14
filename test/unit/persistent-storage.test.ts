import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PersistentStorageError,
  preparePersistentStorage,
} from "../../src/runtime/persistent-storage.js";

const temporaryDirectories: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-storage-test-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("persistent Codex and workspace storage", () => {
  it("creates separate restricted paths and idempotent headless auth config", async () => {
    const root = await fixtureRoot();
    const codexHome = join(root, "codex");
    const workspaceRoot = join(root, "workspaces");

    const first = await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });
    expect(first.codexConfigCreated).toBe(true);
    expect(await readFile(first.codexConfigPath, "utf8")).toBe(
      'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
    );

    const second = await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });
    expect(second.codexConfigCreated).toBe(false);
    expect(await readFile(second.codexConfigPath, "utf8")).toBe(
      await readFile(first.codexConfigPath, "utf8"),
    );
  });

  it("refuses conflicting auth mode rather than silently changing it", async () => {
    const root = await fixtureRoot();
    const codexHome = join(root, "codex");
    const workspaceRoot = join(root, "workspaces");
    await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });
    await writeFile(
      join(codexHome, "config.toml"),
      'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
      "utf8",
    );
    await chmod(join(codexHome, "config.toml"), 0o600);

    await expect(
      preparePersistentStorage({
        codexHome,
        workspaceRoot,
        authMode: "api_key",
      }),
    ).rejects.toBeInstanceOf(PersistentStorageError);
  });

  it("recognizes valid TOML formatting without appending duplicate keys", async () => {
    const root = await fixtureRoot();
    const codexHome = join(root, "codex");
    const workspaceRoot = join(root, "workspaces");
    await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });
    const configPath = join(codexHome, "config.toml");
    const formatted =
      'cli_auth_credentials_store="file"\nforced_login_method = "chatgpt" # required mode\n';
    await writeFile(configPath, formatted, "utf8");
    await chmod(configPath, 0o600);

    await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });

    expect(await readFile(configPath, "utf8")).toBe(formatted);
  });

  it("does not treat commented examples as active Codex settings", async () => {
    const root = await fixtureRoot();
    const codexHome = join(root, "codex");
    const workspaceRoot = join(root, "workspaces");
    await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });
    const configPath = join(codexHome, "config.toml");
    await writeFile(
      configPath,
      '# cli_auth_credentials_store = "file"\n# forced_login_method = "chatgpt"\n',
      "utf8",
    );
    await chmod(configPath, 0o600);

    await preparePersistentStorage({
      codexHome,
      workspaceRoot,
      authMode: "chatgpt",
    });

    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain('\ncli_auth_credentials_store = "file"\n');
    expect(contents).toContain('forced_login_method = "chatgpt"\n');
  });

  it("rejects overlapping protected roots", async () => {
    const root = await fixtureRoot();
    await expect(
      preparePersistentStorage({
        codexHome: join(root, "codex"),
        workspaceRoot: join(root, "codex", "workspaces"),
        authMode: "chatgpt",
      }),
    ).rejects.toThrow(/separate, non-overlapping/);
  });
});
