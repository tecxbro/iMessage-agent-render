export const SPECTRUM_CONNECTION_STATES = [
  "starting",
  "connected",
  "degraded",
  "stopped",
] as const;

export type SpectrumConnectionState =
  (typeof SPECTRUM_CONNECTION_STATES)[number];

export const SPECTRUM_FAILURE_CODES = [
  "SPECTRUM_STREAM_DISCONNECTED",
  "SPECTRUM_STREAM_RESTART_EXHAUSTED",
] as const;

export type SpectrumFailureCode = (typeof SPECTRUM_FAILURE_CODES)[number];

export interface SpectrumReadinessSnapshot {
  component: "spectrum";
  ready: boolean;
  state: SpectrumConnectionState;
  failureCode?: SpectrumFailureCode;
  restartAttempt?: number;
}

/**
 * Holds only operator-safe Spectrum health metadata. Raw errors, credentials,
 * phone numbers, and space identifiers never enter the readiness snapshot.
 */
export class SpectrumReadiness {
  #snapshot: SpectrumReadinessSnapshot = {
    component: "spectrum",
    ready: false,
    state: "stopped",
  };

  public markStarting(restartAttempt = 0): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "starting",
      ...(restartAttempt > 0 ? { restartAttempt } : {}),
    };
  }

  public markConnected(): void {
    this.#snapshot = {
      component: "spectrum",
      ready: true,
      state: "connected",
    };
  }

  public markDegraded(
    failureCode: SpectrumFailureCode,
    restartAttempt: number,
  ): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "degraded",
      failureCode,
      restartAttempt,
    };
  }

  public markStopped(): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "stopped",
    };
  }

  public snapshot(): Readonly<SpectrumReadinessSnapshot> {
    return { ...this.#snapshot };
  }
}
