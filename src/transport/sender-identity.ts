import { z } from "zod";

export const IMESSAGE_SERVICES = [
  "iMessage",
  "SMS",
  "RCS",
  "unknown",
] as const;

export type IMessageService = (typeof IMESSAGE_SERVICES)[number];

export interface NormalizedSenderIdentity {
  address: string;
  kind: "email" | "phone";
  service: IMessageService;
}

export type SenderIdentityErrorCode =
  | "SPECTRUM_SENDER_MISSING"
  | "SPECTRUM_SENDER_INVALID";

export class SenderIdentityError extends Error {
  public readonly code: SenderIdentityErrorCode;

  public constructor(code: SenderIdentityErrorCode) {
    super(
      code === "SPECTRUM_SENDER_MISSING"
        ? "Spectrum delivered a message without a sender. Ignore the event and inspect the provider connection."
        : "Spectrum delivered an invalid iMessage sender address. Ignore the event and inspect the provider connection.",
    );
    this.name = "SenderIdentityError";
    this.code = code;
  }
}

const senderSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    address: z.string().trim().min(1).optional(),
    service: z.enum(IMESSAGE_SERVICES).optional(),
  })
  .passthrough();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const e164Pattern = /^\+[1-9]\d{7,14}$/u;

function normalizeAddress(rawAddress: string): Pick<
  NormalizedSenderIdentity,
  "address" | "kind"
> {
  const withoutScheme = rawAddress
    .trim()
    .replace(/^mailto:/iu, "")
    .replace(/^tel:/iu, "");

  if (emailPattern.test(withoutScheme)) {
    return { address: withoutScheme.toLowerCase(), kind: "email" };
  }

  const phone = withoutScheme.replace(/[\s().-]/gu, "");
  if (e164Pattern.test(phone)) {
    return { address: phone, kind: "phone" };
  }

  throw new SenderIdentityError("SPECTRUM_SENDER_INVALID");
}

/** Validates and normalizes the provider sender before authorization handoff. */
export function normalizeIMessageSender(
  sender: unknown,
): NormalizedSenderIdentity {
  if (sender === undefined || sender === null) {
    throw new SenderIdentityError("SPECTRUM_SENDER_MISSING");
  }

  const result = senderSchema.safeParse(sender);
  if (!result.success) {
    throw new SenderIdentityError("SPECTRUM_SENDER_INVALID");
  }

  const candidate = result.data.address ?? result.data.id;
  if (candidate === undefined) {
    throw new SenderIdentityError("SPECTRUM_SENDER_MISSING");
  }

  return {
    ...normalizeAddress(candidate),
    service: result.data.service ?? "unknown",
  };
}
