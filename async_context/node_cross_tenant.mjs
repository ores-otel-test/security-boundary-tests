import assert from 'node:assert/strict';

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error('SOURCE_ROOT is required');

const base = await import(`${sourceRoot}/dist/base-logger.js`);
const context = await import(`${sourceRoot}/dist/context.js`);

const {
  createLogger,
} = base;
const {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
  updateLogContext,
} = context;

const records = [];
const logger = createLogger({
  appName: 'async-context-security-canary',
  console: false,
  transports: { write: record => void records.push(record) },
});

const uninstall = installLogContextProvider();
try {
  const source = {
    loggedInUser: {
      id: 'user-original',
      profile: { roles: ['reader'], preferences: { locale: 'en' } },
    },
    traceId: 'trace-original',
    fields: {
      tenant: { id: 'tenant-original', regions: ['west'] },
      request: { id: 'request-original', attempt: 1 },
    },
    baggage: { routing: { shard: 'a' } },
    context: [{ transaction: { id: 'txn-original' } }],
    meta: [{ policy: { id: 'policy-original' } }],
  };

  await runWithLogContext(source, async () => {
    source.loggedInUser.profile.roles.push('admin');
    source.fields.tenant.id = 'tenant-mutated';
    source.fields.tenant.regions.push('east');
    source.fields.request.attempt = 99;
    source.baggage.routing.shard = 'z';
    source.context[0].transaction.id = 'txn-mutated';
    source.meta[0].policy.id = 'policy-mutated';

    await Promise.resolve();
    const observed = getLogContext();
    assert.equal(observed.loggedInUser.profile.roles.includes('admin'), false);
    assert.equal(observed.fields.tenant.id, 'tenant-original');
    assert.deepEqual(observed.fields.tenant.regions, ['west']);
    assert.equal(observed.fields.request.attempt, 1);
    assert.equal(observed.baggage.routing.shard, 'a');
    assert.equal(observed.context[0].transaction.id, 'txn-original');
    assert.equal(observed.meta[0].policy.id, 'policy-original');
    await logger.info('nested snapshot').send();
  });

  const tasks = Array.from({ length: 256 }, (_, index) => {
    const tenant = `tenant-${index}`;
    const user = `user-${index}`;
    const trace = `trace-${index}`;
    const request = `request-${index}`;
    const initial = {
      loggedInUser: { id: user, claims: { tenant, scopes: [`scope-${index}`] } },
      traceId: trace,
      fields: { tenant: { id: tenant }, request: { id: request } },
      baggage: { route: { tenant } },
    };
    return runWithLogContext(initial, async () => {
      await new Promise(resolve => setTimeout(resolve, index % 7));
      initial.loggedInUser.claims.tenant = 'attacker';
      initial.fields.tenant.id = 'attacker';
      initial.fields.request.id = 'attacker';
      updateLogContext({ fields: { stage: { number: index } } });
      await Promise.resolve();
      await logger.info(`request ${index}`).send();
    });
  });
  await Promise.all(tasks);

  for (let index = 0; index < 256; index += 1) {
    const record = records.find(item => item.message === `request ${index}`);
    assert.ok(record, `missing record for request ${index}`);
    assert.equal(record.traceId, `trace-${index}`);
    assert.equal(record.loggedInUser.id, `user-${index}`);
    assert.equal(record.loggedInUser.claims.tenant, `tenant-${index}`);
    assert.equal(record.fields.tenant.id, `tenant-${index}`);
    assert.equal(record.fields.request.id, `request-${index}`);
    assert.equal(record.fields.stage.number, index);
  }

  await assert.rejects(
    runWithLogContext(
      { traceId: 'failure-trace', fields: { tenant: { id: 'failure-tenant' } } },
      async () => {
        await Promise.resolve();
        throw new Error('expected cancellation-like failure');
      },
    ),
    /expected cancellation-like failure/,
  );
  assert.equal(getLogContext(), undefined, 'failed async frame leaked into the caller');

  await runWithLogContext({ traceId: 'post-failure' }, async () => {
    assert.equal(getLogContext().traceId, 'post-failure');
  });
  assert.equal(getLogContext(), undefined, 'post-failure frame was not restored');

  process.stdout.write(JSON.stringify({
    schema: 'ores-otel-test/async-context-security-receipt/v1',
    runtime: process.release.name,
    concurrentRequests: 256,
    records: records.length,
    mutationAfterCapture: 'pass',
    crossTenantIsolation: 'pass',
    failureCleanup: 'pass',
  }) + '\n');
} finally {
  uninstall();
  await logger.close();
}
