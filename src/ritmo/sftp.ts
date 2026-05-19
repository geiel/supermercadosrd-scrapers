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

export async function listRitmoSftpCsvFiles(
  config: RitmoSftpConfig
): Promise<RitmoSftpFile[]> {
  const client = new SftpClient("ritmo-price-sync");

  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: config.readyTimeoutMs,
    });

    const files = await client.list(config.remoteDir);
    return files
      .filter(isCsvFile)
      .map((file) => normalizeListedFile(config.remoteDir, file))
      .sort((left, right) => {
        const timeDiff = right.modifyTime - left.modifyTime;
        return timeDiff !== 0 ? timeDiff : right.name.localeCompare(left.name);
      });
  } finally {
    await client.end();
  }
}

export async function downloadRitmoSftpCsv(
  config: RitmoSftpConfig,
  remoteFile?: string
): Promise<RitmoSftpDownload> {
  const client = new SftpClient("ritmo-price-sync");

  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: config.readyTimeoutMs,
    });

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
  } finally {
    await client.end();
  }
}
