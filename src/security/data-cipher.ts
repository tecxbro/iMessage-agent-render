import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const DATA_CIPHER_DOMAIN = Buffer.from("imessage-agent-data-v1", "utf8");

export interface DataCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

function keyBytes(key: string): Buffer {
  if (/^[a-f0-9]{64}$/iu.test(key)) {
    return Buffer.from(key, "hex");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error("Application encryption key must be 32-byte hex or base64.");
  }
  return decoded;
}

/** Authenticated envelope used for retained message, route, and thread text. */
export function createDataCipher(key: string): DataCipher {
  const bytes = keyBytes(key);
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", bytes, nonce);
      cipher.setAAD(DATA_CIPHER_DOMAIN);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext) {
      const [version, nonce, tag, payload, extra] = ciphertext.split(".");
      if (
        version !== "v1" ||
        nonce === undefined ||
        tag === undefined ||
        payload === undefined ||
        extra !== undefined
      ) {
        throw new Error("Stored application data has an unsupported envelope.");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          bytes,
          Buffer.from(nonce, "base64url"),
        );
        decipher.setAAD(DATA_CIPHER_DOMAIN);
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(payload, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        throw new Error(
          "Stored application data failed authenticated decryption.",
          { cause: error },
        );
      }
    },
  };
}
