# SABCOM

[![Github Build Status][github-image]][github-url]
[![NPM version][npm-image]][npm-url]
[![Downloads][downloads-image]][npm-url]
[![Coverage Status][codecov-image]][codecov-url]
[![Snyk][snyk-image]][snyk-url]

A TypeScript/Node.js library for high-performance inter-thread communication using `SharedArrayBuffer` with atomic operations. It provides both synchronous and asynchronous APIs to transfer byte data between threads (e.g., Main thread and Worker threads) without the overhead of structured cloning or memory copying.

## What sabcom Does

sabcom is a **protocol layer** for SharedArrayBuffer. It handles:
- Synchronization between reader and writer via Atomics
- Chunking large data that exceeds buffer size
- Timeout detection to prevent deadlocks

sabcom does **NOT**:
- Create worker threads (you create them with `worker_threads` or `new Worker()`)
- Transfer the SharedArrayBuffer between threads (you pass it via `workerData` or `postMessage`)
- Serialize data (you encode to `Uint8Array` before calling write, e.g., with `TextEncoder` or `JSON.stringify`)

## Features

- **Thread-safe communication** using `Atomics` for synchronization.
- **Async and Sync APIs** to suit different architectural needs.
- **Chunked Data Transfer** allows sending payloads larger than the buffer size.
- **Byte-only API** for explicit serialization control.
- **Configurable Timeouts** to prevent deadlocks.
- **Generator-based Low-level API** for custom flow control implementations.
- **Type-safe** with full TypeScript support.

## Installation

```bash
npm install sabcom
```

## Complete Example

Here is a complete example demonstrating communication between a main thread and a worker thread using Node.js `worker_threads`.
The `SharedArrayBuffer` is passed once via `workerData` so no `postMessage` is needed for data transfer.

**worker.ts**
```typescript
import { workerData } from 'worker_threads';
import { readSync, writeSync } from 'sabcom';

const buffer = workerData as SharedArrayBuffer;

try {
  console.log('Worker: Waiting for data...');
  const receivedData = readSync(buffer);
  const message = new TextDecoder().decode(receivedData);
  console.log('Worker: Received message:', message);

  const reply = new TextEncoder().encode(message.toUpperCase());
  writeSync(reply, buffer);
} catch (err) {
  console.error('Worker: Error', err);
  process.exit(1);
}
```

**main.ts**
```typescript
import { Worker } from 'worker_threads';
import { write, read } from 'sabcom';
import path from 'path';

async function main() {
  // 1. Create a SharedArrayBuffer (must be multiple of 4)
  // 4KB buffer
  const buffer = new SharedArrayBuffer(4096);

  // 2. Start the worker and pass the buffer via workerData
  const worker = new Worker(path.resolve(__dirname, 'worker.ts'), { workerData: buffer });

  // 3. Prepare data
  const text = "Hello from the main thread! ".repeat(500); // Larger than buffer
  const data = new TextEncoder().encode(text);

  console.log(`Main: Sending ${data.byteLength} bytes...`);

  // 4. Write data to the shared buffer
  // The 'read' operation in the worker will pick this up.
  await write(data, buffer);

  const reply = await read(buffer);
  console.log('Main: Reply:', new TextDecoder().decode(reply));
}

main().catch(console.error);
```

## Usage

### Async API
Best for non-blocking operations in the main thread or event-loop driven workers.

```typescript
import { write, read } from 'sabcom';

// Writer
await write(data, buffer);

// Reader
const result = await read(buffer);
```

### Sync API
Best for CPU-bound workers where blocking is acceptable or preferred.

```typescript
import { writeSync, readSync } from 'sabcom';

// Writer
writeSync(data, buffer);

// Reader
const result = readSync(buffer);
```

### Options

All functions accept an optional options object:

```typescript
await write(data, buffer, { 
  timeout: 10000 // Timeout in milliseconds (default: 5000)
});
```

## Buffer Sizing & Requirements

