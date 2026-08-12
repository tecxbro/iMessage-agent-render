/**
 * Photon / Spectrum setup and inbound message handling.
 *
 * Credentials are read from the environment by Spectrum itself:
 * SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, SPECTRUM_WEBHOOK_SECRET.
 * https://photon.codes/docs/spectrum-ts/getting-started
 */
import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Cloud iMessage only — local macOS adapter is intentionally not included.
// https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing
export const photon = await Spectrum({
  providers: [imessage.config()],
});

/**
 * Spectrum webhook handler: reply only to inbound plain text.
 * Narrowing content: https://photon.codes/docs/spectrum-ts/messages
 * Sending: https://photon.codes/docs/spectrum-ts/content/text
 */
export async function onMessage(space: Space, message: Message): Promise<void> {
  // Echoes of our own sends — ignore so we never loop on ourselves.
  if (message.direction === "outbound") return;

  // Skip reactions, typing, reads, attachments, group events, edits, etc.
  if (message.content.type !== "text") return;

  // Native Spectrum API — no sendText / sendReply wrapper.
  await space.send("Hello world 👋");
}
