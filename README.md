# SABCOM 

[![Github Build Status][github-image]][github-url]
[![NPM version][npm-image]][npm-url]
[![Downloads][downloads-image]][npm-url]
[![Coverage Status][codecov-image]][codecov-url]
[![Snyk][snyk-image]][snyk-url]

A TypeScript/Node.js library for inter-thread communication using SharedArrayBuffer with atomic operations and V8 serialization.

## Features

- **Thread-safe communication** using atomic operations
- **Chunked data transfer** for large payloads
- **V8 serialization** for complex data types
- **Timeout handling** with configurable timeouts
- **Zero-copy operations** where possible

## Installation

```bash
npm install sabcom
```

## Usage

### Basic Example

```typescript
import { write, read } from 'sabcom';

// Create a shared buffer (1MB)
const buffer = new SharedArrayBuffer(1024 * 1024);

// Writer thread
const data = { message: 'Hello World', numbers: [1, 2, 3, 4, 5] };
write(data, buffer);

// Reader thread
const received = read(buffer);
console.log(received); // { message: 'Hello World', numbers: [1, 2, 3, 4, 5] }
```

### With Custom Timeout

```typescript
// 10 second timeout
write(data, buffer, 10000);
const received = read(buffer, 10000);
```

## API Reference

### `write(data: unknown, buffer: SharedArrayBuffer, timeout?: number): void`

Writes data to the shared buffer using chunked transfer.

- `data` - Any serializable data
- `buffer` - SharedArrayBuffer for communication
- `timeout` - Timeout in milliseconds (default: 5000)

**Throws:**
- `Error` - On handshake or chunk timeout

### `read(buffer: SharedArrayBuffer, timeout?: number): unknown`

Reads data from the shared buffer.

- `buffer` - SharedArrayBuffer for communication  
- `timeout` - Timeout in milliseconds (default: 5000)

**Returns:** Deserialized data

**Throws:**
- `Error` - On timeout or integrity failure

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

Uses `Atomics.wait()`, `Atomics.notify()`, and `Atomics.store()` for synchronization. Requires SharedArrayBuffer support and proper threading context.

## Requirements

- Node.js with SharedArrayBuffer support
- Multi-threaded environment (Worker threads, etc.)
- V8 engine for serialization


## License

License [The MIT License](./LICENSE)
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
