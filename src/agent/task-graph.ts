import {
  executionTaskGraphSchema,
  type ExecutionTask,
} from "./schemas.js";

export const MAXIMUM_EXECUTION_TASKS_PER_TURN = 5;
export const MAXIMUM_EXECUTION_GRAPH_DEPTH = 3;
export const MAXIMUM_SYNTHESIS_ITERATIONS = 1;

/**
 * Returns deterministic topological levels. Tasks in one level are independent
 * and may be enqueued together; later levels wait for their dependencies.
 */
export function executionTaskLevels(input: unknown): ExecutionTask[][] {
  const tasks = executionTaskGraphSchema.parse(input);
  const levelsById = new Map<string, number>();
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const levels: ExecutionTask[][] = [];

  while (remaining.size > 0) {
    const ready = tasks.filter(
      (task) =>
        remaining.has(task.id) &&
        task.dependsOn.every((dependency) => levelsById.has(dependency)),
    );
    if (ready.length === 0) {
      // The schema already detects cycles. Keep this guard so a future schema
      // change cannot turn orchestration into an unbounded scheduling loop.
      throw new Error("The execution task graph contains no runnable level.");
    }
    const level = levels.length;
    for (const task of ready) {
      levelsById.set(task.id, level);
      remaining.delete(task.id);
    }
    levels.push(ready);
  }

  if (levels.length > MAXIMUM_EXECUTION_GRAPH_DEPTH) {
    throw new Error(
      `The execution task graph exceeds depth ${MAXIMUM_EXECUTION_GRAPH_DEPTH}.`,
    );
  }
  return levels;
}
