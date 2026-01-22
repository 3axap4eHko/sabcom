export const SEMAPHORE = 0;

export enum Semaphore {
  READY,
  HANDSHAKE,
  PAYLOAD,
}

export enum Handshake {
  TOTAL_SIZE = 1,
  TOTAL_CHUNKS,
}

export enum Header {
  CHUNK_INDEX = 1,
  CHUNK_OFFSET,
  CHUNK_SIZE,
}

export const HEADER_VALUES = 4;

/**
 * Size in bytes reserved for protocol header in the SharedArrayBuffer.
 * The usable payload size is `buffer.byteLength - HEADER_SIZE`.
 */
export const HEADER_SIZE = Uint32Array.BYTES_PER_ELEMENT * HEADER_VALUES;

export interface Options {
  /** Max wait time in milliseconds before timeout error. Default: 5000 */
  timeout?: number;
}

/**
 * Request yielded by generator functions for Atomics.wait/waitAsync.
 * Pass to Atomics.wait() for sync or Atomics.waitAsync() for async waiting.
 */
export interface WaitRequest {
  /** Int32Array view of the SharedArrayBuffer header */
  target: Int32Array;
  /** Index in the array to wait on (always SEMAPHORE = 0) */
  index: number;
  /** Value to compare against before waiting */
  value: number;
  /** Timeout in milliseconds */
  timeout?: number;
}

export type WaitResponse = ReturnType<typeof Atomics.wait>;

/**
 * Low-level generator for writing data with custom flow control.
 * Use for progress tracking, cancellation, or custom scheduling.
 * @param data - Bytes to send (can be larger than buffer, will be chunked automatically)
 * @param buffer - SharedArrayBuffer shared with the reader thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @yields {WaitRequest} Request to wait for reader acknowledgment
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Reader handshake timeout" - reader didn't respond in time
 * @throws {Error} "Reader timeout on chunk N/M" - reader stopped responding mid-transfer
 * @example
 * ```typescript
 * import { writeGenerator } from 'sabcom';
 *
 * const gen = writeGenerator(data, buffer);
 * let chunks = 0;
 * for (const request of gen) {
 *   const result = Atomics.wait(request.target, request.index, request.value, request.timeout);
 *   if (result === 'timed-out') throw new Error('Timeout');
 *   console.log(`Chunk ${++chunks} sent`);
 * }
 * ```
 */
export function* writeGenerator(data: Uint8Array, buffer: SharedArrayBuffer, { timeout = 5000 }: Options = {}): Generator<WaitRequest, void, WaitResponse> {
  if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('SharedArrayBuffer byteLength must be a multiple of 4');
  }
  const chunkSize = buffer.byteLength - HEADER_SIZE;
  if (chunkSize <= 0) {
    throw new Error('SharedArrayBuffer too small for header');
  }
  const totalSize = data.length;
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const header = new Int32Array(buffer);

  header[Handshake.TOTAL_SIZE] = totalSize;
  header[Handshake.TOTAL_CHUNKS] = totalChunks;
  Atomics.store(header, SEMAPHORE, Semaphore.HANDSHAKE);
  Atomics.notify(header, SEMAPHORE);

  try {
    const handshakeResult: WaitResponse = yield {
      target: header,
      index: SEMAPHORE,
      value: Semaphore.HANDSHAKE,
      timeout,
    };
    if (handshakeResult === 'timed-out') {
      throw new Error('Reader handshake timeout');
    }

    const payload = new Uint8Array(buffer, HEADER_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const size = end - start;
      payload.set(data.subarray(start, end), 0);
      header[Header.CHUNK_INDEX] = i;
      header[Header.CHUNK_OFFSET] = start;
      header[Header.CHUNK_SIZE] = size;
      Atomics.store(header, SEMAPHORE, Semaphore.PAYLOAD);
      Atomics.notify(header, SEMAPHORE);

      const chunkResult: WaitResponse = yield {
        target: header,
        index: SEMAPHORE,
        value: Semaphore.PAYLOAD,
        timeout,
      };
      if (chunkResult === 'timed-out') {
        throw new Error(`Reader timeout on chunk ${i}/${totalChunks - 1}`);
      }
    }
  } finally {
    Atomics.store(header, SEMAPHORE, Semaphore.READY);
    Atomics.notify(header, SEMAPHORE);
  }
}

