import { describe, expect, it } from "vitest";

import { createDataCipher } from "../../src/security/data-cipher.js";

describe("application data cipher", () => {
  it("round-trips text without deterministic ciphertext", () => {
    const cipher = createDataCipher("11".repeat(32));
    const first = cipher.encrypt("private message");
    const second = cipher.encrypt("private message");

    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe("private message");
    expect(cipher.decrypt(second)).toBe("private message");
  });

  it("rejects tampered envelopes", () => {
    const cipher = createDataCipher(Buffer.alloc(32, 7).toString("base64"));
    const encrypted = cipher.encrypt("private message");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => cipher.decrypt(tampered)).toThrow(
      /failed authenticated decryption/i,
    );
  });
});
