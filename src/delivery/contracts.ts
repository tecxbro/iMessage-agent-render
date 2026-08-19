import type { OutboundCoordinatePayload } from "../queue/payloads.js";

export interface DeliveryClaim {
  outboundBatchId: string;
  spaceId: string;
  claimOwner: string;
  claimToken: string;
  claimExpiresAt: Date;
  position: number;
  clientGuid: string;
  text: string;
}

export interface DeliveryCheckpoint {
  batchComplete: boolean;
  nextIndex: number;
}

export interface DeliveryRepositoryPort {
  claimNext(input: {
    outboundBatchId: string;
    claimOwner: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<DeliveryClaim | null>;
  checkpointSent(input: {
    outboundBatchId: string;
    claimToken: string;
    position: number;
    externalMessageId: string | null;
    sentAt: Date;
  }): Promise<DeliveryCheckpoint>;
  release(input: {
    outboundBatchId: string;
    claimToken: string;
    now: Date;
  }): Promise<void>;
}

export interface DeliveryTransportPort {
  send(input: {
    spaceId: string;
    clientGuid: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null; sentAt: Date }>;
}

export interface DeliveryWakePublisherPort {
  publish(payload: OutboundCoordinatePayload): Promise<void>;
}

export interface DeliveryCoordinatorPort {
  coordinate(
    payload: OutboundCoordinatePayload,
    signal: AbortSignal,
  ): Promise<void>;
}
