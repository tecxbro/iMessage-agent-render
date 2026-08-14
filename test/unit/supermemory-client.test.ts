import { describe, expect, it } from "vitest";

import {
  SupermemoryClient,
  ownerContainerTag,
} from "../../src/memory/supermemory-client.js";

const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-00000000000a";

describe("Supermemory provider boundary", () => {
  it("builds a provider-valid namespace entirely from internal IDs", () => {
    const tag = ownerContainerTag(DEPLOYMENT_ID, OWNER_ID);
    expect(tag).toHaveLength(94);
    expect(tag).toMatch(/^[a-zA-Z0-9_:-]+$/);
    expect(tag).not.toContain("+1555");
  });

  it("validates direct API responses instead of trusting provider JSON", async () => {
    const request: typeof fetch = async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: request,
      maxReadRetries: 0,
    });

    await expect(
      client.listMemories({
        containerTag: ownerContainerTag(DEPLOYMENT_ID, OWNER_ID),
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("retries bounded reads but never blindly retries a non-idempotent create", async () => {
    let readCalls = 0;
    const readRequest: typeof fetch = async () => {
      readCalls += 1;
      if (readCalls === 1) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          memoryEntries: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const readClient = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: readRequest,
      maxReadRetries: 1,
    });
    await expect(
      readClient.listMemories({
        containerTag: ownerContainerTag(DEPLOYMENT_ID, OWNER_ID),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    expect(readCalls).toBe(2);

    let createCalls = 0;
    const createRequest: typeof fetch = async () => {
      createCalls += 1;
      return new Response("unavailable", { status: 503 });
    };
    const createClient = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: createRequest,
      maxReadRetries: 2,
    });
    await expect(
      createClient.createMemories({
        containerTag: ownerContainerTag(DEPLOYMENT_ID, OWNER_ID),
        memories: [
          {
            content: "The owner prefers concise summaries.",
            isStatic: true,
            metadata: { scope: "owner", contentHash: "fixture" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_UNAVAILABLE",
    });
    expect(createCalls).toBe(1);
  });
});
