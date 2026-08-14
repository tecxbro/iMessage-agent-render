import { describe, expect, it } from "vitest";

import {
  SenderIdentityError,
  normalizeIMessageSender,
} from "../../../src/transport/sender-identity.js";

describe("iMessage sender identity", () => {
  it("normalizes E.164-compatible phone formatting", () => {
    expect(
      normalizeIMessageSender({
        id: "unused",
        address: "tel:+1 (415) 555-0100",
        service: "iMessage",
      }),
    ).toEqual({
      address: "+14155550100",
      kind: "phone",
      service: "iMessage",
    });
  });

  it("normalizes email casing and falls back to sender id", () => {
    expect(
      normalizeIMessageSender({ id: "Owner@Example.COM", service: "unknown" }),
    ).toEqual({
      address: "owner@example.com",
      kind: "email",
      service: "unknown",
    });
  });

  it("rejects missing and ambiguous addresses without echoing their value", () => {
    expect(() => normalizeIMessageSender(undefined)).toThrowError(
      expect.objectContaining<Partial<SenderIdentityError>>({
        code: "SPECTRUM_SENDER_MISSING",
      }),
    );

    const invalid = "+14155550100 extension secret";
    expect(() => normalizeIMessageSender({ id: invalid })).toThrowError(
      expect.objectContaining<Partial<SenderIdentityError>>({
        code: "SPECTRUM_SENDER_INVALID",
      }),
    );

    try {
      normalizeIMessageSender({ id: invalid });
    } catch (error) {
      expect(String(error)).not.toContain(invalid);
    }
  });
});
