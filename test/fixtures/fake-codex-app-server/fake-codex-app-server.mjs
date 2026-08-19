#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const statePath = join(process.cwd(), "fake-codex-app-server-state.json");

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { pids: [], requests: [], serverResponses: [], threads: {} };
  }
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function update(mutator) {
  const state = readState();
  mutator(state);
  writeState(state);
  return state;
}

update((state) => {
  state.pids.push(process.pid);
});

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notification(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function minimalThread(thread) {
  return {
    id: thread.id,
    turns: thread.turns,
  };
}

function userInputText(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  return input
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function appendUserMessage(turn, params) {
  turn.items.push({
    type: "userMessage",
    id: `item-${turn.items.length + 1}`,
    clientId:
      typeof params?.clientUserMessageId === "string"
        ? params.clientUserMessageId
        : null,
    content: Array.isArray(params?.input) ? params.input : [],
  });
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.method === undefined && message.id !== undefined) {
      update((state) => state.serverResponses.push(message));
      continue;
    }

    update((state) =>
      state.requests.push({ method: message.method, params: message.params }),
    );
    if (message.id === undefined) continue;

    if (message.method === "initialize") {
      response(message.id, {
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: process.platform,
        userAgent: "fake-codex-app-server/0.147.0",
      });
      continue;
    }
    if (message.method === "account/read") {
      response(message.id, {
        account: { type: "chatgpt", email: null, planType: "plus" },
        requiresOpenaiAuth: true,
      });
      continue;
    }
    if (message.method === "model/list") {
      response(message.id, {
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "Fixture" },
            ],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
        ],
        nextCursor: null,
      });
      continue;
    }
    if (message.method === "thread/start") {
      const threadId = `thread-${Date.now()}-${message.id}`;
      const state = update((stored) => {
        stored.threads[threadId] = { id: threadId, turns: [] };
      });
      response(message.id, { thread: minimalThread(state.threads[threadId]) });
      continue;
    }
    if (message.method === "thread/resume") {
      const state = readState();
      const thread = state.threads[message.params.threadId];
      response(message.id, { thread: minimalThread(thread) });
      continue;
    }
    if (message.method === "thread/read") {
      const state = readState();
      const thread = state.threads[message.params.threadId];
      response(message.id, { thread: minimalThread(thread) });
      continue;
    }
    if (message.method === "turn/start") {
      const turnId = `turn-${Date.now()}-${message.id}`;
      const state = update((stored) => {
        const thread = stored.threads[message.params.threadId];
        const turn = {
          id: turnId,
          status: "inProgress",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: Date.now() / 1_000,
          completedAt: null,
          durationMs: null,
        };
        appendUserMessage(turn, message.params);
        thread.turns.push(turn);
      });
      const turn = state.threads[message.params.threadId].turns.at(-1);
      response(message.id, { turn });
      notification("turn/started", {
        threadId: message.params.threadId,
        turn,
      });
      continue;
    }
    if (message.method === "turn/steer") {
      const text = userInputText(message.params);
      if (!text.includes("fixture-absent-steer")) {
        update((stored) => {
          const thread = stored.threads[message.params.threadId];
          const turn = thread.turns.find(
            (candidate) => candidate.id === message.params.expectedTurnId,
          );
          appendUserMessage(turn, message.params);
        });
      }
      if (
        text.includes("fixture-accepted-steer") ||
        text.includes("fixture-absent-steer")
      ) {
        process.exit(0);
      }
      response(message.id, { turnId: message.params.expectedTurnId });
      continue;
    }
    if (message.method === "turn/interrupt") {
      update((stored) => {
        const thread = stored.threads[message.params.threadId];
        const turn = thread.turns.find(
          (candidate) => candidate.id === message.params.turnId,
        );
        turn.status = "interrupted";
      });
      response(message.id, {});
      continue;
    }
    if (message.method === "fixture/serverRequest") {
      process.stdout.write(
        `${JSON.stringify({
          id: message.params.serverRequestId ?? "server-request-1",
          method: message.params.method,
          params: message.params.params ?? {},
        })}\n`,
      );
      response(message.id, { emitted: true });
      continue;
    }
    response(message.id, {});
  }
});

process.on("SIGTERM", () => process.exit(0));
