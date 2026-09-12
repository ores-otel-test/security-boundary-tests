import assert from 'node:assert/strict';
import http from 'node:http';

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error('SOURCE_ROOT is required');
const contextModule = await import(`${sourceRoot}/dist/context.js`);
const baseModule = await import(`${sourceRoot}/dist/base-logger.js`);
const {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
} = contextModule;
const { createLogger } = baseModule;

const requestCount = 512;
const abortedCount = 32;
const records = [];
const cleanupReceipts = [];
let connectionCount = 0;
const logger = createLogger({
  appName: 'async-context-http-keepalive-canary',
  console: false,
  transports: { write: record => void records.push(record) },
});
const uninstall = installLogContextProvider();

const server = http.createServer((request, response) => {
  const index = Number(request.headers['x-index']);
  const carrier = JSON.parse(String(request.headers['x-context']));
  const operation = runWithLogContext(carrier, async () => {
    await new Promise(resolve => setTimeout(resolve, index % 9));
    const observed = getLogContext();
    assert.equal(observed.traceId, `http-trace-${index}`);
    assert.equal(observed.fields.tenant.id, `http-tenant-${index}`);
    assert.equal(observed.fields.request.id, `http-request-${index}`);
    await logger.info(`http ${index}`).send();
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ index, traceId: observed.traceId }));
    }
  });

  carrier.loggedInUser.claims.tenant = 'attacker';
  carrier.fields.tenant.id = 'attacker';
  carrier.fields.request.id = 'attacker';

  operation.catch(error => {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  }).finally(() => {
    cleanupReceipts.push({ index, context: getLogContext() });
  });
});
server.on('connection', () => { connectionCount += 1; });

function carrier(index) {
  return {
    loggedInUser: { id: `http-user-${index}`, claims: { tenant: `http-tenant-${index}` } },
    traceId: `http-trace-${index}`,
    fields: {
      tenant: { id: `http-tenant-${index}` },
      request: { id: `http-request-${index}` },
    },
    baggage: { routing: { tenant: `http-tenant-${index}` } },
  };
}

function ordinaryRequest(index, agent, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      agent,
      headers: {
        'x-index': String(index),
        'x-context': JSON.stringify(carrier(index)),
      },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200);
          assert.deepEqual(JSON.parse(body), { index, traceId: `http-trace-${index}` });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function abortedRequest(index, agent, port) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      agent,
      headers: {
        'x-index': String(index),
        'x-context': JSON.stringify(carrier(index)),
      },
    });
    req.on('error', () => resolve());
    req.end();
    setTimeout(() => {
      req.destroy(new Error('expected client abort'));
      resolve();
    }, 1);
  });
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 });

  await Promise.all(Array.from({ length: requestCount }, (_, index) => ordinaryRequest(index, agent, address.port)));
  await Promise.all(
    Array.from({ length: abortedCount }, (_, offset) => abortedRequest(requestCount + offset, agent, address.port)),
  );

  const expectedTotal = requestCount + abortedCount;
  for (let attempt = 0; attempt < 200 && cleanupReceipts.length < expectedTotal; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  agent.destroy();

  assert.equal(records.length, expectedTotal);
  assert.equal(cleanupReceipts.length, expectedTotal);
  assert.equal(cleanupReceipts.every(receipt => receipt.context === undefined), true, 'request callback leaked context');
  assert.equal(connectionCount < requestCount / 4, true, `keep-alive did not reuse sockets: ${connectionCount}`);
  for (let index = 0; index < expectedTotal; index += 1) {
    const record = records.find(value => value.message === `http ${index}`);
    assert.ok(record, `missing HTTP record ${index}`);
    assert.equal(record.traceId, `http-trace-${index}`);
    assert.equal(record.loggedInUser.claims.tenant, `http-tenant-${index}`);
    assert.equal(record.fields.tenant.id, `http-tenant-${index}`);
    assert.equal(record.fields.request.id, `http-request-${index}`);
  }
  assert.equal(getLogContext(), undefined);

  process.stdout.write(JSON.stringify({
    schema: 'ores-otel-test/http-context-receipt/v1',
    requests: requestCount,
    abortedRequests: abortedCount,
    tcpConnections: connectionCount,
    socketReuse: 'pass',
    mutationAfterAdmission: 'pass',
    abortCleanup: 'pass',
    crossTenantIsolation: 'pass',
  }) + '\n');
} finally {
  await new Promise(resolve => server.close(resolve));
  uninstall();
  await logger.close();
}
