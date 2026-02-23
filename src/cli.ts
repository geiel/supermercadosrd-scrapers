#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { scrapeManyRoundRobin } from "./scrape-many.js";
import type { ScrapePriceInput } from "./types.js";

type CliInput = ScrapePriceInput & {
  id?: string | number;
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args.set(token, "true");
      continue;
    }

    args.set(token, value);
    i += 1;
  }

  return {
    input: args.get("--input"),
    output: args.get("--output"),
    delayMinMs: Number(args.get("--delay-min") ?? 600),
    delayMaxMs: Number(args.get("--delay-max") ?? 1200),
    timeoutMs: Number(args.get("--timeout") ?? 10000),
    maxRetries: Number(args.get("--retries") ?? 3),
  };
}

function validateInput(value: unknown): CliInput[] {
  if (!Array.isArray(value)) {
    throw new Error("input file must be a JSON array");
  }

  return value.map((entry, index) => {
    const row = entry as Partial<CliInput>;

    if (
      typeof row.shopId !== "number" ||
      ![1, 2, 3, 4, 5, 6].includes(row.shopId)
    ) {
      throw new Error(`row ${index} has invalid shopId`);
    }

    if (typeof row.url !== "string" || row.url.length === 0) {
      throw new Error(`row ${index} has invalid url`);
    }

    return {
      id: row.id,
      shopId: row.shopId,
      url: row.url,
      api: row.api ?? null,
    };
  });
}

async function main() {
  const { input, output, delayMinMs, delayMaxMs, timeoutMs, maxRetries } =
    parseArgs(process.argv.slice(2));

  if (!input) {
    console.error("Usage: pnpm scrape --input ./data/products.json --output ./out/results.json");
    process.exit(1);
  }

  const raw = await readFile(input, "utf8");
  const payload = validateInput(JSON.parse(raw));

  const results = await scrapeManyRoundRobin(payload, {
    delayMinMs,
    delayMaxMs,
    requestConfig: {
      timeoutMs,
      maxRetries,
    },
    onProgress: ({ round, totalRounds, processed, total }) => {
      console.log(
        `[scrape] round ${round}/${totalRounds} processed=${processed}/${total}`
      );
    },
  });

  const merged = results.map((result, index) => ({
    id: payload[index]?.id ?? null,
    url: payload[index]?.url,
    api: payload[index]?.api ?? null,
    ...result,
  }));

  const outputData = JSON.stringify(merged, null, 2);

  if (output) {
    await writeFile(output, outputData, "utf8");
    console.log(`[scrape] wrote ${merged.length} rows to ${output}`);
    return;
  }

  process.stdout.write(`${outputData}\n`);
}

void main().catch((error) => {
  console.error("[scrape] fatal error", error);
  process.exit(1);
});
