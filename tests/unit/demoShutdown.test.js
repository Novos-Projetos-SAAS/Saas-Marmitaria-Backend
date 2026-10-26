import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { Server } from 'socket.io';
import { closeDemo } from '../../scripts/demo/shutdown.js';

test('demo drains the worker and database even when a browser keeps an HTTP request open', { timeout: 3000 }, async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.write('pending'); });
    const io = new Server(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = get('http://127.0.0.1:' + server.address().port);
    call.on('error', () => {});
    await new Promise(resolve => call.once('response', resolve));
    const stages = [];
    try {
        await closeDemo({ server, io, financial: { async stop() { await new Promise(resolve => setTimeout(resolve, 30)); stages.push('drained'); } },
            db: { async destroy() { stages.push('database-closed'); } } });
        assert.deepEqual(stages, ['drained', 'database-closed']); assert.equal(server.listening, false);
    } finally { call.destroy(); server.closeAllConnections(); server.close(); }
});
