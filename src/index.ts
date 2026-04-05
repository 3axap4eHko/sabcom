export interface Options {
  timeout?: number;
}

export interface Channel {
  write(data: Uint8Array, options?: Options): Promise<void>;
  read(options?: Options): Promise<Uint8Array>;
  writeSync(data: Uint8Array, options?: Options): void;
  readSync(options?: Options): Uint8Array;
  close(): void;
}

const MAGIC = 0x53424332;
const INIT_SENTINEL = -1;
const MIN_BUFFER_BYTES = 4096;
const VERSION = 2;
const HEADER_WORDS = 5;
const RING_CONTROL_WORDS = 4;
const DESCRIPTOR_WORDS = 3;
const CONTINUATION = -1;
const SLOT_OPTIONS = [256, 128, 64, 32, 16, 8];
const MIN_DATA_BYTES = 256;
const FLAG_CLOSED_A = 1;
const FLAG_CLOSED_B = 2;

const IDX_MAGIC = 0;
const IDX_VERSION = 1;
const IDX_OWNER_A = 2;
const IDX_OWNER_B = 3;
const IDX_FLAGS = 4;

const IDX_WRITE_MSG = 0;
const IDX_READ_MSG = 1;
const IDX_READ_BYTE = 3;

const IDX_DESC_OFFSET = 0;
const IDX_DESC_SIZE = 1;
const IDX_DESC_TOTAL = 2;

interface Layout {
  controlBytes: number;
  descriptorBytes: number;
  dataBytes: number;
  perDirectionBytes: number;
  ringSlots: number;
}

interface RingViews {
  control: Int32Array;
  descriptors: Int32Array;
  bytes: Uint8Array;
  dataBytes: number;
  ringSlots: number;
  ringMask: number;
}

interface State {
  header: Int32Array;
  inbound: RingViews;
  outbound: RingViews;
  ownerIndex: number;
  localClosedMask: number;
  peerClosedMask: number;
  localClosed: boolean;
  writeLocked: boolean;
  readLocked: boolean;
  readTail: Promise<void>;
  writeTail: Promise<void>;
  wMsg: number;
  wByte: number;
  rMsg: number;
  rByte: number;
  pendingAckMsg: number;
  pendingAckByte: number;
  pendingAckSize: number;
}

const layoutCache = new Map<number, Layout | null>();
const stateCache = new WeakMap<SharedArrayBuffer, State>();
const handleCache = new WeakMap<SharedArrayBuffer, Channel>();
const resolvedTail = Promise.resolve();

const roundDownToWord = (value: number): number => value & ~3;

const computeLayout = (byteLength: number): Layout | null => {
  const cached = layoutCache.get(byteLength);
  if (cached !== undefined) return cached;

  if (byteLength % Int32Array.BYTES_PER_ELEMENT !== 0 || byteLength < MIN_BUFFER_BYTES) {
    layoutCache.set(byteLength, null);
    return null;
  }

  const headerBytes = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
  const perDirectionBytes = roundDownToWord((byteLength - headerBytes) >> 1);
  const controlBytes = RING_CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT;

  for (const ringSlots of SLOT_OPTIONS) {
    const descriptorBytes = ringSlots * DESCRIPTOR_WORDS * Int32Array.BYTES_PER_ELEMENT;
    const dataBytes = perDirectionBytes - controlBytes - descriptorBytes;
    if (dataBytes >= MIN_DATA_BYTES) {
      const layout = { controlBytes, descriptorBytes, dataBytes, perDirectionBytes, ringSlots };
      layoutCache.set(byteLength, layout);
      return layout;
    }
  }

  layoutCache.set(byteLength, null);
  return null;
};

const createRingViews = (buffer: SharedArrayBuffer, byteOffset: number, layout: Layout): RingViews => {
  const descriptorOffset = byteOffset + layout.controlBytes;
  const dataOffset = descriptorOffset + layout.descriptorBytes;
  return {
    control: new Int32Array(buffer, byteOffset, RING_CONTROL_WORDS),
    descriptors: new Int32Array(buffer, descriptorOffset, layout.ringSlots * DESCRIPTOR_WORDS),
    bytes: new Uint8Array(buffer, dataOffset, layout.dataBytes),
    dataBytes: layout.dataBytes,
    ringSlots: layout.ringSlots,
    ringMask: layout.ringSlots - 1,
  };
};

