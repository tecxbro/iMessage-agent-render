import { describe, expect, it } from "vitest";

import { decideStatusMessage } from "../../src/messaging/status-policy.js";

const now = new Date("2026-08-14T12:00:00.000Z");

function input(overrides: Record<string, unknown> = {}) {
  return {
    chainId: "00000000-0000-4000-8000-000000000001",
    estimatedDurationMs: 12_000,
    simpleTurnThresholdMs: 5_000,
    contactsExternalDependency: false,
    proposedMessage: "I’m checking the restart path and its recovery test now.",
    priorMessages: [],
    cooldownMs: 30_000,
    now,
    ...overrides,
  };
}

describe("Step 5 deterministic status-message policy", () => {
  it("allows one useful early update for perceptibly long delegated work", () => {
    expect(decideStatusMessage(input())).toEqual({
      send: true,
      reason: "send",
      message: "I’m checking the restart path and its recovery test now.",
    });
  });

  it("allows a status when contacting an external dependency", () => {
    expect(
      decideStatusMessage(
        input({ estimatedDurationMs: 500, contactsExternalDependency: true }),
      ),
    ).toEqual({
      send: true,
      reason: "send",
      message: "I’m checking the restart path and its recovery test now.",
    });
  });

  it("suppresses short local work, same-chain repeats, and rate-limited updates", () => {
    expect(
      decideStatusMessage(input({ estimatedDurationMs: 4_999 })),
    ).toMatchObject({ send: false, reason: "simple_turn" });
    expect(
      decideStatusMessage(
        input({
          priorMessages: [
            {
              chainId: "00000000-0000-4000-8000-000000000001",
              message: "I’m already checking it.",
              sentAt: new Date("2026-08-14T11:50:00.000Z"),
            },
          ],
        }),
      ),
    ).toMatchObject({ send: false, reason: "already_sent_for_chain" });
    expect(
      decideStatusMessage(
        input({
          priorMessages: [
            {
              chainId: "00000000-0000-4000-8000-000000000099",
              message: "I’m checking a different issue.",
              sentAt: new Date("2026-08-14T11:59:45.001Z"),
            },
          ],
        }),
      ),
    ).toMatchObject({ send: false, reason: "rate_limited" });
  });

  it("suppresses a normalized duplicate even after the global cooldown", () => {
    expect(
      decideStatusMessage(
        input({
          proposedMessage: "  I’M checking the restart path and its recovery test now. ",
          priorMessages: [
            {
              chainId: "00000000-0000-4000-8000-000000000099",
              message: "I’m checking the restart path and its recovery test now.",
              sentAt: new Date("2026-08-14T11:50:00.000Z"),
            },
          ],
        }),
      ),
    ).toMatchObject({ send: false, reason: "duplicate" });
  });

  it.each([
    "I spawned three workers and queued task.execute.",
    "Codex emitted an item.completed event from gpt-5.6-sol.",
    "The internal agent runtime is dumping unrestricted logs.",
  ])("rejects internal implementation detail: %s", (proposedMessage) => {
    expect(decideStatusMessage(input({ proposedMessage }))).toMatchObject({
      send: false,
      reason: "unsafe_message",
    });
  });

  it("rejects blank suggestions and bounds oversized status text", () => {
    expect(
      decideStatusMessage(input({ proposedMessage: "   " })),
    ).toMatchObject({ send: false, reason: "missing_message" });
    const bounded = decideStatusMessage(
      input({ proposedMessage: "x".repeat(501), maximumCharacters: 100 }),
    );
    expect(bounded).toMatchObject({ send: true, reason: "send" });
    expect(bounded.message).toHaveLength(100);
  });
});
