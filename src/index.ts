import { serialize, deserialize } from "node:v8";

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

export const HEADER_VALUES =
  1 +
  Math.max(Object.values(Handshake).length, Object.values(Header).length) / 2;
export const HEADER_SIZE = Uint32Array.BYTES_PER_ELEMENT * HEADER_VALUES;

export interface Options {
  timeout?: number;
}

export interface WaitRequest {
  target: Int32Array;
  index: number;
  value: number;
  timeout?: number;
}

export type WaitResponse = ReturnType<typeof Atomics.wait>;

export function* writeGenerator(
  data: unknown,
  buffer: SharedArrayBuffer,
  { timeout = 5000 }: Options = {},
): Generator<WaitRequest, void, WaitResponse> {
  const serialized = serialize(data);
  const chunkSize = buffer.byteLength - HEADER_SIZE;
  const totalSize = serialized.length;
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
    if (handshakeResult === "timed-out") {
      throw new Error("Reader handshake timeout");
    }

    const payload = new Uint8Array(buffer, HEADER_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const size = end - start;
      payload.set(serialized.subarray(start, end), 0);
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
      if (chunkResult === "timed-out") {
        throw new Error(`Reader timeout on chunk ${i}/${totalChunks - 1}`);
      }
    }
  } finally {
    Atomics.store(header, SEMAPHORE, Semaphore.READY);
  }
}

export function* readGenerator(
  buffer: SharedArrayBuffer,
  { timeout = 5000 }: Options = {},
): Generator<WaitRequest, unknown, WaitResponse> {
  const header = new Int32Array(buffer);

  const handshakeResult: WaitResponse = yield {
    target: header,
    index: SEMAPHORE,
    value: Semaphore.READY,
    timeout,
  };
  if (handshakeResult === "timed-out") {
    throw new Error("Handshake timeout");
  }
  if (header[SEMAPHORE] !== Semaphore.HANDSHAKE) {
    throw new Error("Invalid handshake state");
  }

  const totalSize = header[Handshake.TOTAL_SIZE];
  const totalChunks = header[Handshake.TOTAL_CHUNKS];
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
    if (chunkResult === "timed-out") {
      throw new Error(`Writer timeout waiting for chunk ${i}`);
    }
    // @ts-expect-error does not infer number
    if (header[SEMAPHORE] !== Semaphore.PAYLOAD) {
      throw new Error(
        `Expected payload header, received ${Semaphore[header[SEMAPHORE]]}`,
      );
    }
    const chunkIndex = header[Header.CHUNK_INDEX];
    if (i !== chunkIndex) {
      throw new Error(
        `Reader integrity failure for chunk ${chunkIndex} expected ${i}`,
      );
    }
    const offset = header[Header.CHUNK_OFFSET];
    const size = header[Header.CHUNK_SIZE];
    data.set(payload.subarray(0, size), offset);
    Atomics.store(header, SEMAPHORE, Semaphore.READY);
    Atomics.notify(header, SEMAPHORE);
  }
  return deserialize(data) as unknown;
}

export const writeSync = (
  data: unknown,
  buffer: SharedArrayBuffer,
  options?: Options,
) => {
  const gen = writeGenerator(data, buffer, options);
  let result = gen.next();
  while (!result.done) {
    const waitResult = Atomics.wait(
      result.value.target,
      result.value.index,
      result.value.value,
      result.value.timeout,
    );
    result = gen.next(waitResult);
  }
};

export const write = async (
  data: unknown,
  buffer: SharedArrayBuffer,
  options?: Options,
) => {
  const gen = writeGenerator(data, buffer, options);
  let result = gen.next();
  while (!result.done) {
    const request = result.value;
    const waitResult = await Atomics.waitAsync(
      request.target,
      request.index,
      request.value,
      request.timeout,
    ).value;
    result = gen.next(waitResult);
  }
};

export const readSync = (
  buffer: SharedArrayBuffer,
  options?: Options,
): unknown => {
  const gen = readGenerator(buffer, options);
  let result = gen.next();
  while (!result.done) {
    const waitResult = Atomics.wait(
      result.value.target,
      result.value.index,
      result.value.value,
      result.value.timeout,
    );
    result = gen.next(waitResult);
  }
  return result.value;
};

export const read = async (
  buffer: SharedArrayBuffer,
  options?: Options,
): Promise<unknown> => {
  const gen = readGenerator(buffer, options);
  let result = gen.next();
  while (!result.done) {
    const request = result.value;
    const waitResult = await Atomics.waitAsync(
      request.target,
      request.index,
      request.value,
      request.timeout,
    ).value;
    result = gen.next(waitResult);
  }
  return result.value;
};
