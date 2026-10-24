/**
 * busboy 1.6 未随包提供 TypeScript 声明（package.json 无 types 字段），
 * 这里只声明本项目用到的部分：流式 multipart 解析。
 * 保持最小面，避免出现"看起来能传任意参数"的假类型。
 */
declare module 'busboy' {
  import type { IncomingMessage } from 'node:http';
  import type { Readable, Writable } from 'node:stream';

  export interface BusboyLimits {
    /** 单文件字节上限，超限后该文件流被截断并触发 'limit' */
    fileSize?: number;
    files?: number;
    fields?: number;
    fieldSize?: number;
    parts?: number;
    headerPairs?: number;
  }

  export interface BusboyConfig {
    headers: IncomingMessage['headers'];
    limits?: BusboyLimits;
    preservePath?: boolean;
    defParamCharset?: string;
  }

  export interface FileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  export interface FieldInfo {
    nameTruncated: boolean;
    valueTruncated: boolean;
    encoding: string;
    mimeType: string;
  }

  /** 文件流：除标准 Readable 事件外，超限时触发 'limit' */
  export interface FileStream extends Readable {
    on(ev: 'limit', cb: () => void): this;
    on(ev: 'data', cb: (chunk: Buffer) => void): this;
    on(ev: 'end', cb: () => void): this;
    on(ev: 'error', cb: (e: Error) => void): this;
  }

  export interface Busboy extends Writable {
    on(ev: 'file', cb: (name: string, file: FileStream, info: FileInfo) => void): this;
    on(ev: 'field', cb: (name: string, value: string, info: FieldInfo) => void): this;
    on(ev: 'close', cb: () => void): this;
    on(ev: 'finish', cb: () => void): this;
    on(ev: 'error', cb: (e: Error) => void): this;
    on(ev: 'partsLimit' | 'filesLimit' | 'fieldsLimit', cb: () => void): this;
  }

  function Busboy(config: BusboyConfig): Busboy;
  export = Busboy;
}
