import type {
  InteractionContext,
  InteractionContextLoaderPort,
} from "./contracts.js";
import type { DataCipher } from "../security/data-cipher.js";
import type { PostgresConversationRepository } from "../db/repositories/conversation-recovery.js";

/** Loads the actor's exact sequenced suffix from PostgreSQL. */
export class DatabaseInteractionContextLoader
  implements InteractionContextLoaderPort
{
  public constructor(
    private readonly repository: Pick<
      PostgresConversationRepository,
      "loadMessagesBySequenceRange" | "loadRecentMessagesBeforeSequence"
    >,
    private readonly cipher: Pick<DataCipher, "decrypt">,
  ) {}

  public async load(input: {
    spaceId: string;
    interactionRunId: string;
    fromSequence: number;
    throughSequence: number;
  }): Promise<InteractionContext> {
    const [rows, historyRows] = await Promise.all([
      this.repository.loadMessagesBySequenceRange({
        spaceId: input.spaceId,
        fromSequence: input.fromSequence,
        throughSequence: input.throughSequence,
      }),
      this.repository.loadRecentMessagesBeforeSequence({
        spaceId: input.spaceId,
        beforeSequence: input.fromSequence,
        limit: 20,
      }),
    ]);
    return {
      ...input,
      messages: rows.map((row) => {
        if (row.contentCiphertext === null) {
          throw new Error(
            "Actor context contains a retained message without encrypted content.",
          );
        }
        return {
          messageId: row.messageId,
          inputSequence: row.inputSequence,
          text: this.cipher.decrypt(row.contentCiphertext),
        };
      }),
      conversationHistory: historyRows.flatMap((row) =>
        row.contentCiphertext === null
          ? []
          : [this.cipher.decrypt(row.contentCiphertext)],
      ),
      taskResults: [],
    };
  }
}