1.  **Multiple of 4**: The `byteLength` of the `SharedArrayBuffer` **must** be a multiple of 4 (e.g., 1024, 4096).
2.  **Header Overhead**: The library uses a small portion of the buffer for a header. The buffer must be larger than `HEADER_SIZE` (exported).
3.  **Performance Trade-off**:
    *   **Larger Buffer**: Fewer chunks, less synchronization overhead, faster for large data.
    *   **Smaller Buffer**: Less memory usage, more context switches/atomic operations.
    *   **Recommendation**: Start with 4KB - 64KB (`4096` - `65536`) depending on your average payload size.

## Multi-Worker Architecture

When multiple workers need to communicate with the main thread simultaneously, create a separate `SharedArrayBuffer` for each worker. Each buffer is an independent communication channel.

**main.ts**
```typescript
import { Worker } from 'worker_threads';
import { write, read } from 'sabcom';

interface WorkerChannel {
  worker: Worker;
  buffer: SharedArrayBuffer;
}

async function createWorker(id: number): Promise<WorkerChannel> {
  const buffer = new SharedArrayBuffer(4096);
  const worker = new Worker('./worker.js', {
    workerData: { id, buffer }
  });
  return { worker, buffer };
}

async function main() {
  // Create multiple workers, each with its own buffer
  const channels: WorkerChannel[] = await Promise.all([
    createWorker(0),
    createWorker(1),
    createWorker(2),
  ]);

  // Send data to all workers in parallel
  const tasks = ['task-a', 'task-b', 'task-c'];
  await Promise.all(
    channels.map((ch, i) =>
      write(new TextEncoder().encode(tasks[i]), ch.buffer)
    )
  );

  // Read responses from all workers in parallel
  const responses = await Promise.all(
    channels.map(ch => read(ch.buffer))
  );

  responses.forEach((data, i) => {
    console.log(`Worker ${i}: ${new TextDecoder().decode(data)}`);
  });

  // Cleanup
  await Promise.all(channels.map(ch => ch.worker.terminate()));
}

main();
```

**worker.ts**
```typescript
import { workerData, parentPort } from 'worker_threads';
import { readSync, writeSync } from 'sabcom';

const { id, buffer } = workerData as { id: number; buffer: SharedArrayBuffer };

// Receive task from main
const task = new TextDecoder().decode(readSync(buffer));
console.log(`Worker ${id} received: ${task}`);

// Process and respond
const result = `${task.toUpperCase()}-done`;
writeSync(new TextEncoder().encode(result), buffer);
```

### Key Points for Multi-Worker Setup

1. **One buffer per worker** - Each worker needs its own `SharedArrayBuffer`. A single buffer can only handle one reader-writer pair at a time.

2. **Buffer ownership** - Each buffer represents a bidirectional channel between main thread and one worker. Don't share a buffer between multiple workers.

3. **Parallel operations** - Use `Promise.all()` with async API (`write`/`read`) to communicate with multiple workers concurrently.

4. **Buffer pool pattern** - For dynamic worker counts, maintain a pool of buffers:

```typescript
class BufferPool {
  private available: SharedArrayBuffer[] = [];

  acquire(size = 4096): SharedArrayBuffer {
    return this.available.pop() ?? new SharedArrayBuffer(size);
  }

  release(buffer: SharedArrayBuffer): void {
    this.available.push(buffer);
  }
}
```

## Advanced: Generators

If you need fine-grained control over the transfer process (e.g., to implement a progress bar, cancellation, or custom scheduling), you can use the generator functions directly.

```typescript
import { writeGenerator } from 'sabcom';

const gen = writeGenerator(data, buffer);
let result = gen.next();

while (!result.done) {
    // Perform custom logic here (e.g. check for cancellation)
    
    // Wait for the reader signal
    const request = result.value;
    const waitResult = Atomics.wait(request.target, request.index, request.value, request.timeout);
    
    // Resume generator
    result = gen.next(waitResult);
}
```