const createEndpointToken = (): number => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Int32Array(1);
    do {
      crypto.getRandomValues(buf);
    } while (buf[0] === 0 || buf[0] === INIT_SENTINEL || buf[0] === MAGIC);
    return buf[0];
  }
  let token = 0;
  while (token === 0 || token === INIT_SENTINEL || token === MAGIC) {
    token = (Math.random() * 0x7fffffff) | 0;
  }
  return token;
};

const ENDPOINT_TOKEN = createEndpointToken();

const finalizeHeader = (buffer: SharedArrayBuffer, header: Int32Array): void => {
  const bodyOffset = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
  if (bodyOffset < buffer.byteLength) {
    new Int32Array(buffer, bodyOffset, (buffer.byteLength - bodyOffset) / Int32Array.BYTES_PER_ELEMENT).fill(0);
  }
  Atomics.store(header, IDX_VERSION, VERSION);
  Atomics.store(header, IDX_OWNER_A, 0);
  Atomics.store(header, IDX_OWNER_B, 0);
  Atomics.store(header, IDX_FLAGS, 0);
  Atomics.store(header, IDX_MAGIC, MAGIC);
  Atomics.notify(header, IDX_MAGIC);
};

const initializeHeaderSync = (buffer: SharedArrayBuffer, header: Int32Array): void => {
  for (;;) {
    const magic = Atomics.load(header, IDX_MAGIC);
    if (magic === MAGIC) {
      const version = Atomics.load(header, IDX_VERSION);
      if (version !== VERSION) throw new Error(`Unsupported channel version ${version}`);
      return;
    }
    if (magic === INIT_SENTINEL) {
      Atomics.wait(header, IDX_MAGIC, INIT_SENTINEL);
      continue;
    }
    if (magic !== 0) throw new Error('SharedArrayBuffer does not contain a supported channel');
    if (Atomics.compareExchange(header, IDX_MAGIC, 0, INIT_SENTINEL) !== 0) continue;
    finalizeHeader(buffer, header);
    return;
  }
};

const resetClosedHeaderSync = (buffer: SharedArrayBuffer, header: Int32Array): void => {
  for (;;) {
    const magic = Atomics.load(header, IDX_MAGIC);
    if (magic === INIT_SENTINEL) {
      Atomics.wait(header, IDX_MAGIC, INIT_SENTINEL);
      continue;
    }
    if (magic !== MAGIC) return;
    const version = Atomics.load(header, IDX_VERSION);
    if (version !== VERSION) throw new Error(`Unsupported channel version ${version}`);
    if (Atomics.load(header, IDX_OWNER_A) !== 0 || Atomics.load(header, IDX_OWNER_B) !== 0 || Atomics.load(header, IDX_FLAGS) === 0) return;
    if (Atomics.compareExchange(header, IDX_MAGIC, MAGIC, INIT_SENTINEL) !== MAGIC) continue;
    finalizeHeader(buffer, header);
    return;
  }
};

const resetHeaderSync = (buffer: SharedArrayBuffer, header: Int32Array): void => {
  initializeHeaderSync(buffer, header);
  for (;;) {
    if (Atomics.load(header, IDX_OWNER_A) !== 0 || Atomics.load(header, IDX_OWNER_B) !== 0) {
      throw new Error('Channel is still open');
    }
    if (Atomics.compareExchange(header, IDX_MAGIC, MAGIC, INIT_SENTINEL) !== MAGIC) {
      initializeHeaderSync(buffer, header);
      continue;
    }
    finalizeHeader(buffer, header);
    return;
  }
};

