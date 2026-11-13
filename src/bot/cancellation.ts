const activeRequests = new Map<number, AbortController>();

export function startRequest(chatId: number): AbortController {
  // Cancel any previous request for this chat.
  activeRequests.get(chatId)?.abort();

  const controller = new AbortController();
  activeRequests.set(chatId, controller);

  return controller;
}

export function cancelRequest(chatId: number): boolean {
  const controller = activeRequests.get(chatId);

  if (!controller) {
    return false;
  }

  controller.abort();
  activeRequests.delete(chatId);
  return true;
}

export function finishRequest(
  chatId: number,
  controller: AbortController,
): void {
  // Don't remove a newer request that replaced this one.
  if (activeRequests.get(chatId) === controller) {
    activeRequests.delete(chatId);
  }
}

let shuttingDown = false;

/** True once the bot is stopping: aborted work is then left for the retry after the restart. */
export const isShuttingDown = (): boolean => shuttingDown;

/**
 * Stops every running request because the bot is shutting down. Their
 * updates stay "received" in the inbox and are answered after the restart;
 * the students are not told "cancelled".
 */
export function abortAllForShutdown(): void {
  shuttingDown = true;
  for (const controller of activeRequests.values()) controller.abort("shutdown");
  activeRequests.clear();
}
