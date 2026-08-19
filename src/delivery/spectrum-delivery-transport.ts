import type { ClaimBoundDeliveryTransportPort } from "./delivery-coordinator.js";

export interface NativeSpectrumDeliverySender {
  send(input: {
    spaceId: string;
    clientGuid: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null }>;
}

/**
 * Adapts the single native Spectrum sender to the delivery coordinator's
 * claim-bound receipt contract. The token stays at the coordinator boundary;
 * Spectrum 12.7 has no public claim-token or caller-GUID send parameter.
 */
export class SpectrumDeliveryTransport
  implements ClaimBoundDeliveryTransportPort
{
  readonly #sender: NativeSpectrumDeliverySender;
  readonly #now: () => Date;

  public constructor(
    sender: NativeSpectrumDeliverySender,
    now: () => Date = () => new Date(),
  ) {
    this.#sender = sender;
    this.#now = now;
  }

  public async send(input: {
    spaceId: string;
    clientGuid: string;
    claimToken: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null; sentAt: Date }> {
    if (input.claimToken.length === 0) {
      throw new Error(
        "Spectrum delivery requires the live database claim token.",
      );
    }
    input.signal.throwIfAborted();
    const receipt = await this.#sender.send({
      spaceId: input.spaceId,
      clientGuid: input.clientGuid,
      text: input.text,
      signal: input.signal,
    });
    return { ...receipt, sentAt: this.#now() };
  }
}
