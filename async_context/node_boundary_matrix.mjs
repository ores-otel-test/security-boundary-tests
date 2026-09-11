import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import { Readable } from 'node:stream';

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error('SOURCE_ROOT is required');
const context = await import(`${sourceRoot}/dist/context.js`);
const {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
  updateLogContext,
} = context;

function currentTrace(expected, boundary) {
  assert.equal(getLogContext()?.traceId, expected, `context drifted at ${boundary}`);
}

async function messageChannelTick() {
  await new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.once('message', resolve);
    port1.once('messageerror', reject);
    port2.postMessage('tick');
  });
}

async function* generator(count, traceId) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
    currentTrace(traceId, `async-generator-${index}`);
    yield index;
  }
}

const uninstall = installLogContextProvider();
try {
  const tasks = Array.from({ length: 64 }, (_, index) => {
    const traceId = `boundary-${index}`;
    return runWithLogContext(
      {
        traceId,
        loggedInUser: { id: `boundary-user-${index}` },
        fields: { tenant: { id: `boundary-tenant-${index}` } },
      },
      async () => {
        currentTrace(traceId, 'entry');
        await Promise.resolve();
        currentTrace(traceId, 'promise');
        await new Promise(resolve => queueMicrotask(resolve));
        currentTrace(traceId, 'queueMicrotask');
        await new Promise(resolve => setImmediate(resolve));
        currentTrace(traceId, 'setImmediate');
        await new Promise(resolve => setTimeout(resolve, index % 3));
        currentTrace(traceId, 'setTimeout');
        await readFile(new URL('./source-under-test.json', import.meta.url));
        currentTrace(traceId, 'fs-promises');
        await messageChannelTick();
        currentTrace(traceId, 'MessageChannel');

        const raced = await Promise.race([
          new Promise(resolve => setTimeout(() => resolve('slow'), 3)),
          Promise.resolve('fast'),
        ]);
        assert.equal(raced, 'fast');
        currentTrace(traceId, 'Promise.race');

        const any = await Promise.any([
          Promise.reject(new Error('expected loser')),
          Promise.resolve('winner'),
        ]);
        assert.equal(any, 'winner');
        currentTrace(traceId, 'Promise.any');

        const generated = [];
        for await (const value of generator(4, traceId)) generated.push(value);
        assert.deepEqual(generated, [0, 1, 2, 3]);

        const streamed = [];
        for await (const value of Readable.from([0, 1, 2, 3])) {
          await Promise.resolve();
          currentTrace(traceId, `stream-${value}`);
          streamed.push(value);
        }
        assert.deepEqual(streamed, [0, 1, 2, 3]);

        for (let depth = 0; depth < 32; depth += 1) {
          await runWithLogContext(
            {
              traceId: `${traceId}-nested-${depth}`,
              fields: { nested: { depth } },
            },
            async () => {
              await Promise.resolve();
              currentTrace(`${traceId}-nested-${depth}`, `nested-${depth}`);
            },
          );
          currentTrace(traceId, `nested-restoration-${depth}`);
        }

        const patch = { fields: { mutablePatch: { value: index } } };
        assert.equal(updateLogContext(patch), true);
        patch.fields.mutablePatch.value = -1;
        await Promise.resolve();
        assert.equal(getLogContext().fields.mutablePatch.value, index, 'update retained a nested caller alias');
      },
    );
  });
  await Promise.all(tasks);
  assert.equal(getLogContext(), undefined);

  await assert.rejects(
    runWithLogContext({ traceId: 'throwing-boundary' }, async () => {
      await messageChannelTick();
      currentTrace('throwing-boundary', 'throwing-message-channel');
      throw new Error('boundary failure');
    }),
    /boundary failure/,
  );
  assert.equal(getLogContext(), undefined);

  process.stdout.write(JSON.stringify({
    schema: 'ores-otel-test/node-async-boundary-receipt/v1',
    concurrentFlows: 64,
    nestedScopesPerFlow: 32,
    boundaries: [
      'promise', 'queueMicrotask', 'setImmediate', 'setTimeout', 'fs-promises',
      'MessageChannel', 'Promise.race', 'Promise.any', 'async-generator', 'stream',
    ],
    updateSnapshotIsolation: 'pass',
    failureCleanup: 'pass',
  }) + '\n');
} finally {
  uninstall();
}
