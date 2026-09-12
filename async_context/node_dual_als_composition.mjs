import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error('SOURCE_ROOT is required');
const loggerContext = await import(`${sourceRoot}/dist/context.js`);
const {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
} = loggerContext;

const tracingStorage = new AsyncLocalStorage();
const authStorage = new AsyncLocalStorage();
const uninstall = installLogContextProvider();

function verify(index, phase) {
  assert.equal(getLogContext()?.traceId, `logger-trace-${index}`, `logger ALS drift at ${phase}`);
  assert.equal(tracingStorage.getStore()?.spanId, `otel-span-${index}`, `tracing ALS drift at ${phase}`);
  assert.equal(authStorage.getStore()?.subject, `auth-subject-${index}`, `auth ALS drift at ${phase}`);
}

try {
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      tracingStorage.run({ spanId: `otel-span-${index}` }, () =>
        authStorage.run({ subject: `auth-subject-${index}` }, () =>
          runWithLogContext(
            {
              traceId: `logger-trace-${index}`,
              fields: { tenant: { id: `tenant-${index}` } },
            },
            async () => {
              verify(index, 'entry');
              await Promise.resolve();
              verify(index, 'promise');
              await new Promise(resolve => setImmediate(resolve));
              verify(index, 'setImmediate');
              await new Promise(resolve => setTimeout(resolve, index % 5));
              verify(index, 'setTimeout');

              await tracingStorage.run({ spanId: `nested-span-${index}` }, async () => {
                assert.equal(tracingStorage.getStore().spanId, `nested-span-${index}`);
                assert.equal(getLogContext().traceId, `logger-trace-${index}`);
                assert.equal(authStorage.getStore().subject, `auth-subject-${index}`);
                await Promise.resolve();
              });
              verify(index, 'nested tracing restoration');

              await runWithLogContext({ traceId: `nested-logger-${index}` }, async () => {
                assert.equal(getLogContext().traceId, `nested-logger-${index}`);
                assert.equal(tracingStorage.getStore().spanId, `otel-span-${index}`);
                assert.equal(authStorage.getStore().subject, `auth-subject-${index}`);
                await Promise.resolve();
              });
              verify(index, 'nested logger restoration');
            },
          ),
        ),
      ),
    ),
  );

  assert.equal(getLogContext(), undefined);
  assert.equal(tracingStorage.getStore(), undefined);
  assert.equal(authStorage.getStore(), undefined);

  await assert.rejects(
    authStorage.run({ subject: 'throwing-auth' }, () =>
      runWithLogContext({ traceId: 'throwing-logger' }, () =>
        tracingStorage.run({ spanId: 'throwing-span' }, async () => {
          await Promise.resolve();
          throw new Error('dual ALS expected failure');
        }),
      ),
    ),
    /dual ALS expected failure/,
  );
  assert.equal(getLogContext(), undefined);
  assert.equal(tracingStorage.getStore(), undefined);
  assert.equal(authStorage.getStore(), undefined);

  process.stdout.write(JSON.stringify({
    schema: 'ores-otel-test/dual-als-composition-receipt/v1',
    concurrentFlows: 256,
    stores: ['logger-context', 'otel-simulation', 'auth-simulation'],
    nestedComposition: 'pass',
    siblingIsolation: 'pass',
    failureRestoration: 'pass',
  }) + '\n');
} finally {
  uninstall();
  tracingStorage.disable();
  authStorage.disable();
}
