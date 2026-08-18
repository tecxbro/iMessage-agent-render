import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderDashboardScript } from "../../src/http/deployment-page.js";
import {
  renderOperatorLoginPage,
  renderOperatorLoginScript,
} from "../../src/http/operator-login-page.js";

interface DashboardHarnessOptions {
  provider?: "photon" | "chatgpt";
  photonState?: string;
  popupBlocked?: boolean;
}

function createDashboardHarness(options: DashboardHarnessOptions = {}) {
  const provider = options.provider ?? "photon";
  const authListeners: Array<
    (event: { currentTarget: { href: string }; preventDefault(): void }) => void
  > = [];
  const scheduled: Array<() => void | Promise<void>> = [];
  const reload = vi.fn();
  const focus = vi.fn();
  const preventDefault = vi.fn();
  const replace = vi.fn();
  const stateElement = { textContent: "Waiting for authentication" };
  const authLink = {
    href:
      provider === "photon"
        ? "https://app.photon.codes/device"
        : "https://auth.openai.com/codex/device",
    addEventListener(
      type: string,
      listener: (
        event: {
          currentTarget: { href: string };
          preventDefault(): void;
        },
      ) => void,
    ) {
      if (type === "click") authListeners.push(listener);
    },
  };
  const popup = {
    closed: false,
    opener: {} as unknown,
    location: { replace },
    close: vi.fn(),
  };
  popup.close.mockImplementation(() => {
    popup.closed = true;
  });

  const windowObject = {
    open: vi.fn(() => (options.popupBlocked === true ? null : popup)),
    location: { reload },
    focus,
    setTimeout: vi.fn((callback: () => void | Promise<void>) => {
      scheduled.push(callback);
      return scheduled.length;
    }),
    clearTimeout: vi.fn(),
    addEventListener: vi.fn(),
  };
  const documentObject = {
    currentScript: { dataset: { polling: "true" } },
    querySelector(selector: string) {
      return selector === 'meta[name="csrf-token"]'
        ? { content: "session-bound-csrf-token" }
        : null;
    },
    body: {
      dataset: {
        photonState:
          provider === "photon" ? "awaiting_authorization" : "connected",
        chatgptState:
          provider === "chatgpt" ? "awaiting_authorization" : "connected",
        ready: "false",
      },
    },
    getElementById(id: string) {
      return id === "photon-state" ? stateElement : null;
    },
    querySelectorAll() {
      return [authLink];
    },
  };
  const fetchImplementation = vi.fn(async (url: string) => ({
    json: async () => {
      if (url.includes("photon/status")) {
        return {
          state:
            provider === "photon"
              ? (options.photonState ?? "connected")
              : "connected",
        };
      }
      if (url.includes("chatgpt/status")) return { state: "connected" };
      return { ready: false };
    },
  }));

  runInNewContext(renderDashboardScript(), {
    document: documentObject,
    fetch: fetchImplementation,
    window: windowObject,
  });

  return {
    authLink,
    authListeners,
    focus,
    fetchImplementation,
    popup,
    preventDefault,
    reload,
    replace,
    scheduled,
    stateElement,
    windowObject,
  };
}