/**
 * Low-level generator for reading data with custom flow control.
 * Use for progress tracking, cancellation, or custom scheduling.
 * @param buffer - SharedArrayBuffer shared with the writer thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @yields {WaitRequest} Request to wait for writer data
 * @returns Complete data as Uint8Array
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Handshake timeout" - writer didn't send data in time
 * @throws {Error} "Invalid handshake state" - protocol error
 * @throws {Error} "Writer timeout waiting for chunk N" - writer stopped responding mid-transfer
 * @example
 * ```typescript
 * import { readGenerator } from 'sabcom';
 *
 * const gen = readGenerator(buffer);
 * let result = gen.next();
 * while (!result.done) {
 *   const waitResult = Atomics.wait(result.value.target, result.value.index, result.value.value, result.value.timeout);
 *   result = gen.next(waitResult);
 * }
 * const data = result.value; // Uint8Array
 * ```
 */
export function* readGenerator(buffer: SharedArrayBuffer, { timeout = 5000 }: Options = {}): Generator<WaitRequest, Uint8Array, WaitResponse> {
  if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('SharedArrayBuffer byteLength must be a multiple of 4');
  }
  const chunkSize = buffer.byteLength - HEADER_SIZE;
  if (chunkSize <= 0) {
    throw new Error('SharedArrayBuffer too small for header');
  }
  const header = new Int32Array(buffer);

  const handshakeResult: WaitResponse = yield {
    target: header,
    index: SEMAPHORE,
    value: Semaphore.READY,
    timeout,
  };
  if (handshakeResult === 'timed-out') {
    throw new Error('Handshake timeout');
  }
  if (header[SEMAPHORE] !== Semaphore.HANDSHAKE) {
    throw new Error('Invalid handshake state');
  }

  const totalSize = header[Handshake.TOTAL_SIZE];
  const totalChunks = header[Handshake.TOTAL_CHUNKS];
  if (totalSize < 0 || totalChunks < 0) {
    throw new Error('Invalid handshake values');
  }
  if (totalSize === 0 && totalChunks !== 0) {
    throw new Error('Invalid handshake values');
  }
  if (totalSize > totalChunks * chunkSize) {
    throw new Error('Invalid handshake values');
  }
  const data = new Uint8Array(totalSize);

  Atomics.store(header, SEMAPHORE, Semaphore.READY);
  Atomics.notify(header, SEMAPHORE);

  const payload = new Uint8Array(buffer, HEADER_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const chunkResult: WaitResponse = yield {
      target: header,
      index: SEMAPHORE,
      value: Semaphore.READY,
      timeout,
    };
    if (chunkResult === 'timed-out') {
      throw new Error(`Writer timeout waiting for chunk ${i}`);
    }
    // @ts-expect-error does not infer number
    if (header[SEMAPHORE] !== Semaphore.PAYLOAD) {
      throw new Error(`Expected payload header, received ${Semaphore[header[SEMAPHORE]]}`);
    }
    const chunkIndex = header[Header.CHUNK_INDEX];
    if (i !== chunkIndex) {
      throw new Error(`Reader integrity failure for chunk ${chunkIndex} expected ${i}`);
    }
    const offset = header[Header.CHUNK_OFFSET];
    const size = header[Header.CHUNK_SIZE];
    if (offset < 0 || size <= 0 || size > chunkSize || offset + size > totalSize) {
      throw new Error(`Invalid chunk metadata for chunk ${chunkIndex}`);
    }
    data.set(payload.subarray(0, size), offset);
    Atomics.store(header, SEMAPHORE, Semaphore.READY);
    Atomics.notify(header, SEMAPHORE);
  }
  return data;
}

/**
 * Synchronously writes data to a SharedArrayBuffer for cross-thread transfer.
 * Blocks until the reader receives all data. Use in workers where blocking is acceptable.
 * @param data - Bytes to send (can be larger than buffer, will be chunked automatically)
 * @param buffer - SharedArrayBuffer shared with the reader thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Reader handshake timeout" - reader didn't respond in time
 * @throws {Error} "Reader timeout on chunk N/M" - reader stopped responding mid-transfer
 * @example
 * ```typescript
 * import { workerData } from 'worker_threads';
 * import { writeSync } from 'sabcom';
 *
 * const buffer = workerData as SharedArrayBuffer;
 * const data = new TextEncoder().encode('Hello from worker');
 * writeSync(data, buffer);
 * ```
 */
