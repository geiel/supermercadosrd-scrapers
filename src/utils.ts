export function randomDelay(min = 1000, max = 2000): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export function isLessThan12HoursAgo(date: Date): boolean {
  const now = new Date();
  const twelveHoursInMs = 12 * 60 * 60 * 1000;
  return now.getTime() - date.getTime() < twelveHoursInMs;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  );

  return results;
}