describe("dashboard authentication popup", () => {
  it("uses same-origin cookies and a session-bound CSRF token", () => {
    const script = renderDashboardScript();

    expect(script).toContain('credentials: "same-origin"');
    expect(script).toContain('"X-CSRF-Token": csrfToken');
    expect(script).toContain('body: JSON.stringify({})');
    expect(script).toContain('fetch("/api/setup/owner"');
    expect(script).toContain("JSON.stringify({ phoneNumber })");
    expect(script).not.toContain("+14155550123");
    expect(script).not.toContain("x-agent-setup");
  });

  it("submits the owner phone with CSRF and clears the browser field immediately", async () => {
    type OwnerForm = {
      addEventListener(
        type: string,
        listener: (event: {
          preventDefault(): void;
          currentTarget: OwnerForm;
        }) => Promise<void> | void,
      ): void;
      querySelector(): { disabled: boolean };
      setAttribute: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
    };
    let submit:
      | ((event: { preventDefault(): void; currentTarget: OwnerForm }) => Promise<void> | void)
      | undefined;
    const reload = vi.fn();
    const button = { disabled: false };
    const input = {
      value: "+14155550123",
      focus: vi.fn(),
      setAttribute: vi.fn(),
    };
    const error = { textContent: "" };
    const form: OwnerForm = {
      addEventListener(
        type: string,
        listener: (event: {
          preventDefault(): void;
          currentTarget: OwnerForm;
        }) => Promise<void> | void,
      ) {
        if (type === "submit") submit = listener;
      },
      querySelector: () => button,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: "configured",
        maskedPhoneNumber: "••••••0123",
      }),
    }));

    runInNewContext(renderDashboardScript(), {
      document: {
        currentScript: { dataset: { polling: "false" } },
        querySelector: () => ({ content: "session-bound-csrf-token" }),
        querySelectorAll: () => [],
        body: { dataset: {} },
        getElementById(id: string) {
          if (id === "owner-form") return form;
          if (id === "owner-phone-number") return input;
          if (id === "owner-error") return error;
          return null;
        },
      },
      fetch: fetchImplementation,
      window: {
        location: { reload },
        addEventListener: vi.fn(),
        clearTimeout: vi.fn(),
      },
    });

    const preventDefault = vi.fn();
    await submit!({ preventDefault, currentTarget: form });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe("");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/setup/owner",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ phoneNumber: "+14155550123" }),
      }),
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["photon", "chatgpt"] as const)(
    "closes the %s popup and returns focus after authentication",
    async (provider) => {
      const harness = createDashboardHarness({ provider });

      harness.authListeners[0]!({
        currentTarget: harness.authLink,
        preventDefault: harness.preventDefault,
      });

      expect(harness.preventDefault).toHaveBeenCalledOnce();
      expect(harness.popup.opener).toBeNull();
      expect(harness.replace).toHaveBeenCalledWith(harness.authLink.href);

      await harness.scheduled.shift()!();

      expect(harness.popup.close).toHaveBeenCalledOnce();
      expect(harness.focus).toHaveBeenCalledOnce();
      expect(harness.reload).toHaveBeenCalledOnce();
    },
  );

  it("keeps the normal external-link fallback when a popup is blocked", () => {
    const harness = createDashboardHarness({ popupBlocked: true });

    harness.authListeners[0]!({
      currentTarget: harness.authLink,
      preventDefault: harness.preventDefault,
    });

    expect(harness.windowObject.open).toHaveBeenCalledOnce();
    expect(harness.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps polling through Photon provisioning without losing the popup", async () => {
    const harness = createDashboardHarness({ photonState: "provisioning" });

    harness.authListeners[0]!({
      currentTarget: harness.authLink,
      preventDefault: harness.preventDefault,
    });
    await harness.scheduled.shift()!();

    expect(harness.stateElement.textContent).toBe("Finishing setup");
    expect(harness.popup.close).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.scheduled).toHaveLength(1);
  });
});

describe("operator login script", () => {
  it("clears the password immediately and never uses browser persistence", async () => {
    const script = renderOperatorLoginScript();
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("location.search");
    expect(script).not.toContain("location.hash");

    let submit:
      | ((event: { preventDefault(): void }) => Promise<void>)
      | undefined;
    let resolveFetch:
      | ((response: { ok: boolean; status: number }) => void)
      | undefined;
    const fetchResult = new Promise<{ ok: boolean; status: number }>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );
    const input = {
      value: "submitted-agent-password",
      focus: vi.fn(),
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
    };
    const button = {
      disabled: false,
      textContent: "Continue",
    };
    const error = { textContent: "" };
    const form = {
      addEventListener(
        type: string,
        listener: (event: { preventDefault(): void }) => Promise<void>,
      ) {
        if (type === "submit") submit = listener;
      },
      querySelector: () => button,
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
    };
    const fetchImplementation = vi.fn(() => fetchResult);

    runInNewContext(script, {
      document: {
        getElementById(id: string) {
          if (id === "operator-login") return form;
          if (id === "password") return input;
          if (id === "login-error") return error;
          return null;
        },
      },
      fetch: fetchImplementation,
      window: { location: { replace: vi.fn() } },
    });

    const preventDefault = vi.fn();
    const pendingSubmission = submit!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe("");
    expect(button.disabled).toBe(true);
    expect(form.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/operator/session",
      expect.objectContaining({
        credentials: "same-origin",
        body: JSON.stringify({ password: "submitted-agent-password" }),
      }),
    );
    expect(script).not.toContain("setupSecret");

    resolveFetch!({ ok: false, status: 403 });
    await pendingSubmission;
    expect(error.textContent).toBe("That password was not accepted.");
    expect(input.setAttribute).toHaveBeenCalledWith("aria-invalid", "true");
    expect(button.disabled).toBe(false);
    expect(form.removeAttribute).toHaveBeenCalledWith("aria-busy");
    expect(input.focus).toHaveBeenCalledOnce();
  });

  it("associates login errors with the password input", () => {
    const page = renderOperatorLoginPage();
    expect(page).toContain("<h1>Open your agent</h1>");
    expect(page).toContain("Enter the agent password you chose when deploying.");
    expect(page).toContain(">Agent password</label>");
    expect(page).toContain('name="password"');
    expect(page).toContain('aria-describedby="login-error"');
    expect(page).not.toContain("environment variables");
    expect(page).not.toContain("service settings");
    expect(page).not.toContain("Photon");
    expect(page).not.toContain("ChatGPT");
  });
});
