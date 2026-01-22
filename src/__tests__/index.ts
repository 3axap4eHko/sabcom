import { vi } from "vitest";
import {
  readGenerator,
  writeGenerator,
  write,
  writeSync,
  read,
  readSync,
  SEMAPHORE,
  HEADER_VALUES,
  HEADER_SIZE,
  Semaphore,
  Handshake,
  Header,
} from "../index.js";

describe("sabcom test suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("should have correct header size", () => {
    const handshakeMax = Math.max(
      ...Object.values(Handshake).filter((v): v is number => typeof v === "number"),
    );
    const headerMax = Math.max(
      ...Object.values(Header).filter((v): v is number => typeof v === "number"),
    );
    expect(HEADER_VALUES).toBeGreaterThan(handshakeMax);
    expect(HEADER_VALUES).toBeGreaterThan(headerMax);
  });

  describe("writeGenerator", () => {
    it("should yield handshake wait request first", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);
      const header = new Int32Array(buffer);

      const gen = writeGenerator(data, buffer, { timeout: 5000 });
      const result = gen.next();

      expect(result.done).toBe(false);
      expect(result.value).toEqual({
        target: header,
        index: SEMAPHORE,
        value: Semaphore.HANDSHAKE,
        timeout: 5000,
      });

      expect(header[SEMAPHORE]).toBe(Semaphore.HANDSHAKE);
      expect(header[Handshake.TOTAL_SIZE]).toBeGreaterThan(0);
      expect(header[Handshake.TOTAL_CHUNKS]).toBe(1);
    });

    it("should yield payload wait request after handshake", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);
      const header = new Int32Array(buffer);

      const gen = writeGenerator(data, buffer);

      const handshakeResult = gen.next();
      expect(handshakeResult.done).toBe(false);

      const payloadResult = gen.next("ok");
      expect(payloadResult.done).toBe(false);
      expect(payloadResult.value).toEqual({
        target: header,
        index: SEMAPHORE,
        value: Semaphore.PAYLOAD,
        timeout: 5000,
      });

      expect(header[SEMAPHORE]).toBe(Semaphore.PAYLOAD);
      expect(header[Header.CHUNK_INDEX]).toBe(0);
      expect(header[Header.CHUNK_OFFSET]).toBe(0);
      expect(header[Header.CHUNK_SIZE]).toBeGreaterThan(0);
    });

    it("should complete after payload acknowledgment", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);

      const gen = writeGenerator(data, buffer);

      gen.next();
      gen.next("ok");
      const finalResult = gen.next("ok");

      expect(finalResult.done).toBe(true);
      expect(finalResult.value).toBeUndefined();
    });

    it("should throw on handshake timeout", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);

      const gen = writeGenerator(data, buffer);
      gen.next();

      expect(() => gen.next("timed-out")).toThrow("Reader handshake timeout");
    });

    it("should throw on payload timeout", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);

      const gen = writeGenerator(data, buffer);
      gen.next();
      gen.next("ok");

      expect(() => gen.next("timed-out")).toThrow(
        "Reader timeout on chunk 0/0",
      );
    });

    it("should reset semaphore to READY on completion", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);
      const header = new Int32Array(buffer);

      const gen = writeGenerator(data, buffer);
      gen.next();
      gen.next("ok");
      gen.next("ok");

      expect(header[SEMAPHORE]).toBe(Semaphore.READY);
    });

    it("should handle multi-chunk data", () => {
      const bufferSize = HEADER_SIZE + 16;
      const buffer = new SharedArrayBuffer(bufferSize);
      const header = new Int32Array(buffer);

      const data = new Uint8Array(50); // Create data larger than chunk size
      for (let i = 0; i < data.length; i++) {
        data[i] = i;
      }
      const chunkSize = bufferSize - HEADER_SIZE;
      const expectedChunks = Math.ceil(data.length / chunkSize);

      const gen = writeGenerator(data, buffer);

      const handshakeResult = gen.next();
      expect(header[Handshake.TOTAL_CHUNKS]).toBe(expectedChunks);

      let result = gen.next("ok");
      let chunkCount = 0;

      while (!result.done) {
        expect(result.value.value).toBe(Semaphore.PAYLOAD);
        expect(header[Header.CHUNK_INDEX]).toBe(chunkCount);
        chunkCount++;
        result = gen.next("ok");
      }

      expect(chunkCount).toBe(expectedChunks);
    });

    it("should throw if buffer byteLength is not a multiple of 4", () => {
      const buffer = new SharedArrayBuffer(1025);
      const data = new Uint8Array([1, 2, 3]);

      expect(() => writeGenerator(data, buffer).next()).toThrow(
        "SharedArrayBuffer byteLength must be a multiple of 4",
      );
    });

    it("should throw if buffer is too small for header", () => {
      const buffer = new SharedArrayBuffer(HEADER_SIZE);
      const data = new Uint8Array([1, 2, 3]);

      expect(() => writeGenerator(data, buffer).next()).toThrow(
        "SharedArrayBuffer too small for header",
      );
    });
  });

  describe("readGenerator", () => {
    it("should yield handshake wait request first", () => {
      const capacity = 1024;
      const buffer = new SharedArrayBuffer(capacity);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer, { timeout: 5000 });
      const result = gen.next();

      expect(result.done).toBe(false);
      expect(result.value).toEqual({
        target: header,
        index: SEMAPHORE,
        value: Semaphore.READY,
        timeout: 5000,
      });
    });

    it("should throw on handshake timeout", () => {
      const buffer = new SharedArrayBuffer(1024);
      const gen = readGenerator(buffer);
      gen.next();

      expect(() => gen.next("timed-out")).toThrow("Handshake timeout");
    });

    it("should throw on invalid handshake state", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.PAYLOAD;

      const gen = readGenerator(buffer);
      gen.next();

      expect(() => gen.next("ok")).toThrow("Invalid handshake state");
    });

    it("should yield chunk wait requests and return data", () => {
      const capacity = 1024;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(capacity);
      const header = new Int32Array(buffer);
      const payload = new Uint8Array(buffer, HEADER_SIZE);

      const gen = readGenerator(buffer);

      const handshakeResult = gen.next();
      expect(handshakeResult.done).toBe(false);

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = data.length;
      header[Handshake.TOTAL_CHUNKS] = 1;
      payload.set(data, 0);

      const chunkResult = gen.next("ok");
      expect(chunkResult.done).toBe(false);
      expect(chunkResult.value.value).toBe(Semaphore.READY);

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 0;
      header[Header.CHUNK_SIZE] = data.length;

      const finalResult = gen.next("ok");
      expect(finalResult.done).toBe(true);
      expect(finalResult.value).toEqual(data);
    });

    it("should throw on chunk timeout", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;

      const gen = readGenerator(buffer);
      gen.next();
      gen.next("ok");

      expect(() => gen.next("timed-out")).toThrow(
        "Writer timeout waiting for chunk 0",
      );
    });

    it("should throw on wrong payload header", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;

      const gen = readGenerator(buffer);
      gen.next();
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.HANDSHAKE;

      expect(() => gen.next("ok")).toThrow(
        "Expected payload header, received HANDSHAKE",
      );
    });

    it("should throw on chunk index mismatch", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 2;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 0;
      header[Header.CHUNK_SIZE] = 50;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 50;
      header[Header.CHUNK_SIZE] = 50;

      expect(() => gen.next("ok")).toThrow(
        "Reader integrity failure for chunk 0 expected 1",
      );
    });

    it("should throw if buffer byteLength is not a multiple of 4", () => {
      const buffer = new SharedArrayBuffer(1025);

      expect(() => readGenerator(buffer).next()).toThrow(
        "SharedArrayBuffer byteLength must be a multiple of 4",
      );
    });

    it("should throw if buffer is too small for header", () => {
      const buffer = new SharedArrayBuffer(HEADER_SIZE);

      expect(() => readGenerator(buffer).next()).toThrow(
        "SharedArrayBuffer too small for header",
      );
    });

    it("should throw on negative totalSize", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = -1;
      header[Handshake.TOTAL_CHUNKS] = 1;

      expect(() => gen.next("ok")).toThrow("Invalid handshake values");
    });

    it("should throw on negative totalChunks", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = -1;

      expect(() => gen.next("ok")).toThrow("Invalid handshake values");
    });

    it("should throw when totalSize is zero but totalChunks is not", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 0;
      header[Handshake.TOTAL_CHUNKS] = 1;

      expect(() => gen.next("ok")).toThrow("Invalid handshake values");
    });

    it("should throw when totalSize exceeds totalChunks * chunkSize", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const chunkSize = 1024 - HEADER_SIZE;

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = chunkSize * 2 + 1;
      header[Handshake.TOTAL_CHUNKS] = 2;

      expect(() => gen.next("ok")).toThrow("Invalid handshake values");
    });

    it("should throw on invalid chunk metadata - negative offset", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = -1;
      header[Header.CHUNK_SIZE] = 100;

      expect(() => gen.next("ok")).toThrow("Invalid chunk metadata for chunk 0");
    });

    it("should throw on invalid chunk metadata - zero size", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 0;
      header[Header.CHUNK_SIZE] = 0;

      expect(() => gen.next("ok")).toThrow("Invalid chunk metadata for chunk 0");
    });

    it("should throw on invalid chunk metadata - size exceeds chunkSize", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const chunkSize = 1024 - HEADER_SIZE;

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 0;
      header[Header.CHUNK_SIZE] = chunkSize + 1;

      expect(() => gen.next("ok")).toThrow("Invalid chunk metadata for chunk 0");
    });

    it("should throw on invalid chunk metadata - offset + size exceeds totalSize", () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);

      const gen = readGenerator(buffer);
      gen.next();

      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;
      gen.next("ok");

      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 50;
      header[Header.CHUNK_SIZE] = 100;

      expect(() => gen.next("ok")).toThrow("Invalid chunk metadata for chunk 0");
    });
  });

  describe("write", () => {
    it("should use Atomics.waitAsync instead of Atomics.wait", async () => {
      const mockWaitAsync = vi
        .fn()
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce("ok");
      const waitAsyncSpy = vi
        .spyOn(Atomics, "waitAsync")
        .mockImplementation(() => ({ value: mockWaitAsync() }));

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);

      const writePromise = write(data, buffer);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 10);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 20);

      await writePromise;

      expect(waitAsyncSpy).toHaveBeenCalled();
      expect(mockWaitAsync).toHaveBeenCalledTimes(2);
    });

    it("should accept options parameter", async () => {
      const mockWaitAsync = vi
        .fn()
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce("ok");
      vi.spyOn(Atomics, "waitAsync").mockImplementation(() => ({
        value: mockWaitAsync(),
      }));

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);
      const options = { timeout: 1000 };

      const writePromise = write(data, buffer, options);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 10);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 20);

      await expect(writePromise).resolves.toBeUndefined();
    });
  });

  describe("writeSync", () => {
    it("should use Atomics.wait instead of Atomics.waitAsync", () => {
      const mockWait = vi
        .fn()
        .mockReturnValueOnce("ok")
        .mockReturnValueOnce("ok");
      const waitSpy = vi.spyOn(Atomics, "wait").mockImplementation(mockWait);

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 10);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 20);

      writeSync(data, buffer);

      expect(waitSpy).toHaveBeenCalled();
      expect(mockWait).toHaveBeenCalledTimes(2);
    });

    it("should accept options parameter", () => {
      const mockWait = vi
        .fn()
        .mockReturnValueOnce("ok")
        .mockReturnValueOnce("ok");
      vi.spyOn(Atomics, "wait").mockImplementation(mockWait);

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);
      const options = { timeout: 1000 };

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 10);

      setTimeout(() => {
        const header = new Int32Array(buffer);
        Atomics.store(header, SEMAPHORE, Semaphore.READY);
        Atomics.notify(header, SEMAPHORE);
      }, 20);

      expect(() => writeSync(data, buffer, options)).not.toThrow();
    });
  });

  describe("readSync", () => {
    it("should use Atomics.wait and return buffer data", () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const payload = new Uint8Array(buffer, HEADER_SIZE);

      // Simulate handshake response from writer
      let waitCallCount = 0;
      const mockWait = vi.fn().mockImplementation(() => {
        waitCallCount++;
        if (waitCallCount === 1) {
          // After first wait, set up handshake
          header[SEMAPHORE] = Semaphore.HANDSHAKE;
          header[Handshake.TOTAL_SIZE] = testData.length;
          header[Handshake.TOTAL_CHUNKS] = 1;
          payload.set(testData, 0);
          return "ok";
        } else if (waitCallCount === 2) {
          // After second wait, set up payload
          header[SEMAPHORE] = Semaphore.PAYLOAD;
          header[Header.CHUNK_INDEX] = 0;
          header[Header.CHUNK_OFFSET] = 0;
          header[Header.CHUNK_SIZE] = testData.length;
          return "ok";
        }
        return "ok";
      });

      vi.spyOn(Atomics, "wait").mockImplementation(mockWait);

      const result = readSync(buffer);

      expect(result).toEqual(testData);
      expect(mockWait).toHaveBeenCalledTimes(2);
    });

    it("should accept options parameter", () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const payload = new Uint8Array(buffer, HEADER_SIZE);

      let waitCallCount = 0;
      const mockWait = vi.fn().mockImplementation(() => {
        waitCallCount++;
        if (waitCallCount === 1) {
          header[SEMAPHORE] = Semaphore.HANDSHAKE;
          header[Handshake.TOTAL_SIZE] = testData.length;
          header[Handshake.TOTAL_CHUNKS] = 1;
          payload.set(testData, 0);
          return "ok";
        } else if (waitCallCount === 2) {
          header[SEMAPHORE] = Semaphore.PAYLOAD;
          header[Header.CHUNK_INDEX] = 0;
          header[Header.CHUNK_OFFSET] = 0;
          header[Header.CHUNK_SIZE] = testData.length;
          return "ok";
        }
        return "ok";
      });

      vi.spyOn(Atomics, "wait").mockImplementation(mockWait);

      const options = { timeout: 1000 };
      const result = readSync(buffer, options);

      expect(result).toEqual(testData);
    });
  });

  describe("read", () => {
    it("should use Atomics.waitAsync and return buffer data", async () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const mockWaitAsync = vi.fn();
      vi.spyOn(Atomics, "waitAsync").mockImplementation(() => ({
        value: mockWaitAsync(),
      }));

      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const payload = new Uint8Array(buffer, HEADER_SIZE);

      let waitCallCount = 0;
      mockWaitAsync.mockImplementation(async () => {
        waitCallCount++;
        if (waitCallCount === 1) {
          // After first wait, set up handshake
          header[SEMAPHORE] = Semaphore.HANDSHAKE;
          header[Handshake.TOTAL_SIZE] = testData.length;
          header[Handshake.TOTAL_CHUNKS] = 1;
          payload.set(testData, 0);
          return "ok";
        } else if (waitCallCount === 2) {
          // After second wait, set up payload
          header[SEMAPHORE] = Semaphore.PAYLOAD;
          header[Header.CHUNK_INDEX] = 0;
          header[Header.CHUNK_OFFSET] = 0;
          header[Header.CHUNK_SIZE] = testData.length;
          return "ok";
        }
        return "ok";
      });

      const result = await read(buffer);

      expect(result).toEqual(testData);
      expect(mockWaitAsync).toHaveBeenCalledTimes(2);
    });

    it("should accept options parameter", async () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const mockWaitAsync = vi.fn();
      vi.spyOn(Atomics, "waitAsync").mockImplementation(() => ({
        value: mockWaitAsync(),
      }));

      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const payload = new Uint8Array(buffer, HEADER_SIZE);

      const options = { timeout: 1000 };

      let waitCallCount = 0;
      mockWaitAsync.mockImplementation(async () => {
        waitCallCount++;
        if (waitCallCount === 1) {
          header[SEMAPHORE] = Semaphore.HANDSHAKE;
          header[Handshake.TOTAL_SIZE] = testData.length;
          header[Handshake.TOTAL_CHUNKS] = 1;
          payload.set(testData, 0);
          return "ok";
        } else if (waitCallCount === 2) {
          header[SEMAPHORE] = Semaphore.PAYLOAD;
          header[Header.CHUNK_INDEX] = 0;
          header[Header.CHUNK_OFFSET] = 0;
          header[Header.CHUNK_SIZE] = testData.length;
          return "ok";
        }
        return "ok";
      });

      const result = await read(buffer, options);

      expect(result).toEqual(testData);
    });
  });
});
