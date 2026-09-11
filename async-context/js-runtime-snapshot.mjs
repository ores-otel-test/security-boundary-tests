#!/usr/bin/env node
const sourceRoot = new URL(`file://${process.argv[2] ?? 'source'}/`).href;
const contextUrl = new URL('dist/context.js', sourceRoot).href;
const executionUrl = new URL('dist/execution-context.js', sourceRoot).href;
const {
  captureLogContext,
  getLogContext,
  runWithCapturedLogContext,
  runWithLogContext,
} = await import(contextUrl);
const {
  captureExecutionLogContext,
  getExecutionLogContext,
  runWithCapturedExecutionLogContext,
  runWithExecutionLogContext,
} = await import(executionUrl);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const caller = { id: 'tenant-original', nested: { roles: ['admin'] } };
let captured;
await runWithLogContext(
  { traceId: 'trace-runtime', fields: { tenant: caller } },
  async () => {
    await Promise.resolve();
    captured = captureLogContext();
  },
);
caller.id = 'tenant-mutated';
caller.nested.roles[0] = 'mutated';

await runWithCapturedLogContext(captured, async () => {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 1));
  const value = getLogContext();
  check(value.traceId === 'trace-runtime', 'trace lost across async boundary');
  check(value.fields.tenant.id === 'tenant-original', 'top-level nested mutation leaked');
  check(value.fields.tenant.nested.roles[0] === 'admin', 'deep nested mutation leaked');
  value.fields.tenant.nested.roles.push('reader');
});
runWithCapturedLogContext(captured, () => {
  check(
    getLogContext().fields.tenant.nested.roles.length === 1,
    'reader mutation leaked back into captured snapshot',
  );
});
check(getLogContext() === undefined, 'base context leaked after restoration');

const meta = [{ retry: { count: 1 } }];
let rich;
runWithExecutionLogContext(
  { requestId: 'request-runtime', context: [{ request: { id: 'one' } }], meta },
  () => { rich = captureExecutionLogContext(); },
);
meta[0].retry.count = 99;
runWithCapturedExecutionLogContext(rich, () => {
  const value = getExecutionLogContext();
  check(value.meta[0].retry.count === 1, 'execution meta mutation leaked');
  check(value.context[0].request.id === 'one', 'execution context mutation leaked');
});
check(getExecutionLogContext() === undefined, 'execution context leaked after restoration');

const count = 200;
const observed = await Promise.all(
  Array.from({ length: count }, (_, index) =>
    runWithLogContext(
      { traceId: `trace-${index}`, fields: { nested: { index } } },
      async () => {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, index % 5));
        return [getLogContext().traceId, getLogContext().fields.nested.index];
      },
    ),
  ),
);
for (let index = 0; index < count; index += 1) {
  check(observed[index][0] === `trace-${index}`, `trace collision at ${index}`);
  check(observed[index][1] === index, `field collision at ${index}`);
}
console.log(`runtime snapshot isolation passed ${count} overlapping scopes`);
