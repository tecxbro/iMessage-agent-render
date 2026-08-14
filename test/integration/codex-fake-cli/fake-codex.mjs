#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const inputChunks = [];
for await (const chunk of process.stdin) {
  inputChunks.push(chunk);
}
const input = Buffer.concat(inputChunks).toString("utf8");

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const configValues = args.flatMap((argument, index) =>
  args[index - 1] === "--config" ? [argument] : [],
);
const effort = configValues
  .find((value) => value.startsWith("model_reasoning_effort="))
  ?.split("=")[1]
  ?.replaceAll('"', "");
const model = valueAfter("--model");
const resumeIndex = args.indexOf("resume");
const resumedThreadId = resumeIndex < 0 ? undefined : args[resumeIndex + 1];
const capturePath = process.env["AGENT_TASK_FAKE_CAPTURE_PATH"];
const terminationPath = process.env["AGENT_TASK_FAKE_TERMINATION_PATH"];
const shouldSleep =
  process.env["AGENT_TASK_FAKE_MODE"] === "sleep" ||
  input.includes("FAKE_MODE:SLEEP");

if (shouldSleep) {
  const terminate = () => {
    if (terminationPath !== undefined) {
      appendFileSync(terminationPath, "terminated\n");
    }
    process.exit(143);
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
}

if (capturePath !== undefined) {
  appendFileSync(
    capturePath,
    `${JSON.stringify({
      args,
      envKeys: Object.keys(process.env).sort(),
      apiKeysMatch:
        process.env["OPENAI_API_KEY"] === process.env["CODEX_API_KEY"],
      inputBytes: Buffer.byteLength(input, "utf8"),
      outputSchemaExists:
        valueAfter("--output-schema") === undefined
          ? false
          : existsSync(valueAfter("--output-schema")),
    })}\n`,
  );
}

if (resumedThreadId === "missing-session") {
  process.stderr.write("Codex session not found\n");
  process.exit(2);
}
if (process.env["AGENT_TASK_FAKE_UNSUPPORTED_MODEL"] === model) {
  process.stderr.write(`model ${model} unsupported\n`);
  process.exit(2);
}
if (process.env["AGENT_TASK_FAKE_UNSUPPORTED_EFFORT"] === effort) {
  process.stderr.write(`reasoning effort ${effort} unsupported\n`);
  process.exit(2);
}
if (process.env["AGENT_TASK_FAKE_AUTH_FAILURE"] === "true") {
  process.stderr.write("authentication login required\n");
  process.exit(2);
}

if (shouldSleep) {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

let response;
switch (process.env["AGENT_TASK_FAKE_MODE"]) {
  case "malformed":
    response = "not-json";
    break;
  case "oversized":
    response = JSON.stringify({ value: "x".repeat(100_000) });
    break;
  default:
    response = process.env["AGENT_TASK_FAKE_RESPONSE_JSON"] ?? '{"ok":true}';
    break;
}

const threadId = resumedThreadId ?? "fake-thread-new";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
emit({
  type: "item.completed",
  item: { id: "message-1", type: "agent_message", text: response },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 3,
    reasoning_output_tokens: 0,
  },
});
