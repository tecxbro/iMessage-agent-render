import { describe, expect, it, vi } from "vitest";

import {
  SpaceResolutionError,
  SpaceResolver,
  capabilitiesForLineMode,
  persistedRouteFromIMessageSpace,
} from "../../../src/transport/space-resolver.js";

describe("Spectrum space routing", () => {
  it("preserves the opaque space GUID, route phone, and space type", () => {
    expect(
      persistedRouteFromIMessageSpace({
        id: "opaque-chat-guid",
        type: "group",
        phone: "+15559999999",
      }),
    ).toEqual({
      routePhone: "+15559999999",
      spaceGuid: "opaque-chat-guid",
      spaceType: "group",
    });
  });

  it("passes a persisted route phone to space.get", async () => {
    const get = vi.fn(async () => ({ id: "rehydrated" }));
    const resolver = new SpaceResolver({ get });

    await expect(
      resolver.resolve({
        routePhone: "+15559999999",
        spaceGuid: "opaque-chat-guid",
        spaceType: "dm",
      }),
    ).resolves.toEqual({ id: "rehydrated" });

    expect(get).toHaveBeenCalledWith("opaque-chat-guid", {
      phone: "+15559999999",
    });
  });

  it("omits route parameters when the persisted route has no phone", async () => {
    const get = vi.fn(async () => ({ id: "shared" }));
    const resolver = new SpaceResolver({ get });

    await resolver.resolve({ spaceGuid: "shared-guid", spaceType: "dm" });

    expect(get).toHaveBeenCalledWith("shared-guid");
  });

  it("fails with a specific diagnostic before multi-line rehydration without a phone", async () => {
    const get = vi.fn(async () => ({ id: "unreachable" }));
    const resolver = new SpaceResolver(
      { get },
      { requireRoutePhone: true },
    );

    await expect(
      resolver.resolve({ spaceGuid: "missing-route", spaceType: "dm" }),
    ).rejects.toMatchObject({
      code: "SPECTRUM_ROUTE_PHONE_REQUIRED",
    } satisfies Partial<SpaceResolutionError>);
    expect(get).not.toHaveBeenCalled();
  });

  it("redacts provider rehydration failures that may contain available line numbers", async () => {
    const routePhone = "+15558887777";
    const resolver = new SpaceResolver({
      get: vi.fn(async () => {
        throw new Error(`Available line: ${routePhone}`);
      }),
    });

    await expect(
      resolver.resolve({
        routePhone,
        spaceGuid: "opaque-guid",
        spaceType: "group",
      }),
    ).rejects.not.toThrow(routePhone);
  });

  it("maps the native multiple-line lookup error to the route-phone diagnostic", async () => {
    const resolver = new SpaceResolver({
      get: vi.fn(async () => {
        throw new Error(
          "iMessage space.get requires params.phone when multiple clients are configured. Available: +15558887777",
        );
      }),
    });

    await expect(
      resolver.resolve({ spaceGuid: "missing-route", spaceType: "dm" }),
    ).rejects.toMatchObject({
      code: "SPECTRUM_ROUTE_PHONE_REQUIRED",
      message: expect.not.stringContaining("+15558887777"),
    });
  });

  it("distinguishes shared and dedicated-line group capabilities", () => {
    expect(capabilitiesForLineMode("shared")).toEqual({
      requiresRoutePhoneForRestart: false,
      supportsGroupCreation: false,
      supportsInboundGroupEvents: false,
    });
    expect(capabilitiesForLineMode("multiple-dedicated")).toEqual({
      requiresRoutePhoneForRestart: true,
      supportsGroupCreation: true,
      supportsInboundGroupEvents: true,
    });
  });
});
