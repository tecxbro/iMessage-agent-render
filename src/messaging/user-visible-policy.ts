const hiddenImplementationLanguage =
  /(?:\b(?:sub[ -]?agent|worker name|agentName|threadId|jobId|raw (?:codex )?events?|unrestricted logs?|reasoning tokens?|chain[- ]of[- ]thought)\b|\b(?:turn\.plan|task\.execute|turn\.synthesize|inbound\.flush|outbound\.send)\b|\bgpt-[a-z0-9.-]+\b)/iu;

export function assertUserFacingMessageSafe(
  message: string,
  hiddenNames: readonly string[] = [],
): void {
  if (hiddenImplementationLanguage.test(message)) {
    throw new Error(
      "The user-facing response contains hidden orchestration or model details. Rewrite it in plain outcome-focused language before sending.",
    );
  }
  const normalized = message.toLocaleLowerCase("en-US");
  if (
    hiddenNames.some((name) => {
      const candidate = name.trim().toLocaleLowerCase("en-US");
      return candidate.length > 0 && normalized.includes(candidate);
    })
  ) {
    throw new Error(
      "The user-facing response exposes an internal named execution context. Describe the finding without the hidden name.",
    );
  }
}
