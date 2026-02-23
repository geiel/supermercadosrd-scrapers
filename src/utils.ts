export function randomDelay(min = 1000, max = 2000): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export function isLessThan12HoursAgo(date: Date): boolean {
  const now = new Date();
  const twelveHoursInMs = 12 * 60 * 60 * 1000;
  return now.getTime() - date.getTime() < twelveHoursInMs;
}
