#!/usr/bin/env node

import { closeDb } from "../db/client.js";
import { parseRitmoPriceCsv } from "../ritmo/price-csv.js";
import { applyRitmoSftpPriceSync } from "../ritmo/price-sync.js";
import {
  downloadRitmoSftpCsv,
  listRitmoSftpCsvFiles,
  type RitmoSftpConfig,
} from "../ritmo/sftp.js";

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

  return args;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || undefined;
}

function requiredEnv(names: string[]) {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value) {
      return value;
    }
  }

  throw new Error(`${names.join(" or ")} is required`);
}

function parseNumber(value: string | undefined, fallback: number, label: string) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${label}: ${value}`);
  }

  return parsed;
}

function isEnabled(value: string | undefined) {
  return value === "true" || value === "1" || value === "yes";
}

function getSftpConfig(args: Map<string, string>): RitmoSftpConfig {
  return {
    host:
      args.get("--host") ??
      optionalEnv("RITMO_SFTP_HOST") ??
      optionalEnv("SFTP_HOST") ??
      "76.13.108.74",
    port: parseNumber(
      args.get("--port") ?? optionalEnv("RITMO_SFTP_PORT") ?? optionalEnv("SFTP_PORT"),
      2222,
      "SFTP port"
    ),
    username:
      args.get("--username") ??
      optionalEnv("RITMO_SFTP_USERNAME") ??
      optionalEnv("SFTP_USERNAME") ??
      "ritmo",
    password: requiredEnv([
      "SFPT_PASSWORD",
      "SFTP_PASSWORD",
      "RITMO_SFTP_PASSWORD",
    ]),
    remoteDir:
      args.get("--remote-dir") ??
      optionalEnv("RITMO_SFTP_DIR") ??
      optionalEnv("SFTP_REMOTE_DIR") ??
      "/upload",
    readyTimeoutMs: parseNumber(
      args.get("--ready-timeout") ?? optionalEnv("RITMO_SFTP_READY_TIMEOUT"),
      20000,
      "SFTP ready timeout"
    ),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getSftpConfig(args);
  const dryRun = isEnabled(args.get("--dry-run"));
  const remoteFile = args.get("--remote-file");

  if (args.has("--list")) {
    const files = await listRitmoSftpCsvFiles(config);
    for (const file of files) {
      console.log(
        `[FILE] name=${file.name} size=${file.size} modified=${new Date(file.modifyTime).toISOString()}`
      );
    }
    return;
  }

  console.log(
    `[INFO] Downloading Ritmo CSV from ${config.host}:${config.port}${config.remoteDir}`
  );
  const download = await downloadRitmoSftpCsv(config, remoteFile);
  console.log(
    `[INFO] Downloaded ${download.file.name} (${download.content.length} bytes)`
  );

  const parsed = parseRitmoPriceCsv(download.content);
  const duplicateMessage =
    parsed.duplicateSkus.length > 0
      ? ` duplicateSkus=${parsed.duplicateSkus.length}`
      : "";

  console.log(`[INFO] Parsed ${parsed.rows.length} unique rows${duplicateMessage}`);

  const summary = await applyRitmoSftpPriceSync({
    rows: parsed.rows,
    dryRun,
  });

  console.log(JSON.stringify(summary, null, 2));
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ERROR] Ritmo SFTP price sync failed", err);
    await closeDb();
    process.exit(1);
  });
