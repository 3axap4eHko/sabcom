import { createBuffer, open, reset } from "../index.js";

let runtimeId = 0;

async function loadRuntime(): Promise<typeof import("../index.js")> {
  runtimeId += 1;
  const specifier = new URL(`../index.js?runtime=${runtimeId}`, import.meta.url).href;
  return import(/* @vite-ignore */ specifier);
}

describe("sabcom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("createBuffer", () => {
    it("should create a SharedArrayBuffer of the requested size", () => {
      const buffer = createBuffer(65536);
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(buffer.byteLength).toBe(65536);
    });

    it("should reject non-aligned byte length", () => {
      expect(() => createBuffer(1025)).toThrow("SharedArrayBuffer byteLength must be a multiple of 4");
    });

    it("should reject buffer too small for channel", () => {
      expect(() => createBuffer(256)).toThrow("SharedArrayBuffer too small for channel");
    });
  });

  describe("open", () => {
    it("should return a channel with all methods", async () => {
      const a = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const channel = a.open(buffer);

      expect(typeof channel.write).toBe("function");
      expect(typeof channel.read).toBe("function");
      expect(typeof channel.writeSync).toBe("function");
      expect(typeof channel.readSync).toBe("function");
      expect(typeof channel.close).toBe("function");

      channel.close();
    });

    it("should return the same handle for the same buffer", async () => {
      const a = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const ch1 = a.open(buffer);
      const ch2 = a.open(buffer);
      expect(ch1).toBe(ch2);
      ch1.close();
    });

    it("should throw when two endpoints are already claimed", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const c = await loadRuntime();
      const buffer = a.createBuffer(65536);
      a.open(buffer);
      b.open(buffer);
      expect(() => c.open(buffer)).toThrow("already claimed by two endpoints");
    });
  });

  describe("sync read/write", () => {
    it("should exchange data between two runtimes", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      chA.writeSync(payload);
      expect(chB.readSync()).toEqual(payload);

      chA.close();
      chB.close();
    });

    it("should handle empty data", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      chA.writeSync(new Uint8Array(0));
      expect(chB.readSync()).toEqual(new Uint8Array(0));

      chA.close();
      chB.close();
    });

    it("should handle multiple sequential messages", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const first = new Uint8Array([10, 20, 30]);
      const second = new Uint8Array([40, 50]);
      chA.writeSync(first);
      chA.writeSync(second);

      expect(chB.readSync()).toEqual(first);
      expect(chB.readSync()).toEqual(second);

      chA.close();
      chB.close();
    });

    it("should handle large data requiring multi-segment transfer", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(4096);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const large = new Uint8Array(8192);
      for (let i = 0; i < large.length; i++) large[i] = i & 0xff;

      // async required: writer and reader must interleave when data exceeds ring capacity
      const [, result] = await Promise.all([chA.write(large), chB.read()]);

      expect(result).toEqual(large);

      chA.close();
      chB.close();
    });
  });

  describe("async read/write", () => {
    it("should exchange data between two runtimes", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      await chA.write(payload);
      await expect(chB.read()).resolves.toEqual(payload);

      chA.close();
      chB.close();
    });

    it("should handle empty data", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      await chA.write(new Uint8Array(0));
      await expect(chB.read()).resolves.toEqual(new Uint8Array(0));

      chA.close();
      chB.close();
    });
  });

  describe("mixed sync/async", () => {
    it("should allow sync write and async read", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const payload = new Uint8Array([1, 2, 3, 4]);
      chA.writeSync(payload);
      await expect(chB.read()).resolves.toEqual(payload);

      chA.close();
      chB.close();
    });

    it("should allow async write and sync read", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const payload = new Uint8Array([9, 8, 7]);
      await chA.write(payload);
      expect(chB.readSync()).toEqual(payload);

      chA.close();
      chB.close();
    });
  });

  describe("bidirectional", () => {
    it("should support bidirectional communication", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const fromA = new Uint8Array([1, 2, 3, 4]);
      chA.writeSync(fromA);
      await expect(chB.read()).resolves.toEqual(fromA);

      const fromB = new Uint8Array([9, 8, 7]);
      await chB.write(fromB);
      expect(chA.readSync()).toEqual(fromB);

      chA.close();
      chB.close();
    });
  });

  describe("close", () => {
    it("should wake pending reads when the peer closes", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const pending = chB.read({ timeout: 1000 });
      chA.close();

      await expect(pending).rejects.toThrow("Peer channel is closed");
      chB.close();
    });

    it("should throw on write after close", async () => {
      const a = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const ch = a.open(buffer);
      ch.close();

      expect(() => ch.writeSync(new Uint8Array([1]))).toThrow("Channel is closed");
    });

    it("should throw on read after close", async () => {
      const a = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const ch = a.open(buffer);
      ch.close();

      expect(() => ch.readSync()).toThrow("Channel is closed");
    });
  });

  describe("buffer reuse", () => {
    it("should allow buffer reuse after both sides close", async () => {
      const a1 = await loadRuntime();
      const b1 = await loadRuntime();
      const buffer = a1.createBuffer(65536);
      const chA = a1.open(buffer);
      const chB = b1.open(buffer);

      chA.writeSync(new Uint8Array([1, 2, 3]));
      expect(chB.readSync()).toEqual(new Uint8Array([1, 2, 3]));
      chA.close();
      chB.close();

      const a2 = await loadRuntime();
      const b2 = await loadRuntime();
      const chA2 = a2.open(buffer);
      const chB2 = b2.open(buffer);

      await chA2.write(new Uint8Array([4, 5, 6, 7]));
      expect(chB2.readSync()).toEqual(new Uint8Array([4, 5, 6, 7]));

      chA2.close();
      chB2.close();
    });
  });

  describe("reset", () => {
    it("should reset a closed buffer for reuse in the current runtime", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      chA.close();
      chB.close();
      reset(buffer);

      const reopened = open(buffer);
      reopened.close();
    });

    it("should throw when resetting an open channel", async () => {
      const a = await loadRuntime();
      const buffer = a.createBuffer(65536);
      a.open(buffer);

      expect(() => a.reset(buffer)).toThrow("Channel is still open");
    });
  });

  describe("sync/async guard", () => {
    it("should throw writeSync while async write is in progress", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(4096);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const large = new Uint8Array(8192);
      const writePromise = chA.write(large);

      // yield to let the async write start and set writeLocked
      await new Promise((r) => setTimeout(r, 10));

      expect(() => chA.writeSync(new Uint8Array([1]))).toThrow(
        "Cannot writeSync while an async write is in progress",
      );

      // drain so the write completes
      await chB.read();
      await writePromise;
      chA.close();
      chB.close();
    });

    it("should throw readSync while async read is in progress", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      const readPromise = chB.read({ timeout: 1000 });

      // yield to let the async read start and set readLocked
      await new Promise((r) => setTimeout(r, 10));

      expect(() => chB.readSync()).toThrow(
        "Cannot readSync while an async read is in progress",
      );

      chA.writeSync(new Uint8Array([1]));
      await readPromise;
      chA.close();
      chB.close();
    });
  });

  describe("options", () => {
    it("should accept timeout option on write", async () => {
      const a = await loadRuntime();
      const b = await loadRuntime();
      const buffer = a.createBuffer(65536);
      const chA = a.open(buffer);
      const chB = b.open(buffer);

      chA.writeSync(new Uint8Array([1]), { timeout: 1000 });
      expect(chB.readSync({ timeout: 1000 })).toEqual(new Uint8Array([1]));

      chA.close();
      chB.close();
    });
  });
});
