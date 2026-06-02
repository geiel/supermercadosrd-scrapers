import { posix } from "node:path";
import { Readable } from "node:stream";
import SftpClient, { type FileInfo } from "ssh2-sftp-client";

export type RitmoSftpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  readyTimeoutMs: number;
  maxConnectionAttempts: number;
  retryDelayMs: number;
};

export type RitmoSftpFile = {
  name: string;
  remotePath: string;
  size: number;
  modifyTime: number;
};

export type RitmoSftpDownload = {
  file: RitmoSftpFile;
  content: Buffer;
};

function isCsvFile(file: FileInfo) {
  return file.type === "-" && file.name.toLowerCase().endsWith(".csv");
}

function toRemotePath(remoteDir: string, filenameOrPath: string) {
  if (filenameOrPath.startsWith("/")) {
    return filenameOrPath;
  }

  return posix.join(remoteDir, filenameOrPath);
}

function normalizeListedFile(remoteDir: string, file: FileInfo): RitmoSftpFile {
  return {
    name: file.name,
    remotePath: toRemotePath(remoteDir, file.name),
    size: file.size,
    modifyTime: file.modifyTime,
  };
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks);
}

async function toBuffer(value: Buffer | string | Readable) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    return Buffer.from(value);
  }

  return streamToBuffer(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableSftpError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("connection lost") ||
    message.includes("connection closed")
  );
}

async function withSftpClient<T>(
  config: RitmoSftpConfig,
  operationName: string,
  operation: (client: SftpClient) => Promise<T>
) {
  const maxAttempts = Math.max(1, Math.floor(config.maxConnectionAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = new SftpClient("ritmo-price-sync");

    try {
      await client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: config.readyTimeoutMs,
      });

      return await operation(client);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryableSftpError(error)) {
        throw error;
      }

      console.warn(
        `[WARN] Ritmo SFTP ${operationName} attempt ${attempt}/${maxAttempts} failed: ${getErrorMessage(
          error
        )}. Retrying in ${config.retryDelayMs}ms`
      );
      await sleep(config.retryDelayMs);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  throw lastError;
}

export async function listRitmoSftpCsvFiles(
  config: RitmoSftpConfig
): Promise<RitmoSftpFile[]> {
  return withSftpClient(config, "list", async (client) => {
    const files = await client.list(config.remoteDir);
    return files
      .filter(isCsvFile)
      .map((file) => normalizeListedFile(config.remoteDir, file))
      .sort((left, right) => {
        const timeDiff = right.modifyTime - left.modifyTime;
        return timeDiff !== 0 ? timeDiff : right.name.localeCompare(left.name);
      });
  });
}

export async function downloadRitmoSftpCsv(
  config: RitmoSftpConfig,
  remoteFile?: string
): Promise<RitmoSftpDownload> {
  return withSftpClient(config, "download", async (client) => {
    const file =
      remoteFile !== undefined
        ? {
            name: posix.basename(remoteFile),
            remotePath: toRemotePath(config.remoteDir, remoteFile),
            size: 0,
            modifyTime: 0,
          }
        : (await client.list(config.remoteDir))
            .filter(isCsvFile)
            .map((entry) => normalizeListedFile(config.remoteDir, entry))
            .sort((left, right) => {
              const timeDiff = right.modifyTime - left.modifyTime;
              return timeDiff !== 0 ? timeDiff : right.name.localeCompare(left.name);
            })[0];

    if (!file) {
      throw new Error(`No CSV files found in ${config.remoteDir}`);
    }

    const content = await toBuffer(await client.get(file.remotePath));

    return {
      file: {
        ...file,
        size: file.size || content.length,
      },
      content,
    };
  });
}
