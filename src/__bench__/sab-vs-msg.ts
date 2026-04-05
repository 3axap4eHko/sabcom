import 'overtake';

function makePayload(size: number) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = i & 0xff;
  return buf;
}

const suite = benchmark('64B', () => makePayload(64))
  .feed('256B', () => makePayload(256))
  .feed('1KB', () => makePayload(1024))
  .feed('4KB', () => makePayload(4096))
  .feed('16KB', () => makePayload(16384));

suite
  .target('sabcom', async () => {
    const { Worker } = await import('node:worker_threads');
    const { createBuffer, open } = await import(process.cwd() + '/build/index.js');

    const buffer = createBuffer(65536);

    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { open } = require(process.cwd() + '/build/index.cjs');
       const ch = open(workerData);
       const opts = { timeout: 30000 };
       parentPort.postMessage('ready');
       while (true) {
         try {
           ch.writeSync(ch.readSync(opts), opts);
         } catch { break; }
       }`,
      { eval: true, workerData: buffer },
    );

    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
    });
    const ch = open(buffer);

    return { ch, worker };
  })
  .teardown(async ({ ch, worker }) => {
    ch.close();
    await worker.terminate();
  })
  .measure('round-trip', ({ ch }, payload) => {
    ch.writeSync(payload, { timeout: 3000 });
    return ch.readSync({ timeout: 3000 });
  });

suite
  .target('clone', async () => {
    const { Worker, MessageChannel, receiveMessageOnPort } = await import('node:worker_threads');

    const signalBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(signalBuffer);
    const { port1, port2 } = new MessageChannel();

    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { port, signalBuffer } = workerData;
       const flag = new Int32Array(signalBuffer);
       port.on('message', (msg) => {
         port.postMessage(msg);
         Atomics.store(flag, 0, 1);
         Atomics.notify(flag, 0);
       });
       parentPort.postMessage('ready');`,
      { eval: true, workerData: { port: port2, signalBuffer }, transferList: [port2] },
    );

    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
    });

    return { worker, port: port1, flag, receiveMessageOnPort };
  })
  .teardown(async ({ worker, port }) => {
    port.close();
    await worker.terminate();
  })
  .measure('round-trip', ({ port, flag, receiveMessageOnPort }, payload) => {
    port.postMessage(payload);
    Atomics.wait(flag, 0, 0);
    const msg = receiveMessageOnPort(port);
    Atomics.store(flag, 0, 0);
    return msg;
  });

suite
  .target('transfer', async () => {
    const { Worker, MessageChannel, receiveMessageOnPort } = await import('node:worker_threads');

    const signalBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(signalBuffer);
    const { port1, port2 } = new MessageChannel();

    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { port, signalBuffer } = workerData;
       const flag = new Int32Array(signalBuffer);
       port.on('message', (msg) => {
         const echo = new Uint8Array(msg);
         port.postMessage(echo, [echo.buffer]);
         Atomics.store(flag, 0, 1);
         Atomics.notify(flag, 0);
       });
       parentPort.postMessage('ready');`,
      { eval: true, workerData: { port: port2, signalBuffer }, transferList: [port2] },
    );

    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
    });

    return { worker, port: port1, flag, receiveMessageOnPort };
  })
  .teardown(async ({ worker, port }) => {
    port.close();
    await worker.terminate();
  })
  .measure('round-trip', ({ port, flag, receiveMessageOnPort }, payload) => {
    const copy = payload.slice();
    port.postMessage(copy, [copy.buffer]);
    Atomics.wait(flag, 0, 0);
    const msg = receiveMessageOnPort(port);
    Atomics.store(flag, 0, 0);
    return msg;
  });