const claimEndpoint = (header: Int32Array): 0 | 1 => {
  const ownerA = Atomics.load(header, IDX_OWNER_A);
  if (ownerA === ENDPOINT_TOKEN) {
    Atomics.and(header, IDX_FLAGS, ~FLAG_CLOSED_A);
    return 0;
  }
  if (ownerA === 0 && Atomics.compareExchange(header, IDX_OWNER_A, 0, ENDPOINT_TOKEN) === 0) {
    Atomics.and(header, IDX_FLAGS, ~FLAG_CLOSED_A);
    return 0;
  }
  const ownerB = Atomics.load(header, IDX_OWNER_B);
  if (ownerB === ENDPOINT_TOKEN) {
    Atomics.and(header, IDX_FLAGS, ~FLAG_CLOSED_B);
    return 1;
  }
  if (ownerB === 0 && Atomics.compareExchange(header, IDX_OWNER_B, 0, ENDPOINT_TOKEN) === 0) {
    Atomics.and(header, IDX_FLAGS, ~FLAG_CLOSED_B);
    return 1;
  }
  throw new Error('SharedArrayBuffer channel already claimed by two endpoints');
};

const createState = (buffer: SharedArrayBuffer, layout: Layout): State => {
  const cached = stateCache.get(buffer);
  if (cached !== undefined) return cached;

  const byteOffset = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
  const directionA = createRingViews(buffer, byteOffset, layout);
  const directionB = createRingViews(buffer, byteOffset + layout.perDirectionBytes, layout);
  const header = new Int32Array(buffer, 0, HEADER_WORDS);
  const endpoint = claimEndpoint(header);

  const outbound = endpoint === 0 ? directionA : directionB;
  const inbound = endpoint === 0 ? directionB : directionA;

  const state: State = {
    header,
    inbound,
    outbound,
    ownerIndex: endpoint === 0 ? IDX_OWNER_A : IDX_OWNER_B,
    localClosedMask: endpoint === 0 ? FLAG_CLOSED_A : FLAG_CLOSED_B,
    peerClosedMask: endpoint === 0 ? FLAG_CLOSED_B : FLAG_CLOSED_A,
    localClosed: false,
    writeLocked: false,
    readLocked: false,
    readTail: resolvedTail,
    writeTail: resolvedTail,
    wMsg: Atomics.load(outbound.control, IDX_WRITE_MSG),
    wByte: 0,
    rMsg: Atomics.load(inbound.control, IDX_READ_MSG),
    rByte: 0,
    pendingAckMsg: 0,
    pendingAckByte: 0,
    pendingAckSize: 0,
  };

  stateCache.set(buffer, state);
  return state;
};

const getStateSync = (buffer: SharedArrayBuffer): State => {
  const cached = stateCache.get(buffer);
  if (cached !== undefined) return cached;

  const layout = computeLayout(buffer.byteLength);
  if (layout === null) throw new Error(`SharedArrayBuffer too small for channel (minimum ${MIN_BUFFER_BYTES} bytes)`);

  const header = new Int32Array(buffer, 0, HEADER_WORDS);
  initializeHeaderSync(buffer, header);
  resetClosedHeaderSync(buffer, header);
  return createState(buffer, layout);
};

const copyToRing = (ring: Uint8Array, ringOffset: number, source: Uint8Array, sourceOffset: number, size: number): void => {
  const first = Math.min(size, ring.byteLength - ringOffset);
  ring.set(source.subarray(sourceOffset, sourceOffset + first), ringOffset);
  if (first < size) ring.set(source.subarray(sourceOffset + first, sourceOffset + size), 0);
};

const copyFromRing = (target: Uint8Array, targetOffset: number, ring: Uint8Array, ringOffset: number, size: number): void => {
  const first = Math.min(size, ring.byteLength - ringOffset);
  target.set(ring.subarray(ringOffset, ringOffset + first), targetOffset);
  if (first < size) target.set(ring.subarray(0, size - first), targetOffset + first);
};

const freeWriteSpace = (ring: RingViews, writeMsg: number, writeByte: number): number => {
  const readMsg = Atomics.load(ring.control, IDX_READ_MSG);
  const pending = (writeMsg - readMsg) | 0;
  if (pending >= ring.ringSlots) return 0;
  if (pending === 0) return ring.dataBytes;
  const readByte = Atomics.load(ring.control, IDX_READ_BYTE);
  const free = ring.dataBytes - ((writeByte - readByte) | 0);
  return free > 0 ? free : 0;
};

