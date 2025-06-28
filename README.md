# SABCOM

[![Github Build Status][github-image]][github-url]
[![NPM version][npm-image]][npm-url]
[![Downloads][downloads-image]][npm-url]
[![Coverage Status][codecov-image]][codecov-url]
[![Snyk][snyk-image]][snyk-url]

A TypeScript/Node.js library for inter-thread communication using SharedArrayBuffer with atomic operations and V8 serialization.

## Features

- **Thread-safe communication** using atomic operations
- **Async and sync APIs** for different use cases
- **Chunked data transfer** for large payloads
- **V8 serialization** for complex data types
- **Timeout handling** with configurable timeouts
- **Zero-copy operations** where possible
- **Generator-based** low-level API for custom implementations

## Installation

```bash
npm install sabcom
```

## Usage

### Async Example

```typescript
import { write, read } from 'sabcom';

// Create a shared buffer (1MB)
const buffer = new SharedArrayBuffer(1024 * 1024);

// Writer thread (async)
const data = { message: 'Hello World', numbers: [1, 2, 3, 4, 5] };
await write(data, buffer);

// Reader thread (async)
const received = await read(buffer);
console.log(received); // { message: 'Hello World', numbers: [1, 2, 3, 4, 5] }
```

### Sync Example

```typescript
import { writeSync, readSync } from 'sabcom';

// Writer thread (sync)
writeSync(data, buffer);

// Reader thread (sync)
const received = readSync(buffer);
```

### With Custom Timeout

```typescript
// 10 second timeout
await write(data, buffer, { timeout: 10000 });
const received = await read(buffer, { timeout: 10000 });

// Sync with timeout
writeSync(data, buffer, { timeout: 10000 });
const received = readSync(buffer, { timeout: 10000 });
```

## API Reference

### Async Functions

#### `write(data: unknown, buffer: SharedArrayBuffer, options?: Options): Promise<void>`

Asynchronously writes data to the shared buffer using chunked transfer.

- `data` - Any serializable data
- `buffer` - SharedArrayBuffer for communication
- `options` - Optional configuration object
  - `timeout` - Timeout in milliseconds (default: 5000)

**Throws:**
- `Error` - On handshake or chunk timeout

#### `read(buffer: SharedArrayBuffer, options?: Options): Promise<unknown>`

Asynchronously reads data from the shared buffer.

- `buffer` - SharedArrayBuffer for communication
- `options` - Optional configuration object
  - `timeout` - Timeout in milliseconds (default: 5000)

**Returns:** Promise resolving to deserialized data

**Throws:**
- `Error` - On timeout or integrity failure

### Sync Functions

#### `writeSync(data: unknown, buffer: SharedArrayBuffer, options?: Options): void`

Synchronously writes data to the shared buffer using chunked transfer.

- `data` - Any serializable data
- `buffer` - SharedArrayBuffer for communication
- `options` - Optional configuration object
  - `timeout` - Timeout in milliseconds (default: 5000)

**Throws:**
- `Error` - On handshake or chunk timeout

#### `readSync(buffer: SharedArrayBuffer, options?: Options): unknown`

Synchronously reads data from the shared buffer.

- `buffer` - SharedArrayBuffer for communication
- `options` - Optional configuration object
  - `timeout` - Timeout in milliseconds (default: 5000)

**Returns:** Deserialized data

**Throws:**
- `Error` - On timeout or integrity failure

### Low-level Generator Functions

#### `writeGenerator(data: unknown, buffer: SharedArrayBuffer, options?: Options): Generator<WaitRequest, void, WaitResponse>`

Generator function for custom write implementations.

#### `readGenerator(buffer: SharedArrayBuffer, options?: Options): Generator<WaitRequest, unknown, WaitResponse>`

Generator function for custom read implementations.

### Types

```typescript
interface Options {
  timeout?: number;
}

interface WaitRequest {
  target: Int32Array;
  index: number;
  value: number;
  timeout?: number;
}

type WaitResponse = ReturnType<typeof Atomics.wait>;
```

## Protocol

The library uses a header-based protocol with atomic operations:

1. **READY** - Buffer available for new transfer
2. **HANDSHAKE** - Writer sends total size and chunk count
3. **PAYLOAD** - Chunked data transfer with integrity checks

### Buffer Layout

```
[Header: 4 * HEADER_VALUES bytes] [Payload: remaining bytes]
```

## Error Handling

- **Handshake timeout** - Reader not ready within timeout
- **Chunk timeout** - Individual chunk transfer timeout
- **Integrity failure** - Chunk index mismatch
- **Invalid state** - Unexpected semaphore state

## Thread Safety

- **Async functions** (`write`, `read`) use `Atomics.waitAsync()` for non-blocking operations
- **Sync functions** (`writeSync`, `readSync`) use `Atomics.wait()` for blocking operations  
- All functions use `Atomics.store()` and `Atomics.notify()` for synchronization
- Requires SharedArrayBuffer support and proper threading context

## Requirements

- Node.js with SharedArrayBuffer support
- Multi-threaded environment (Worker threads, etc.)
- V8 engine for serialization


## License

License [Apache-2.0](./LICENSE)
Copyright (c) 2025 Ivan Zakharchanka

[npm-url]: https://www.npmjs.com/package/sabcom
[downloads-image]: https://img.shields.io/npm/dw/sabcom.svg?maxAge=43200
[npm-image]: https://img.shields.io/npm/v/sabcom.svg?maxAge=43200
[github-url]: https://github.com/3axap4eHko/sabcom/actions
[github-image]: https://github.com/3axap4eHko/sabcom/actions/workflows/build.yml/badge.svg?branch=master
[codecov-url]: https://codecov.io/gh/3axap4eHko/sabcom
[codecov-image]: https://codecov.io/gh/3axap4eHko/sabcom/branch/master/graph/badge.svg?maxAge=43200
[snyk-url]: https://snyk.io/test/npm/sabcom/latest
[snyk-image]: https://snyk.io/test/github/3axap4eHko/sabcom/badge.svg?maxAge=43200
