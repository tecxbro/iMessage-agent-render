import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../client.js";
import { spaces } from "../schema.js";

const identifierSchema = z.uuid();
const threadIdSchema = z.string().trim().min(1).max(512);

/** Durable one-thread-per-space pointer for the direct conversation actor. */
export class ConversationThreadRepository {
  public constructor(private readonly database: Database) {}

  public async load(spaceId: string): Promise<string | null> {
    const parsedSpaceId = identifierSchema.parse(spaceId);
    const [space] = await this.database
      .select({ threadId: spaces.interactionThreadId })
      .from(spaces)
      .where(eq(spaces.id, parsedSpaceId))
      .limit(1);
    if (space === undefined) {
      throw new Error(
        "The interaction space is missing. Restore it before starting Codex.",
      );
    }
    return space.threadId === null
      ? null
      : threadIdSchema.parse(space.threadId);
  }

  public async store(spaceId: string, threadId: string): Promise<void> {
    const parsedSpaceId = identifierSchema.parse(spaceId);
    const parsedThreadId = threadIdSchema.parse(threadId);
    const updated = await this.database
      .update(spaces)
      .set({ interactionThreadId: parsedThreadId, updatedAt: new Date() })
      .where(eq(spaces.id, parsedSpaceId))
      .returning({ id: spaces.id });
    if (updated.length !== 1) {
      throw new Error(
        "The interaction thread pointer could not be persisted. Restore the space before retrying the turn.",
      );
    }
  }
}