const publishSegment = (ring: RingViews, offset: number, size: number, total: number, writeMsg: number): void => {
  const di = (writeMsg & ring.ringMask) * DESCRIPTOR_WORDS;
  ring.descriptors[di + IDX_DESC_OFFSET] = offset;
  ring.descriptors[di + IDX_DESC_SIZE] = size;
  ring.descriptors[di + IDX_DESC_TOTAL] = total;
  Atomics.store(ring.control, IDX_WRITE_MSG, (writeMsg + 1) | 0);
  Atomics.notify(ring.control, IDX_WRITE_MSG, 1);
};

const ackSegment = (ring: RingViews, readMsg: number, readByte: number, size: number): void => {
  Atomics.store(ring.control, IDX_READ_BYTE, (readByte + size) | 0);
  Atomics.store(ring.control, IDX_READ_MSG, (readMsg + 1) | 0);
  Atomics.notify(ring.control, IDX_READ_MSG, 1);
};

const flushPendingAck = (state: State): void => {
  if (state.pendingAckSize > 0) {
    ackSegment(state.inbound, state.pendingAckMsg, state.pendingAckByte, state.pendingAckSize);
    state.pendingAckSize = 0;
  }
};

const isPeerClosed = (state: State): boolean => (Atomics.load(state.header, IDX_FLAGS) & state.peerClosedMask) !== 0;

const assertOpen = (state: State): void => {
  if (state.localClosed) throw new Error('Channel is closed');
};

const assertWritable = (state: State): void => {
  assertOpen(state);
  if (isPeerClosed(state)) throw new Error('Peer channel is closed');
};

const assertReadable = (state: State, receiving: boolean): void => {
  assertOpen(state);
  if (isPeerClosed(state)) throw new Error(receiving ? 'Peer channel closed while receiving message' : 'Peer channel is closed');
};

const notifyWaiters = (state: State): void => {
  Atomics.notify(state.inbound.control, IDX_WRITE_MSG);
  Atomics.notify(state.inbound.control, IDX_READ_MSG);
  Atomics.notify(state.outbound.control, IDX_WRITE_MSG);
  Atomics.notify(state.outbound.control, IDX_READ_MSG);
};

const writeChannelSync = (data: Uint8Array, state: State, timeout: number): void => {
  if (state.writeLocked) throw new Error('Cannot writeSync while an async write is in progress');
  flushPendingAck(state);
  const ring = state.outbound;
  assertWritable(state);
  let writeMsg = state.wMsg;
  let writeByte = state.wByte;

  if (data.length === 0) {
    while (freeWriteSpace(ring, writeMsg, writeByte) === 0) {
      assertWritable(state);
      const readMsg = Atomics.load(ring.control, IDX_READ_MSG);
      if (Atomics.wait(ring.control, IDX_READ_MSG, readMsg, timeout) === 'timed-out') throw new Error('Write timeout waiting for channel space');
    }
    publishSegment(ring, (writeByte >>> 0) % ring.dataBytes, 0, 0, writeMsg);
    state.wMsg = (writeMsg + 1) | 0;
    return;
  }

  let sourceOffset = 0;
  let firstSegment = true;
  while (sourceOffset < data.length) {
    let free = freeWriteSpace(ring, writeMsg, writeByte);
    while (free === 0) {
      assertWritable(state);
      const readMsg = Atomics.load(ring.control, IDX_READ_MSG);
      if (Atomics.wait(ring.control, IDX_READ_MSG, readMsg, timeout) === 'timed-out') throw new Error('Write timeout waiting for channel space');
      free = freeWriteSpace(ring, writeMsg, writeByte);
    }
    const size = Math.min(data.length - sourceOffset, free);
    const ringOffset = (writeByte >>> 0) % ring.dataBytes;
    copyToRing(ring.bytes, ringOffset, data, sourceOffset, size);
    publishSegment(ring, ringOffset, size, firstSegment ? data.length : CONTINUATION, writeMsg);
    writeMsg = (writeMsg + 1) | 0;
    writeByte = (writeByte + size) | 0;
    state.wMsg = writeMsg;
    state.wByte = writeByte;
    sourceOffset += size;
    firstSegment = false;
  }
};

