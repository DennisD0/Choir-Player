let tail: Promise<void> = Promise.resolve();

/** Serialize memory-heavy Audiveris jobs while keeping uploads asynchronous. */
export function enqueueOmr<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