## API Reference

### `write(data: Uint8Array, buffer: SharedArrayBuffer, options?: Options): Promise<void>`
Writes bytes to the buffer. Resolves when the reader has received all data.

### `read(buffer: SharedArrayBuffer, options?: Options): Promise<Uint8Array>`
Waits for and reads bytes from the buffer. Resolves with the complete data.

### `writeSync(data: Uint8Array, buffer: SharedArrayBuffer, options?: Options): void`
Synchronous version of `write`. Blocks until completion.

### `readSync(buffer: SharedArrayBuffer, options?: Options): Uint8Array`
Synchronous version of `read`. Blocks until data is received.

## Protocol Details

The communication follows a strict handshake:
1.  **Writer** acquires lock, writes metadata (total size, chunk count) -> `HANDSHAKE`.
2.  **Reader** acknowledges -> `READY`.
3.  **Writer** writes chunk -> `PAYLOAD`.
4.  **Reader** reads chunk, acknowledges -> `READY`.
5.  Repeat 3-4 until done.

*Note: The `SharedArrayBuffer` is reusable after a successful transfer.*

## FAQ

### What is the minimum buffer size?

`HEADER_SIZE` is 16 bytes. Your buffer must be larger to have usable payload space:

```typescript
import { HEADER_SIZE } from 'sabcom';

// Minimum: HEADER_SIZE + at least 1 byte for payload
// Practical minimum: 1024 bytes (1KB)
const buffer = new SharedArrayBuffer(1024);
```

### How do I send JSON or objects?

sabcom transfers raw bytes only. Serialize before sending:

```typescript
// Writer
const obj = { hello: 'world', count: 42 };
const json = JSON.stringify(obj);
await write(new TextEncoder().encode(json), buffer);

// Reader
const data = await read(buffer);
const obj = JSON.parse(new TextDecoder().decode(data));
```

### Does sabcom work in browsers?

Yes, with Web Workers. However, `SharedArrayBuffer` requires cross-origin isolation headers on your server:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### How do I handle errors?

```typescript
try {
  await write(data, buffer, { timeout: 5000 });
} catch (err) {
  if (err.message.includes('timeout')) {
    console.error('Reader did not respond in time');
  }
}
```

### Can I cancel a transfer mid-way?

Use generators with `for...of` - breaking out automatically triggers cleanup:

```typescript
const gen = writeGenerator(data, buffer);
for (const request of gen) {
  if (shouldCancel) break; // finally block resets buffer to READY
  const result = Atomics.wait(request.target, request.index, request.value, request.timeout);
  if (result === 'timed-out') break;
}
```

### Can I reuse the buffer after a transfer?

Yes. After a successful transfer (or error), the buffer resets to `READY` state and can be used again:

```typescript
const buffer = new SharedArrayBuffer(4096);

// First transfer
await write(data1, buffer);
const result1 = await read(buffer);

// Second transfer - same buffer
await write(data2, buffer);
const result2 = await read(buffer);
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

## License

Apache-2.0 © [Ivan Zakharchanka](https://linkedin.com/in/3axap4eHko)

[npm-url]: https://www.npmjs.com/package/sabcom
[downloads-image]: https://img.shields.io/npm/dw/sabcom.svg?maxAge=43200
[npm-image]: https://img.shields.io/npm/v/sabcom.svg?maxAge=43200
[github-url]: https://github.com/3axap4eHko/sabcom/actions
[github-image]: https://github.com/3axap4eHko/sabcom/actions/workflows/build.yml/badge.svg?branch=master
[codecov-url]: https://codecov.io/gh/3axap4eHko/sabcom
[codecov-image]: https://codecov.io/gh/3axap4eHko/sabcom/branch/master/graph/badge.svg?maxAge=43200
[snyk-url]: https://snyk.io/test/npm/sabcom/latest
[snyk-image]: https://snyk.io/test/github/3axap4eHko/sabcom/badge.svg?maxAge=43200