const writeChannel = async (data: Uint8Array, state: State, timeout: number): Promise<void> => {
  flushPendingAck(state);
  const ring = state.outbound;
  assertWritable(state);
  let writeMsg = state.wMsg;
  let writeByte = state.wByte;

  if (data.length === 0) {
    while (freeWriteSpace(ring, writeMsg, writeByte) === 0) {
      assertWritable(state);
      const readMsg = Atomics.load(ring.control, IDX_READ_MSG);
      if ((await Atomics.waitAsync(ring.control, IDX_READ_MSG, readMsg, timeout).value) === 'timed-out')
        throw new Error('Write timeout waiting for channel space');
    }
    publishSegment(ring, (writeByte >>> 0) % ring.dataBytes, 0, 0, writeMsg);
    state.wMsg = (writeMsg + 1) | 0;
    return;
  }

  let sourceOffset = 0;
  let firstSegment = true;
  while (sourceOffset < data.length) {
    let free = freeWriteSpace(ring, writeMsg, writeByte);
    while (free === 0) {
      assertWritable(state);
      const readMsg = Atomics.load(ring.control, IDX_READ_MSG);
      if ((await Atomics.waitAsync(ring.control, IDX_READ_MSG, readMsg, timeout).value) === 'timed-out')
        throw new Error('Write timeout waiting for channel space');
      free = freeWriteSpace(ring, writeMsg, writeByte);
    }
    const size = Math.min(data.length - sourceOffset, free);
    const ringOffset = (writeByte >>> 0) % ring.dataBytes;
    copyToRing(ring.bytes, ringOffset, data, sourceOffset, size);
    publishSegment(ring, ringOffset, size, firstSegment ? data.length : CONTINUATION, writeMsg);
    writeMsg = (writeMsg + 1) | 0;
    writeByte = (writeByte + size) | 0;
    state.wMsg = writeMsg;
    state.wByte = writeByte;
    sourceOffset += size;
    firstSegment = false;
  }
};

