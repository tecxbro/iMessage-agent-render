import { z } from "zod";

import type { PersistedSpaceRoute, SpaceResolver } from "./space-resolver.js";

export const STABLE_GUID_OPERATOR_GUIDANCE =
  "The pinned spectrum-ts provider does not expose a public caller-supplied client GUID on space.send(). Do not bypass Spectrum internals or silently send without deduplication. Wire a native stable-GUID sender only when the public provider API supports it.";

export type OutboundTransportErrorCode =
  | "SPECTRUM_STABLE_CLIENT_GUID_UNAVAILABLE"
  | "SPECTRUM_OUTBOUND_BATCH_INVALID";

export class OutboundTransportError extends Error {
  public readonly code: OutboundTransportErrorCode;

  public constructor(code: OutboundTransportErrorCode, cause?: unknown) {
    super(
      code === "SPECTRUM_STABLE_CLIENT_GUID_UNAVAILABLE"
        ? `Durable Spectrum delivery is unavailable. ${STABLE_GUID_OPERATOR_GUIDANCE}`
        : "The outbound Spectrum batch is invalid. Rebuild it from authoritative database state before retrying.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "OutboundTransportError";
    this.code = code;
  }
}

export interface OutboundBubble {
  clientGuid: string;
  text: string;
}

export interface OutboundBatch {
  bubbles: readonly OutboundBubble[];
  route: PersistedSpaceRoute;
  startIndex: number;
}

export interface RespondingSpace {
  responding<Result>(callback: () => Result | Promise<Result>): Promise<Result>;
}

/**
 * Capability boundary for a future public Spectrum provider send primitive
 * that accepts a caller-supplied stable GUID. No 12.7.0 implementation is
 * provided because adapting the private client would violate the native API
 * boundary and make restarts unsafe.
 */
export interface NativeStableGuidSender<Space> {
  sendText(
    space: Space,
    input: Readonly<OutboundBubble>,
  ): Promise<{ externalMessageId?: string } | undefined>;
}

export interface OutboundTransportOptions<Space extends RespondingSpace> {
  resolver: SpaceResolver<Space>;
  stableGuidSender?: NativeStableGuidSender<Space>;
}

const outboundBatchSchema = z
  .object({
    bubbles: z
      .array(
        z
          .object({
            clientGuid: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9._:-]+$/u),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    route: z
      .object({
        spaceGuid: z.string().trim().min(1),
        spaceType: z.enum(["dm", "group"]),
        routePhone: z.string().trim().min(1).optional(),
      })
      .strict(),
    startIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.startIndex > batch.bubbles.length) {
      context.addIssue({
        code: "custom",
        path: ["startIndex"],
        message: "startIndex must not exceed the number of bubbles",
      });
    }

    const seen = new Set<string>();
    for (const [index, bubble] of batch.bubbles.entries()) {
      if (seen.has(bubble.clientGuid)) {
        context.addIssue({
          code: "custom",
          path: ["bubbles", index, "clientGuid"],
          message: "clientGuid values must be unique within a batch",
        });
      }
      seen.add(bubble.clientGuid);
    }
  });

export class OutboundTransport<Space extends RespondingSpace> {
  readonly #resolver: SpaceResolver<Space>;
  readonly #stableGuidSender: NativeStableGuidSender<Space> | undefined;

  public constructor(options: OutboundTransportOptions<Space>) {
    this.#resolver = options.resolver;
    this.#stableGuidSender = options.stableGuidSender;
  }

  public async sendBatch(
    candidate: OutboundBatch,
    advanceCursor: (nextIndex: number) => Promise<void>,
  ): Promise<void> {
    const result = outboundBatchSchema.safeParse(candidate);
    if (!result.success) {
      throw new OutboundTransportError(
        "SPECTRUM_OUTBOUND_BATCH_INVALID",
        result.error,
      );
    }

    if (this.#stableGuidSender === undefined) {
      throw new OutboundTransportError(
        "SPECTRUM_STABLE_CLIENT_GUID_UNAVAILABLE",
      );
    }

    const sender = this.#stableGuidSender;
    const batch = result.data;
    const route: PersistedSpaceRoute = {
      spaceGuid: batch.route.spaceGuid,
      spaceType: batch.route.spaceType,
      ...(batch.route.routePhone === undefined
        ? {}
        : { routePhone: batch.route.routePhone }),
    };
    const space = await this.#resolver.resolve(route);

    await space.responding(async () => {
      for (
        let index = batch.startIndex;
        index < batch.bubbles.length;
        index += 1
      ) {
        const bubble = batch.bubbles[index];
        if (bubble === undefined) {
          throw new OutboundTransportError("SPECTRUM_OUTBOUND_BATCH_INVALID");
        }

        await sender.sendText(space, bubble);
        await advanceCursor(index + 1);
      }
    });
  }
}
