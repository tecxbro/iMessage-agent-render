import type { NativeSpectrumDeliverySender } from "../delivery/spectrum-delivery-transport.js";

/** One-time workers target this stable port while Spectrum intake swaps runs. */
export class RestartableOutboundTransport
  implements NativeSpectrumDeliverySender
{
  #runId: string | undefined;
  #delegate: NativeSpectrumDeliverySender | undefined;

  public attach(runId: string, delegate: NativeSpectrumDeliverySender): void {
    if (this.#runId !== undefined && this.#runId !== runId) {
      throw new Error("A second Spectrum outbound transport cannot become active.");
    }
    this.#runId = runId;
    this.#delegate = delegate;
  }

  public detach(runId: string): void {
    if (this.#runId !== runId) return;
    this.#runId = undefined;
    this.#delegate = undefined;
  }

  public async send(request: {
    spaceId: string;
    clientGuid: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null }> {
    const delegate = this.#delegate;
    if (delegate === undefined) {
      throw new Error(
        "Spectrum intake is inactive; retain the durable outbound job for recovery.",
      );
    }
    return await delegate.send(request);
  }
}