const readChannelSync = (state: State, timeout: number): Uint8Array => {
  if (state.readLocked) throw new Error('Cannot readSync while an async read is in progress');
  const ring = state.inbound;

  flushPendingAck(state);

  let readMsg = state.rMsg;
  let readByte = state.rByte;

  while (readMsg === Atomics.load(ring.control, IDX_WRITE_MSG)) {
    assertReadable(state, false);
    if (Atomics.wait(ring.control, IDX_WRITE_MSG, readMsg, timeout) === 'timed-out') throw new Error('Read timeout');
  }

  const di = (readMsg & ring.ringMask) * DESCRIPTOR_WORDS;
  const offset = ring.descriptors[di + IDX_DESC_OFFSET];
  const size = ring.descriptors[di + IDX_DESC_SIZE];
  const total = ring.descriptors[di + IDX_DESC_TOTAL];

  if (offset < 0 || offset >= ring.dataBytes || size < 0 || size > ring.dataBytes) throw new Error('Invalid descriptor');
  if (total < 0) throw new Error('Invalid descriptor');

  // Single-segment, contiguous in ring: zero-copy with deferred ack
  if (size === total && offset + size <= ring.dataBytes) {
    state.pendingAckMsg = readMsg;
    state.pendingAckByte = readByte;
    state.pendingAckSize = size;
    state.rMsg = (readMsg + 1) | 0;
    state.rByte = (readByte + size) | 0;
    if (size === 0) return new Uint8Array(0);
    return new Uint8Array(ring.bytes.buffer, ring.bytes.byteOffset + offset, size);
  }

  // Multi-segment or wrapping: allocate + copy + immediate ack
  const data = new Uint8Array(total);
  const targetSize = total;
  let targetOffset = 0;

  if (targetOffset + size > targetSize) throw new Error('Invalid descriptor');
  if (size > 0) copyFromRing(data, targetOffset, ring.bytes, offset, size);
  targetOffset += size;
  ackSegment(ring, readMsg, readByte, size);
  readMsg = (readMsg + 1) | 0;
  readByte = (readByte + size) | 0;
  state.rMsg = readMsg;
  state.rByte = readByte;

  while (targetOffset < targetSize) {
    while (readMsg === Atomics.load(ring.control, IDX_WRITE_MSG)) {
      assertReadable(state, true);
      if (Atomics.wait(ring.control, IDX_WRITE_MSG, readMsg, timeout) === 'timed-out') throw new Error('Read timeout waiting for segment');
    }

    const di2 = (readMsg & ring.ringMask) * DESCRIPTOR_WORDS;
    const off2 = ring.descriptors[di2 + IDX_DESC_OFFSET];
    const sz2 = ring.descriptors[di2 + IDX_DESC_SIZE];
    const tot2 = ring.descriptors[di2 + IDX_DESC_TOTAL];

    if (off2 < 0 || off2 >= ring.dataBytes || sz2 < 0 || sz2 > ring.dataBytes) throw new Error('Invalid descriptor');
    if (tot2 !== CONTINUATION) throw new Error('Invalid descriptor');
    if (targetOffset + sz2 > targetSize) throw new Error('Invalid descriptor');

    if (sz2 > 0) copyFromRing(data, targetOffset, ring.bytes, off2, sz2);
    targetOffset += sz2;
    ackSegment(ring, readMsg, readByte, sz2);
    readMsg = (readMsg + 1) | 0;
    readByte = (readByte + sz2) | 0;
    state.rMsg = readMsg;
    state.rByte = readByte;
  }

  return data;
};

const readChannel = async (state: State, timeout: number): Promise<Uint8Array> => {
  const ring = state.inbound;

  flushPendingAck(state);

  let readMsg = state.rMsg;
  let readByte = state.rByte;

  while (readMsg === Atomics.load(ring.control, IDX_WRITE_MSG)) {
    assertReadable(state, false);
    if ((await Atomics.waitAsync(ring.control, IDX_WRITE_MSG, readMsg, timeout).value) === 'timed-out') throw new Error('Read timeout');
  }

  const di = (readMsg & ring.ringMask) * DESCRIPTOR_WORDS;
  const offset = ring.descriptors[di + IDX_DESC_OFFSET];
  const size = ring.descriptors[di + IDX_DESC_SIZE];
  const total = ring.descriptors[di + IDX_DESC_TOTAL];

  if (offset < 0 || offset >= ring.dataBytes || size < 0 || size > ring.dataBytes) throw new Error('Invalid descriptor');
  if (total < 0) throw new Error('Invalid descriptor');

  if (size === total && offset + size <= ring.dataBytes) {
    state.pendingAckMsg = readMsg;
    state.pendingAckByte = readByte;
    state.pendingAckSize = size;
    state.rMsg = (readMsg + 1) | 0;
    state.rByte = (readByte + size) | 0;
    if (size === 0) return new Uint8Array(0);
    return new Uint8Array(ring.bytes.buffer, ring.bytes.byteOffset + offset, size);
  }

  const data = new Uint8Array(total);
  const targetSize = total;
  let targetOffset = 0;

  if (targetOffset + size > targetSize) throw new Error('Invalid descriptor');
  if (size > 0) copyFromRing(data, targetOffset, ring.bytes, offset, size);
  targetOffset += size;
  ackSegment(ring, readMsg, readByte, size);
  readMsg = (readMsg + 1) | 0;
  readByte = (readByte + size) | 0;
  state.rMsg = readMsg;
  state.rByte = readByte;

  while (targetOffset < targetSize) {
    while (readMsg === Atomics.load(ring.control, IDX_WRITE_MSG)) {
      assertReadable(state, true);
      if ((await Atomics.waitAsync(ring.control, IDX_WRITE_MSG, readMsg, timeout).value) === 'timed-out') throw new Error('Read timeout waiting for segment');
    }

    const di2 = (readMsg & ring.ringMask) * DESCRIPTOR_WORDS;
    const off2 = ring.descriptors[di2 + IDX_DESC_OFFSET];
    const sz2 = ring.descriptors[di2 + IDX_DESC_SIZE];
    const tot2 = ring.descriptors[di2 + IDX_DESC_TOTAL];

    if (off2 < 0 || off2 >= ring.dataBytes || sz2 < 0 || sz2 > ring.dataBytes) throw new Error('Invalid descriptor');
    if (tot2 !== CONTINUATION) throw new Error('Invalid descriptor');
    if (targetOffset + sz2 > targetSize) throw new Error('Invalid descriptor');

    if (sz2 > 0) copyFromRing(data, targetOffset, ring.bytes, off2, sz2);
    targetOffset += sz2;
    ackSegment(ring, readMsg, readByte, sz2);
    readMsg = (readMsg + 1) | 0;
    readByte = (readByte + sz2) | 0;
    state.rMsg = readMsg;
    state.rByte = readByte;
  }

  return data;
};

