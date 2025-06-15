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

export const write = (
  data: unknown,
  buffer: SharedArrayBuffer,
  { timeout = 5000 }: Options = {}
) => {
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
    if (
      Atomics.wait(header, SEMAPHORE, Semaphore.HANDSHAKE, timeout) ===
      "timed-out"
    ) {
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

      if (
        Atomics.wait(header, SEMAPHORE, Semaphore.PAYLOAD, timeout) ===
        "timed-out"
      ) {
        throw new Error(`Reader timeout on chunk ${i}/${totalChunks - 1}`);
      }
    }
  } finally {
    Atomics.store(header, SEMAPHORE, Semaphore.READY);
  }
};

export const read = (buffer: SharedArrayBuffer,
  { timeout = 5000 }: Options = {}
): unknown => {
  const header = new Int32Array(buffer);
  if (
    Atomics.wait(header, SEMAPHORE, Semaphore.READY, timeout) === "timed-out"
  ) {
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
    if (
      Atomics.wait(header, SEMAPHORE, Semaphore.READY, timeout) === "timed-out"
    ) {
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
  return deserialize(data);
};
