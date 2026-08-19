import { describe, expect, it, vi } from "vitest";

import { createInteractionCoordinateHandler } from "../../src/queue/handlers/interaction-coordinate.js";

describe("interaction coordinate handler", () => {
  it("forwards the identifier-only wake and returns", async () => {
    const wake = vi.fn(async () => undefined);
    const handler = createInteractionCoordinateHandler({ wake });
    const payload = {
      spaceId: "51000000-0000-4000-8000-000000000001",
      reason: "recovery" as const,
    };

    await handler(payload);

    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(payload.spaceId, payload.reason);
  });
});
