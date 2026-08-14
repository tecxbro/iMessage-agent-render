import { z } from "zod";
import { imessage } from "spectrum-ts/providers/imessage";

import type { SpectrumApp } from "./spectrum.js";

export type SpectrumLineMode =
  | "shared"
  | "single-dedicated"
  | "multiple-dedicated";

export interface SpectrumLineCapabilities {
  supportsGroupCreation: boolean;
  supportsInboundGroupEvents: boolean;
  requiresRoutePhoneForRestart: boolean;
}

export function capabilitiesForLineMode(
  mode: SpectrumLineMode,
): SpectrumLineCapabilities {
  return {
    supportsGroupCreation: mode !== "shared",
    supportsInboundGroupEvents: mode !== "shared",
    requiresRoutePhoneForRestart: mode === "multiple-dedicated",
  };
}

export interface PersistedSpaceRoute {
  spaceGuid: string;
  spaceType: "dm" | "group";
  routePhone?: string;
}

const spaceSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(["dm", "group"]),
    phone: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type SpaceResolutionErrorCode =
  | "SPECTRUM_ROUTE_PHONE_REQUIRED"
  | "SPECTRUM_SPACE_REHYDRATION_FAILED";

export class SpaceResolutionError extends Error {
  public readonly code: SpaceResolutionErrorCode;

  public constructor(code: SpaceResolutionErrorCode) {
    super(
      code === "SPECTRUM_ROUTE_PHONE_REQUIRED"
        ? "Cannot rehydrate this iMessage space because its route phone is missing while multiple dedicated lines are configured. Restore the persisted route phone before retrying."
        : "Spectrum could not rehydrate the persisted iMessage space. Verify the stored space GUID and route phone, then retry.",
    );
    this.name = "SpaceResolutionError";
    this.code = code;
  }
}

export function persistedRouteFromIMessageSpace(
  space: unknown,
): PersistedSpaceRoute {
  const result = spaceSchema.safeParse(space);
  if (!result.success) {
    throw new SpaceResolutionError("SPECTRUM_SPACE_REHYDRATION_FAILED");
  }

  return {
    spaceGuid: result.data.id,
    spaceType: result.data.type,
    ...(result.data.phone === undefined
      ? {}
      : { routePhone: result.data.phone }),
  };
}

export interface IMessageSpaceNamespace<Space> {
  get(spaceGuid: string, params?: { phone?: string }): Promise<Space>;
}

export interface SpaceResolverOptions {
  requireRoutePhone?: boolean;
}

function providerRequiresRoutePhone(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("space.get requires params.phone")
  );
}

export class SpaceResolver<Space> {
  readonly #namespace: IMessageSpaceNamespace<Space>;
  readonly #requireRoutePhone: boolean;

  public constructor(
    namespace: IMessageSpaceNamespace<Space>,
    options: SpaceResolverOptions = {},
  ) {
    this.#namespace = namespace;
    this.#requireRoutePhone = options.requireRoutePhone ?? false;
  }

  public async resolve(route: PersistedSpaceRoute): Promise<Space> {
    if (this.#requireRoutePhone && route.routePhone === undefined) {
      throw new SpaceResolutionError("SPECTRUM_ROUTE_PHONE_REQUIRED");
    }

    try {
      return route.routePhone === undefined
        ? await this.#namespace.get(route.spaceGuid)
        : await this.#namespace.get(route.spaceGuid, {
            phone: route.routePhone,
          });
    } catch (error) {
      if (error instanceof SpaceResolutionError) {
        throw error;
      }

      if (providerRequiresRoutePhone(error)) {
        throw new SpaceResolutionError("SPECTRUM_ROUTE_PHONE_REQUIRED");
      }

      // Provider failures can include configured route phone numbers. Keep the
      // raw exception out of this operator-facing boundary.
      throw new SpaceResolutionError("SPECTRUM_SPACE_REHYDRATION_FAILED");
    }
  }
}

export function createSpectrumSpaceResolver(
  app: SpectrumApp,
  options: SpaceResolverOptions = {},
) {
  return new SpaceResolver(imessage(app).space, options);
}