const runExclusive = async <T>(state: State, key: 'readTail' | 'writeTail', task: () => Promise<T>): Promise<T> => {
  const previous = state[key];
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  state[key] = previous.then(
    () => next,
    () => next,
  );
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
};

const closeState = (buffer: SharedArrayBuffer, state: State): void => {
  if (state.localClosed) return;
  flushPendingAck(state);
  state.localClosed = true;
  Atomics.or(state.header, IDX_FLAGS, state.localClosedMask);
  Atomics.compareExchange(state.header, state.ownerIndex, ENDPOINT_TOKEN, 0);
  notifyWaiters(state);
  handleCache.delete(buffer);
  stateCache.delete(buffer);
};

export const createBuffer = (byteLength: number): SharedArrayBuffer => {
  if (byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) throw new Error('SharedArrayBuffer byteLength must be a multiple of 4');
  const buffer = new SharedArrayBuffer(byteLength);
  if (computeLayout(buffer.byteLength) === null) throw new Error(`SharedArrayBuffer too small for channel (minimum ${MIN_BUFFER_BYTES} bytes)`);
  initializeHeaderSync(buffer, new Int32Array(buffer, 0, HEADER_WORDS));
  return buffer;
};

export const open = (buffer: SharedArrayBuffer): Channel => {
  const cached = handleCache.get(buffer);
  if (cached !== undefined) return cached;

  if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) throw new Error('SharedArrayBuffer byteLength must be a multiple of 4');

  const state = getStateSync(buffer);

  const channel: Channel = {
    write: (data, options) =>
      runExclusive(state, 'writeTail', async () => {
        state.writeLocked = true;
        try {
          await writeChannel(data, state, options?.timeout ?? 5000);
        } finally {
          state.writeLocked = false;
        }
      }),
    read: (options) =>
      runExclusive(state, 'readTail', async () => {
        state.readLocked = true;
        try {
          return await readChannel(state, options?.timeout ?? 5000);
        } finally {
          state.readLocked = false;
        }
      }),
    writeSync: (data, options) => writeChannelSync(data, state, options?.timeout ?? 5000),
    readSync: (options) => readChannelSync(state, options?.timeout ?? 5000),
    close: () => closeState(buffer, state),
  };

  handleCache.set(buffer, channel);
  return channel;
};

export const reset = (buffer: SharedArrayBuffer): void => {
  if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) throw new Error('SharedArrayBuffer byteLength must be a multiple of 4');
  if (computeLayout(buffer.byteLength) === null) throw new Error(`SharedArrayBuffer too small for channel (minimum ${MIN_BUFFER_BYTES} bytes)`);
  const cached = stateCache.get(buffer);
  if (cached !== undefined && !cached.localClosed) throw new Error('Channel is still open in this runtime');
  resetHeaderSync(buffer, new Int32Array(buffer, 0, HEADER_WORDS));
  handleCache.delete(buffer);
  stateCache.delete(buffer);
};
