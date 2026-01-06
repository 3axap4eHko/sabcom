# SABCOM

[![Github Build Status][github-image]][github-url]
[![NPM version][npm-image]][npm-url]
[![Downloads][downloads-image]][npm-url]
[![Coverage Status][codecov-image]][codecov-url]
[![Snyk][snyk-image]][snyk-url]

A TypeScript/Node.js library for high-performance inter-thread communication using `SharedArrayBuffer` with atomic operations. It provides both synchronous and asynchronous APIs to transfer byte data between threads (e.g., Main thread and Worker threads) without the overhead of structured cloning or memory copying.

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
