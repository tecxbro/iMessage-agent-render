import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  renderDashboardScript,
  renderDeploymentPage,
  type DeploymentPageOptions,
} from "../../src/http/deployment-page.js";
import {
  READINESS_COMPONENTS,
  type ComponentReadiness,
  type ServiceReadinessSnapshot,
} from "../../src/http/readiness.js";

function snapshot(
  ready: boolean,
  overrides: Partial<
    Record<(typeof READINESS_COMPONENTS)[number], ComponentReadiness>
  > = {},
): ServiceReadinessSnapshot {
  const state: ComponentReadiness = { state: ready ? "ok" : "unknown" };
  return {
    status: ready ? "ready" : "not_ready",
    ready,
    shuttingDown: false,
    components: Object.fromEntries(
      READINESS_COMPONENTS.map((component) => [
        component,
        overrides[component] ?? state,
      ]),
    ) as ServiceReadinessSnapshot["components"],
    actions: [],
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const chatGptAgent: DeploymentPageOptions = {
  authMode: "chatgpt",
  runtimeMode: "agent",
  supermemoryConfigured: false,
};

describe("deployment page characterization snapshots", () => {
  it("preserves the initial setup document byte for byte", () => {
    expect(
      digest(
        renderDeploymentPage(snapshot(false), {
          ...chatGptAgent,
          runtimeMode: "foundation",
          supermemoryConfigured: true,
        }),
      ),
    ).toBe("0ef5257e99a224c099baca1537594692634d8e6481893a1e259613b12ffaef0f");
  });

  it("preserves provider setup states and escaping byte for byte", () => {
    const pages = [
      renderDeploymentPage(
        snapshot(false),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••<&\"'" },
        {
          state: "awaiting_authorization",
          userCode: "PH<&\"'",
          verificationUrl: "https://app.photon.codes/device?next=one&two=three",
          expiresAt: "2026-08-19T00:00:00.000Z",
        },
      ),
      renderDeploymentPage(
        snapshot(false),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••4567" },
        { state: "connected", assignedPhoneNumber: "+14155550123" },
        {
          state: "awaiting_authorization",
          userCode: "CG<&\"'",
          verificationUrl: "https://auth.openai.com/codex/device?one=1&two=2",
        },
      ),
      renderDeploymentPage(
        snapshot(false, {
          codexAuth: { state: "ok" },
          codexCapabilities: { state: "starting" },
        }),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••4567" },
        { state: "connected", assignedPhoneNumber: "+14155550123" },
        { state: "connected" },
      ),
    ];

    expect(digest(pages.join("\n---PAGE---\n"))).toBe(
      "48c17d073d1fa1b0fc50b50dd481f5154a2624c21b1a5dd44518cc39b371c4cb",
    );
  });

  it("preserves ready ChatGPT and API-key documents byte for byte", () => {
    const ready = snapshot(true);
    const statuses = [
      { state: "configured", maskedPhoneNumber: "••••4567" },
      { state: "connected", assignedPhoneNumber: "+14155550123" },
      { state: "connected" },
    ] as const;
    const pages = [
      renderDeploymentPage(ready, chatGptAgent, ...statuses),
      renderDeploymentPage(
        ready,
        {
          authMode: "api_key",
          runtimeMode: "agent",
          supermemoryConfigured: true,
        },
        ...statuses,
      ),
    ];

    expect(digest(pages.join("\n---PAGE---\n"))).toBe(
      "8d52abef1bdba84c1d801a56b2a64c876f2dac3fcace0129d75b137889a20344",
    );
  });

  it("preserves the dashboard client script byte for byte", () => {
    expect(digest(renderDashboardScript())).toBe(
      "8d17b1ddabc5cd0c5fcfc370a837068ccf195876261dee7b678c5ffb0680dd90",
    );
  });
});
