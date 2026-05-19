declare module "ssh2-sftp-client" {
  import type { Readable } from "node:stream";

  export type FileInfo = {
    type: string;
    name: string;
    size: number;
    modifyTime: number;
    accessTime: number;
    rights: {
      user: string;
      group: string;
      other: string;
    };
    owner: number;
    group: number;
  };

  export type ConnectOptions = {
    host: string;
    port?: number;
    username: string;
    password?: string;
    readyTimeout?: number;
  };

  export default class SftpClient {
    constructor(clientName?: string);
    connect(options: ConnectOptions): Promise<void>;
    list(remotePath: string): Promise<FileInfo[]>;
    get(remotePath: string): Promise<Buffer | string | Readable>;
    end(): Promise<void>;
  }
}
