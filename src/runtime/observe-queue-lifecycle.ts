export interface StoppableQueue {
  stop(): Promise<void>;
}

export interface DisposableActorRegistry {
  dispose(): Promise<void>;
}

/** Queue and observer cleanup start independently; queue failure stays primary. */
export async function stopQueueAndActorRegistry(
  queue: StoppableQueue | undefined,
  registry: DisposableActorRegistry | undefined,
): Promise<void> {
  const [queueResult, registryResult] = await Promise.allSettled([
    queue?.stop(),
    registry?.dispose(),
  ]);
  if (queueResult.status === "rejected") {
    throw queueResult.reason;
  }
  if (registryResult.status === "rejected") {
    throw registryResult.reason;
  }
}
