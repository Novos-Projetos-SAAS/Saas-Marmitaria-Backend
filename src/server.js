import { initializeInfinitepayApplication, validateInfinitepayEnvironment } from './infinitepayApplication.js';

import chalk from 'chalk';
import logSymbols from 'log-symbols';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';


dotenv.config();
const financialEnvironment = validateInfinitepayEnvironment(process.env);
const { default: app } = await import('./app.js');
const { default: connection } = await import('./database/connection.js');

const PORT = process.env.PORT || 3333;

/**
 * Utilizamos exatamente a mesma variável usada pelo CORS da API REST.
 */
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
    : [];

const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

/**
 * ============================================================
 * CANAL PÚBLICO
 * ============================================================
 * Somente transmite informações públicas, como abertura e fechamento da loja.
 * Não fornece acesso aos eventos administrativos de pedidos.
 */
const publicIo = io.of('/publico');
global.publicIo = publicIo;

/**
 * ============================================================
 * EXTRAÇÃO DO COOKIE
 * ============================================================
 */
function buscarCookie(cookieHeader, nome) {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').map(item => item.trim());

    for (const cookie of cookies) {
        const [chave, ...valor] = cookie.split('=');
        if (chave === nome) return decodeURIComponent(valor.join('='));
    }

    return null;
}

/**
 * ============================================================
 * AUTENTICAÇÃO DO SOCKET ADMINISTRATIVO
 * ============================================================
 */
io.use(async (socket, next) => {
    try {
        const token = buscarCookie(socket.request.headers.cookie, 'token');

        if (!token) {
            return next(new Error('Não autenticado'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const usuario = await connection('usuarios')
            .where({ id: decoded.id, ativo: true })
            .whereNull('deletado_em')
            .first('id');

        if (!usuario) {
            return next(new Error('Usuário não autorizado'));
        }

        if (String(decoded.cargo).toLowerCase() !== 'admin') {
            const permissao = await connection('permissoes_usuarios as pu')
                .join('permissoes as p', 'p.id', '=', 'pu.permissao_id')
                .where('pu.usuario_id', decoded.id)
                .where('p.nome', 'pedidos.listar')
                .first('p.id');

            if (!permissao) {
                return next(new Error('Sem permissão para acompanhar pedidos'));
            }
        }

        socket.usuario = {
            id: decoded.id,
            nome: decoded.nome,
            cargo: decoded.cargo
        };

        next();
    } catch (error) {
        next(new Error('Sessão inválida'));
    }
});

global.io = io;

io.on('connection', socket => {
    socket.join('pedidos');

    console.log(`\n${logSymbols.success} ${chalk.cyan(`Socket administrativo conectado: ${socket.id}`)}`);

    socket.on('disconnect', () => {
        console.log(`\n${logSymbols.warning} ${chalk.yellow(`Socket desconectado: ${socket.id}`)}`);
    });
});

let financial, shutdown;
async function closeServer() {
    if (shutdown) return shutdown;
    shutdown = (async () => {
        const pending = financial?.stop();
        await new Promise(resolve => io.close(resolve));
        if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
        await pending;
        await connection.destroy();
    })();
    return shutdown;
}
try {
    financial = await initializeInfinitepayApplication({ app, db: connection });
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(PORT, financialEnvironment ? '127.0.0.1' : undefined, resolve);
    });
    financial.start();
    console.log(`\n${logSymbols.success} ${chalk.cyan(`API rodando na porta ${httpServer.address().port}`)}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        closeServer().catch(() => { process.exitCode = 1; });
    });
} catch {
    console.error('Inicialização indisponível; confira a configuração local sem registrar credenciais.');
    await closeServer(); process.exitCode = 1;
}
