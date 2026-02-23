import { scrapePrice } from "./scrape-price.js";
import { error } from "./result.js";
import { randomDelay } from "./utils.js";
import type {
  ScrapeManyOptions,
  ScrapePriceInput,
  ScrapePriceResult,
  ShopId,
} from "./types.js";

export async function scrapeManyRoundRobin(
  inputs: ScrapePriceInput[],
  options: ScrapeManyOptions = {}
): Promise<ScrapePriceResult[]> {
  const byShop = new Map<ShopId, Array<{ index: number; input: ScrapePriceInput }>>();

  for (const [index, input] of inputs.entries()) {
    const list = byShop.get(input.shopId) ?? [];
    list.push({ index, input });
    byShop.set(input.shopId, list);
  }

  const maxRounds = Math.max(
    0,
    ...Array.from(byShop.values()).map((list) => list.length)
  );
  const results: Array<ScrapePriceResult | undefined> = new Array(inputs.length);
  let processed = 0;

  const delayMinMs = options.delayMinMs ?? 600;
  const delayMaxMs = options.delayMaxMs ?? 1200;

  for (let round = 0; round < maxRounds; round += 1) {
    const roundBatch: Array<{ index: number; input: ScrapePriceInput }> = [];

    for (const list of byShop.values()) {
      const candidate = list[round];
      if (candidate) {
        roundBatch.push(candidate);
      }
    }

    if (roundBatch.length === 0) {
      break;
    }

    const roundResults = await Promise.all(
      roundBatch.map(({ input }) => scrapePrice(input, options.requestConfig))
    );
    for (let i = 0; i < roundBatch.length; i += 1) {
      const { index } = roundBatch[i];
      if (!results[index]) {
        processed += 1;
      }
      results[index] = roundResults[i];
    }

    options.onProgress?.({
      round: round + 1,
      totalRounds: maxRounds,
      processed,
      total: inputs.length,
    });

    if (round < maxRounds - 1) {
      await randomDelay(delayMinMs, delayMaxMs);
    }
  }

  return results.map((result, index) => {
    if (result) {
      return result;
    }

    return error(inputs[index].shopId, "not_processed", true);
  });
}
