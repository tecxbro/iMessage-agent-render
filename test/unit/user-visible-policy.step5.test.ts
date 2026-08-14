import { describe, expect, it } from "vitest";

import { assertUserFacingMessageSafe } from "../../src/messaging/user-visible-policy.js";

describe("Step 5 user-visible privacy boundary", () => {
  it.each([
    "The task.execute queue is waiting.",
    "The run used gpt-5.6-sol.",
    "Here are the raw Codex events.",
    "The worker name is runtime-debugger.",
    "I can share the unrestricted logs.",
  ])("rejects hidden implementation detail: %s", (message) => {
    expect(() => assertUserFacingMessageSafe(message)).toThrow(
      /hidden orchestration|model details/i,
    );
  });

  it("rejects a dynamically named execution context but permits safe outcomes", () => {
    expect(() =>
      assertUserFacingMessageSafe(
        "runtime-debugger confirmed the restart path.",
        ["runtime-debugger"],
      ),
    ).toThrow(/internal named execution context/i);
    expect(() =>
      assertUserFacingMessageSafe(
        "The restart path is confirmed, but the live provider check could not run.",
        ["runtime-debugger"],
      ),
    ).not.toThrow();
  });
});
