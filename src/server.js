import { validateInfinitepayEnvironment } from './infinitepayApplication.js';
import {resolveFinancialEnvironment} from './config/resolveFinancialEnvironment.js';
import { initializeServerFinancial } from './infinitepayServerComposition.js';
import { productionSocketAllowed, configureProductionSocket } from './config/infinitepayProduction.js';

import chalk from 'chalk';
import logSymbols from 'log-symbols';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';


dotenv.config();
// Resolve optional Render/Neon conventions before validating payment production.
// Never derive or enable payment capabilities here.
Object.assign(process.env, resolveFinancialEnvironment(process.env));
const financialEnvironment = validateInfinitepayEnvironment(process.env);
const { default: app } = await import('./app.js');
const { default: connection } = await import('./database/connection.js');
const { buscarPedidoCompletoPorId } = await import('./utils/pedidosUtils.js');

const PORT = process.env.PORT || 3333;

/**
 * Utilizamos exatamente a mesma variável usada pelo CORS da API REST.
 */
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
    : [];

const httpServer = createServer(app);

const io = new Server(httpServer, {
    ...(financialEnvironment?.mode==='production'?{allowRequest:(req,done)=>done(null,productionSocketAllowed(req,financialEnvironment,allowedOrigins))}:{}),
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
if(financialEnvironment?.mode==='production')configureProductionSocket(io,financialEnvironment,allowedOrigins);
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

        const usuario = await connection('usuarios as u').join('niveis_acesso as n','n.id','u.nivel_acesso_id')
            .where({ 'u.id': decoded.id, 'u.ativo': true, 'n.ativo':true })
            .whereNull('u.deletado_em')
            .first('u.id','u.nome','n.nome as cargo');

        if (!usuario) {
            return next(new Error('Usuário não autorizado'));
        }

        if (String(usuario.cargo).toLowerCase() !== 'admin') {
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
            nome: usuario.nome,
            cargo: usuario.cargo
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
    financial = await initializeServerFinancial({ app, db: connection, io, loadOrder: buscarPedidoCompletoPorId });
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(PORT, financialEnvironment ? (financialEnvironment.bindHost || '127.0.0.1') : undefined, resolve);
    });
    await financial.start();
    console.log(`\n${logSymbols.success} ${chalk.cyan(`API rodando na porta ${httpServer.address().port}`)}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        closeServer().catch(() => { process.exitCode = 1; });
    });
} catch {
    console.error('Inicialização indisponível; confira a configuração local sem registrar credenciais.');
    await closeServer(); process.exitCode = 1;
}
