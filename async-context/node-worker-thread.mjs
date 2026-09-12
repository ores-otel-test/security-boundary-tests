#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';

function contextModule(root) {
  return pathToFileURL(resolve(root, 'dist/context.js')).href;
}

if (!isMainThread) {
  const {
    getLogContext,
    runWithCapturedLogContext,
  } = await import(contextModule(workerData.sourceRoot));

  parentPort.on('message', async (message) => {
    if (message.type === 'close') {
      parentPort.postMessage({ type: 'closed' });
      return;
    }
    const snapshot = message.hasSnapshot ? message.snapshot : undefined;
    const observed = await runWithCapturedLogContext(snapshot, async () => {
      await Promise.resolve();
      await new Promise((resolveTimer) => setTimeout(resolveTimer, message.index % 5));
      const value = getLogContext();
      return value === undefined
        ? null
        : {
            traceId: value.traceId,
            tenant: value.fields?.tenant?.id,
            index: value.fields?.nested?.index,
          };
    });
    parentPort.postMessage({
      type: 'result',
      id: message.id,
      observed,
      outside: getLogContext() ?? null,
    });
  });
} else {
  const sourceRoot = resolve(process.argv[2] ?? 'source');
  const {
    captureLogContext,
    getLogContext,
    runWithLogContext,
  } = await import(contextModule(sourceRoot));

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { sourceRoot },
  });
  const pending = new Map();
  worker.on('message', (message) => {
    if (message.type === 'result') {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry?.resolve(message);
    }
  });
  worker.on('error', (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });

  function send(id, snapshot, index) {
    return new Promise((resolveMessage, rejectMessage) => {
      pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
      worker.postMessage({
        type: 'probe',
        id,
        index,
        hasSnapshot: snapshot !== undefined,
        snapshot,
      });
    });
  }

  try {
    const callerOwned = { id: 'tenant-a' };
    let first;
    await runWithLogContext(
      { traceId: 'trace-a', fields: { tenant: callerOwned, nested: { index: 1 } } },
      async () => {
        first = captureLogContext();
        await Promise.resolve();
      },
    );
    callerOwned.id = 'mutated-after-capture';

    let second;
    runWithLogContext(
      { traceId: 'trace-b', fields: { tenant: { id: 'tenant-b' }, nested: { index: 2 } } },
      () => { second = captureLogContext(); },
    );

    const firstResult = await send('first', first, 1);
    const secondResult = await send('second', second, 2);
    const absentResult = await send('absent', undefined, 3);

    assert.deepEqual(firstResult.observed, {
      traceId: 'trace-a',
      tenant: 'tenant-a',
      index: 1,
    });
    assert.deepEqual(secondResult.observed, {
      traceId: 'trace-b',
      tenant: 'tenant-b',
      index: 2,
    });
    assert.equal(absentResult.observed, null);
    assert.equal(firstResult.outside, null);
    assert.equal(secondResult.outside, null);
    assert.equal(absentResult.outside, null);

    const count = 300;
    const snapshots = [];
    for (let index = 0; index < count; index += 1) {
      runWithLogContext(
        {
          traceId: `trace-${index}`,
          fields: {
            tenant: { id: `tenant-${index}` },
            nested: { index },
          },
        },
        () => snapshots.push(captureLogContext()),
      );
    }
    const results = await Promise.all(
      snapshots.map((snapshot, index) => send(`stress-${index}`, snapshot, index)),
    );
    for (let index = 0; index < results.length; index += 1) {
      assert.deepEqual(results[index].observed, {
        traceId: `trace-${index}`,
        tenant: `tenant-${index}`,
        index,
      });
      assert.equal(results[index].outside, null);
    }
    assert.equal(getLogContext(), undefined);
    console.log(`worker-thread context boundary passed ${count + 3} probes`);
  } finally {
    await worker.terminate();
  }
}
