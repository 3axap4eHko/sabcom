import { serialize } from 'node:v8';
import { read, write, SEMAPHORE, HEADER_VALUES, HEADER_SIZE, Semaphore, Handshake, Header } from '../index';

describe('sabsync test suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should have correct header size', () => {
    const handshakeValues = Object.values(Handshake).filter(v => typeof v === 'number').length;
    const headerValues = Object.values(Header).filter(v => typeof v === 'number').length;
    expect(1 + Math.max(handshakeValues, headerValues)).toEqual(HEADER_VALUES);
  });

  it('should write data', async () => {
    const capacity = 1024;

    const data = { foo: 'bar', num: 42 };
    const serialized = serialize(data);
    const totalSize = serialized.length;
    const chunkSize = capacity - HEADER_SIZE;
    const totalChunks = Math.ceil(totalSize / chunkSize);

    const expectedBuffer = new SharedArrayBuffer(capacity);
    const expectedHeader = new Int32Array(expectedBuffer);
    expectedHeader[SEMAPHORE] = Semaphore.HANDSHAKE;
    expectedHeader[Handshake.TOTAL_SIZE] = totalSize;
    expectedHeader[Handshake.TOTAL_CHUNKS] = totalChunks;

    const expectedPayload = new Uint8Array(expectedBuffer, HEADER_SIZE);

    const store = jest.spyOn(Atomics, 'store');
    const notify = jest.spyOn(Atomics, 'notify');
    const wait = jest.spyOn(Atomics, 'wait');

    wait.mockImplementationOnce((_, index, type) => {
      expect(index).toEqual(SEMAPHORE);
      expect(type).toEqual(Semaphore.HANDSHAKE);
      expect(store).toHaveBeenCalledWith(expectedHeader, SEMAPHORE, Semaphore.HANDSHAKE);
      expect(notify).toHaveBeenCalledWith(expectedHeader, SEMAPHORE);

      expectedPayload.set(serialized, 0);
      expectedHeader[SEMAPHORE] = Semaphore.PAYLOAD;
      expectedHeader[Header.CHUNK_INDEX] = 0;
      expectedHeader[Header.CHUNK_OFFSET] = 0;
      expectedHeader[Header.CHUNK_SIZE] = totalSize;

      wait.mockImplementationOnce((_, index, type) => {
        expect(index).toEqual(SEMAPHORE);
        expect(type).toEqual(Semaphore.PAYLOAD);
        expect(store).toHaveBeenCalledWith(expectedHeader, SEMAPHORE, Semaphore.PAYLOAD);
        expect(notify).toHaveBeenCalledWith(expectedHeader, SEMAPHORE);

        return 'ok';
      });

      return 'ok';
    });

    const buffer = new SharedArrayBuffer(capacity);
    write(data, buffer);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('should read data', async () => {
    const capacity = 1024;
    const data = { foo: 'bar', num: 42 };
    const serialized = serialize(data);
    const totalSize = serialized.length;
    const chunkSize = capacity - HEADER_SIZE;
    const totalChunks = Math.ceil(totalSize / chunkSize);

    const buffer = new SharedArrayBuffer(capacity);
    const header = new Int32Array(buffer);
    header[SEMAPHORE] = Semaphore.HANDSHAKE;
    header[Handshake.TOTAL_SIZE] = totalSize;
    header[Handshake.TOTAL_CHUNKS] = totalChunks;

    const payload = new Uint8Array(buffer, HEADER_SIZE);
    payload.set(serialized, 0);

    const store = jest.spyOn(Atomics, 'store');
    const notify = jest.spyOn(Atomics, 'notify');
    const wait = jest.spyOn(Atomics, 'wait');

    wait.mockImplementationOnce((_, index, type) => {
      expect(index).toEqual(SEMAPHORE);
      expect(type).toEqual(Semaphore.READY);
      return 'ok';
    });

    wait.mockImplementationOnce((_, index, type) => {
      expect(index).toEqual(SEMAPHORE);
      expect(type).toEqual(Semaphore.READY);
      // Simulate writer setting payload state
      header[SEMAPHORE] = Semaphore.PAYLOAD;
      header[Header.CHUNK_INDEX] = 0;
      header[Header.CHUNK_OFFSET] = 0;
      header[Header.CHUNK_SIZE] = totalSize;
      return 'ok';
    });

    const result = read(buffer);

    expect(result).toEqual(data);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledWith(header, SEMAPHORE, Semaphore.READY);
    expect(notify).toHaveBeenCalledWith(header, SEMAPHORE);
  });

  describe('write exceptions', () => {
    it('should throw on reader handshake timeout', () => {
      const buffer = new SharedArrayBuffer(1024);
      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValue('timed-out');

      expect(() => write({ test: 'data' }, buffer, { timeout: 100 })).toThrow('Reader handshake timeout');
    });

    it('should throw on reader timeout for chunk', () => {
      const buffer = new SharedArrayBuffer(1024);
      const wait = jest.spyOn(Atomics, 'wait');

      wait.mockReturnValueOnce('ok');
      wait.mockReturnValueOnce('timed-out');

      expect(() => write({ test: 'data' }, buffer, { timeout: 100 })).toThrow('Reader timeout on chunk 0/0');
    });

    it('should reset semaphore to READY on error', () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      const wait = jest.spyOn(Atomics, 'wait');
      const store = jest.spyOn(Atomics, 'store');

      wait.mockReturnValue('timed-out');

      try {
        write({ test: 'data' }, buffer, { timeout: 100 });
      } catch {
        // ignore
      }

      expect(store).toHaveBeenLastCalledWith(header, SEMAPHORE, Semaphore.READY);
    });
  });

  describe('read exceptions', () => {
    it('should throw on handshake timeout', () => {
      const buffer = new SharedArrayBuffer(1024);
      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValue('timed-out');

      expect(() => read(buffer, { timeout: 100 })).toThrow('Handshake timeout');
    });

    it('should throw on invalid handshake state', () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.PAYLOAD; // Wrong state

      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValue('ok');

      expect(() => read(buffer)).toThrow('Invalid handshake state');
    });

    it('should throw on writer timeout waiting for chunk', () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;

      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValueOnce('ok');
      wait.mockReturnValueOnce('timed-out');

      expect(() => read(buffer, { timeout: 100 })).toThrow('Writer timeout waiting for chunk 0');
    });

    it('should throw when expected payload header is wrong', () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 1;

      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValueOnce('ok');
      wait.mockImplementationOnce(() => {
        header[SEMAPHORE] = Semaphore.HANDSHAKE;
        return 'ok';
      });

      expect(() => read(buffer)).toThrow('Expected payload header, received HANDSHAKE');
    });

    it('should throw on reader integrity failure for chunk mismatch', () => {
      const buffer = new SharedArrayBuffer(1024);
      const header = new Int32Array(buffer);
      header[SEMAPHORE] = Semaphore.HANDSHAKE;
      header[Handshake.TOTAL_SIZE] = 100;
      header[Handshake.TOTAL_CHUNKS] = 2;

      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValueOnce('ok');

      wait.mockImplementationOnce(() => {
        header[SEMAPHORE] = Semaphore.PAYLOAD;
        header[Header.CHUNK_INDEX] = 0;
        header[Header.CHUNK_OFFSET] = 0;
        header[Header.CHUNK_SIZE] = 50;
        return 'ok';
      });

      wait.mockImplementationOnce(() => {
        header[SEMAPHORE] = Semaphore.PAYLOAD;
        header[Header.CHUNK_INDEX] = 0;
        header[Header.CHUNK_OFFSET] = 50;
        header[Header.CHUNK_SIZE] = 50;
        return 'ok';
      });

      expect(() => read(buffer)).toThrow('Reader integrity failure for chunk 0 expected 1');
    });
  });

  describe('multi-chunk scenarios', () => {
    it('should handle timeout on second chunk during write', () => {
      const bufferSize = HEADER_SIZE + 16;
      const buffer = new SharedArrayBuffer(bufferSize);

      const data = { test: 'hello world test data' };

      const wait = jest.spyOn(Atomics, 'wait');
      wait.mockReturnValueOnce('ok');
      wait.mockReturnValueOnce('ok');
      wait.mockReturnValueOnce('timed-out');

      expect(() => write(data, buffer, { timeout: 100 })).toThrow(/Reader timeout on chunk 1\/\d+/);
    });
  });
});
