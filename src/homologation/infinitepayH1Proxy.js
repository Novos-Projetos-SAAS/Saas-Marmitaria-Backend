import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const loopback = value => value === '127.0.0.1' || value === '::ffff:127.0.0.1';

export function createH1ProxyVerifier({ tunnelPid, executablePath, execute = run }) {
    if (process.platform !== 'win32' || !Number.isSafeInteger(tunnelPid) || tunnelPid < 1 || !executablePath) throw new Error('Proxy H1 indisponível.');
    const attestations = new WeakMap();
    let active = 0;
    return async socket => {
        if (!loopback(socket.remoteAddress) || socket.localPort !== 55441 || !Number.isInteger(socket.remotePort) || socket.remotePort < 1 || socket.remotePort > 65535) return false;
        if (attestations.has(socket)) return attestations.get(socket);
        if (active >= 2) throw Object.assign(new Error('Verificação do proxy H1 ocupada.'), { statusCode: 503 });
        active++;
        const proof = (async () => { try {
            // Loopback alone cannot distinguish cloudflared from a direct caller on this Windows host.
            const command = `$ErrorActionPreference='Stop'; try {
                $peer = Get-NetTCPConnection -State Established -LocalAddress 127.0.0.1 -LocalPort ([int]$env:H1_PEER_PORT) -RemoteAddress 127.0.0.1 -RemotePort 55441
                $proxy = Get-Process -Id ([int]$env:H1_TUNNEL_PID)
                if (@($peer).Count -eq 1 -and $peer.OwningProcess -eq [int]$env:H1_TUNNEL_PID -and
                    [IO.Path]::GetFullPath($proxy.Path) -eq $env:H1_PROXY_EXE) { 'verified' }
            } catch { exit 1 }`;
            const { stdout } = await execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 1024,
                    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
                        H1_PEER_PORT: String(socket.remotePort), H1_TUNNEL_PID: String(tunnelPid), H1_PROXY_EXE: resolve(executablePath) } });
            return stdout.trim() === 'verified';
        } catch { return false; } finally { active--; } })();
        // The owner of an established TCP socket cannot change between HTTP requests.
        attestations.set(socket, proof);
        return proof;
    };
}

export const trustH1Proxy = (ip, hop) => hop === 0 && loopback(ip);

export function h1ProxyHeaders({ publicHost, verifyProxy }) {
    return async (req, res, next) => {
        const forwarded = Object.keys(req.headers).some(name => /^(?:cf-|x-forwarded-|forwarded$)/i.test(name));
        const throughTunnel = req.get('host') === publicHost;
        let clientIp;
        if (throughTunnel) {
            clientIp = req.headers['cf-connecting-ip'];
            if (typeof clientIp !== 'string' || !isIP(clientIp) || !await verifyProxy(req.socket)) return res.status(403).end();
        } else if (forwarded) return res.status(403).end();
        for (const name of Object.keys(req.headers)) if (/^(?:x-forwarded-|forwarded$)/i.test(name)) delete req.headers[name];
        // Cloudflare overwrites CF-Connecting-IP; the incoming XFF chain is never used as identity.
        if (throughTunnel) req.headers['x-forwarded-for'] = clientIp;
        next();
    };
}