export const writeSync = (data: Uint8Array, buffer: SharedArrayBuffer, options?: Options): void => {
  const gen = writeGenerator(data, buffer, options);
  let result = gen.next();
  while (!result.done) {
    const waitResult = Atomics.wait(result.value.target, result.value.index, result.value.value, result.value.timeout);
    result = gen.next(waitResult);
  }
};

/**
 * Asynchronously writes data to a SharedArrayBuffer for cross-thread transfer.
 * Non-blocking, suitable for main thread. Resolves when the reader receives all data.
 * @param data - Bytes to send (can be larger than buffer, will be chunked automatically)
 * @param buffer - SharedArrayBuffer shared with the reader thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Reader handshake timeout" - reader didn't respond in time
 * @throws {Error} "Reader timeout on chunk N/M" - reader stopped responding mid-transfer
 * @example
 * ```typescript
 * import { Worker } from 'worker_threads';
 * import { write } from 'sabcom';
 *
 * const buffer = new SharedArrayBuffer(4096);
 * const worker = new Worker('./worker.js', { workerData: buffer });
 * const data = new TextEncoder().encode('Hello from main');
 * await write(data, buffer);
 * ```
 */
export const write = async (data: Uint8Array, buffer: SharedArrayBuffer, options?: Options): Promise<void> => {
  const gen = writeGenerator(data, buffer, options);
  let result = gen.next();
  while (!result.done) {
    const request = result.value;
    const waitResult = await Atomics.waitAsync(request.target, request.index, request.value, request.timeout).value;
    result = gen.next(waitResult);
  }
};

/**
 * Synchronously reads data from a SharedArrayBuffer written by another thread.
 * Blocks until all data is received. Use in workers where blocking is acceptable.
 * @param buffer - SharedArrayBuffer shared with the writer thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @returns Complete data as Uint8Array
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Handshake timeout" - writer didn't send data in time
 * @throws {Error} "Invalid handshake state" - protocol error
 * @throws {Error} "Writer timeout waiting for chunk N" - writer stopped responding mid-transfer
 * @example
 * ```typescript
 * import { workerData } from 'worker_threads';
 * import { readSync } from 'sabcom';
 *
 * const buffer = workerData as SharedArrayBuffer;
 * const data = readSync(buffer);
 * const message = new TextDecoder().decode(data);
 * ```
 */
export const readSync = (buffer: SharedArrayBuffer, options?: Options): Uint8Array => {
  const gen = readGenerator(buffer, options);
  let result = gen.next();
  while (!result.done) {
    const waitResult = Atomics.wait(result.value.target, result.value.index, result.value.value, result.value.timeout);
    result = gen.next(waitResult);
  }
  return result.value;
};

/**
 * Asynchronously reads data from a SharedArrayBuffer written by another thread.
 * Non-blocking, suitable for main thread. Resolves when all data is received.
 * @param buffer - SharedArrayBuffer shared with the writer thread (byteLength must be multiple of 4 and larger than HEADER_SIZE)
 * @param options - Optional configuration
 * @returns Complete data as Uint8Array
 * @throws {Error} "SharedArrayBuffer byteLength must be a multiple of 4"
 * @throws {Error} "SharedArrayBuffer too small for header"
 * @throws {Error} "Handshake timeout" - writer didn't send data in time
 * @throws {Error} "Invalid handshake state" - protocol error
 * @throws {Error} "Writer timeout waiting for chunk N" - writer stopped responding mid-transfer
 * @example
 * ```typescript
 * import { Worker } from 'worker_threads';
 * import { read } from 'sabcom';
 *
 * const buffer = new SharedArrayBuffer(4096);
 * const worker = new Worker('./worker.js', { workerData: buffer });
 * // Worker writes data...
 * const data = await read(buffer);
 * const message = new TextDecoder().decode(data);
 * ```
 */
export const read = async (buffer: SharedArrayBuffer, options?: Options): Promise<Uint8Array> => {
  const gen = readGenerator(buffer, options);
  let result = gen.next();
  while (!result.done) {
    const request = result.value;
    const waitResult = await Atomics.waitAsync(request.target, request.index, request.value, request.timeout).value;
    result = gen.next(waitResult);
  }
  return result.value;
};
