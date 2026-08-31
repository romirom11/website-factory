/** Regression: a brief gosom API outage must not discard a completed scrape. */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.GOSOM_URL = 'http://127.0.0.1:59997';
process.env.GOSOM_REQUEST_TIMEOUT_SECONDS = '1';
process.env.GOSOM_JOB_TIMEOUT_SECONDS = '2';
process.env.GOSOM_POLL_INTERVAL_SECONDS = '0.01';

let polls = 0;
const server = http.createServer((_request, response) => {
  polls += 1;
  if (polls === 1) {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('temporarily unavailable');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ID: 'transient-job',
    Name: 'transient fixture',
    Date: new Date().toISOString(),
    Status: polls === 2 ? 'working' : 'ok',
    Data: {},
  }));
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(59997, '127.0.0.1', resolve);
});

try {
  const { waitForGosomJob } = await import('../src/workers/discovery.js');
  const job = await waitForGosomJob('transient-job');
  assert.equal(job.Status, 'ok');
  assert.equal(polls, 3);
  console.log('🏭 DISCOVERY RESILIENCE TEST PASSED (503 → working → ok)');
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const { pool } = await import('../src/db/client.js');
  await pool.end();
}
