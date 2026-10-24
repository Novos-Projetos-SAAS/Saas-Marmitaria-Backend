import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createH1ProxyVerifier } from '../../src/homologation/infinitepayH1Proxy.js';

const settings = { tunnelPid: 1234, executablePath: 'C:/h1-private/cloudflared.exe' };
const socket = remotePort => ({ remoteAddress: '127.0.0.1', localPort: 55441, remotePort });

test('Windows peer attestation is shared per socket and bounds concurrent OS queries', { skip: process.platform !== 'win32' }, async () => {
    let calls = 0;
    const pending = [];
    const verify = createH1ProxyVerifier({ ...settings, execute: async (_file, _args, options) => {
        calls++;
        assert.equal(options.env.H1_TUNNEL_PID, '1234');
        assert.deepEqual(Object.keys(options.env).sort(), ['H1_PEER_PORT', 'H1_PROXY_EXE', 'H1_TUNNEL_PID', 'PATH', 'SystemRoot'].sort());
        assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000);
        return new Promise(resolve => pending.push(resolve));
    } });
    const a = socket(61001), b = socket(61002);
    const first = verify(a), repeated = verify(a), second = verify(b);
    assert.equal(calls, 2);
    await assert.rejects(verify(socket(61003)), error => error.statusCode === 503);
    pending.forEach(resolve => resolve({ stdout: 'verified\r\n' }));
    assert.deepEqual(await Promise.all([first, repeated, second]), [true, true, true]);
    assert.equal(await verify(a), true); assert.equal(calls, 2);
});

test('missing OS proof, malformed output, invalid peer and timeout fail closed', { skip: process.platform !== 'win32' }, async () => {
    for (const execute of [async () => ({ stdout: '' }), async () => ({ stdout: 'unexpected' }),
        async () => { throw new Error('SYNTHETIC_TIMEOUT'); }]) {
        const verify = createH1ProxyVerifier({ ...settings, execute });
        assert.equal(await verify(socket(61004)), false);
    }
    let calls = 0;
    const verify = createH1ProxyVerifier({ ...settings, execute: async () => { calls++; return { stdout: 'verified' }; } });
    for (const peer of [{ ...socket(61001), remoteAddress: '192.0.2.1' }, { ...socket(61001), localPort: 55440 },
        { ...socket(61001), remotePort: -1 }, { ...socket(61001), remotePort: 70000 }]) assert.equal(await verify(peer), false);
    assert.equal(calls, 0);
    for (const tunnelPid of [null, 0, -1, '1234']) assert.throws(() => createH1ProxyVerifier({ ...settings, tunnelPid }));
});

test('the Windows attestation predicate requires both the expected owner PID and executable path', { skip: process.platform !== 'win32' }, async () => {
    const run = promisify(execFile);
    for (const [owner, executable, multiple, expected] of [[1234, settings.executablePath, false, true],
        [4321, settings.executablePath, false, false], [1234, 'C:/untrusted/direct-client.exe', false, false],
        [1234, settings.executablePath, true, false]]) {
        const verify = createH1ProxyVerifier({ ...settings, execute: async (file, args, options) => {
            const mocks = `function Get-NetTCPConnection { param($State,$LocalAddress,$LocalPort,$RemoteAddress,$RemotePort)
                [pscustomobject]@{OwningProcess=[int]$env:H1_SYNTHETIC_OWNER}
                if ($env:H1_SYNTHETIC_MULTIPLE -eq 'true') { [pscustomobject]@{OwningProcess=[int]$env:H1_SYNTHETIC_OWNER} }
            }
            function Get-Process { param($Id) [pscustomobject]@{Path=$env:H1_SYNTHETIC_EXE} }
            `;
            return run(file, [...args.slice(0, -1), mocks + args.at(-1)], { ...options,
                env: { ...options.env, H1_SYNTHETIC_OWNER: String(owner), H1_SYNTHETIC_EXE: executable, H1_SYNTHETIC_MULTIPLE: String(multiple) } });
        } });
        assert.equal(await verify(socket(61005)), expected);
    }
});
