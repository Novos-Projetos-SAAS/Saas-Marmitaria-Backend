import express from 'express';
import cookieParser from 'cookie-parser';

import { limitadorGeral } from './middlewares/rateLimiter.js';

import AlimentosRoutes from './routes/Alimentos.Routes.js'
import AuthRoutes from './routes/Autenticacao.Routes.js'
import CategoriasAlimentosRoutes from './routes/CategoriaAlimento.Routes.js'
import MetodosPagamentosRoutes from './routes/MetodosPagamentos.Routes.js'
import NiveisAcessoRoutes from './routes/NiveisAcesso.Routes.js'
import PedidosRoutes from './routes/Pedidos.Routes.js'
import PermissoesRoutes from './routes/Permissions.Routes.js'
import StatusLojaRoutes from './routes/StatusLoja.Routes.js'
import TamanhosMarmitasRoutes from './routes/TamanhosMarmitas.Routes.js'
import UsuariosRoutes from './routes/Users.Routes.js'
import RelatoriosRoutes from './routes/Relatorios.Routes.js'
import KeepAliveRoutes from './routes/KeepAlive.Routes.js'
import DadosEmpresaRoutes from './routes/DadosEmpresa.Routes.js'
import InfinitepayConfigRoutes from './routes/InfinitepayConfig.Routes.js';
import PagamentosRoutes from './routes/Pagamentos.Routes.js';
import CheckoutSessionRoutes from './routes/CheckoutSession.Routes.js';
import FinanceiroPedidosRoutes from './routes/FinanceiroPedidos.Routes.js';
import QzRoutes from './routes/Qz.Routes.js'
import DashboardRoutes from './routes/Dashboard.Routes.js'
import MarmitasEspeciaisRoutes from './routes/MarmitasEspeciais.Routes.js'

// Novos módulos de produtos.
import CategoriasProdutosRoutes from './routes/CategoriaProduto.Routes.js';
import ProdutosRoutes from './routes/Produtos.Routes.js';

import errorHandler from './middlewares/errorHandler.js';

import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';

import cors from 'cors';

import dotenv from 'dotenv';
import { validateProductionEnvironment,configureProductionProxy } from './config/infinitepayProduction.js';
dotenv.config();

const app = express();

/**
 * A aplicação em produção fica atrás do proxy reverso da hospedagem.
 * Isso permite que o Express identifique corretamente o IP original
 * utilizado pelo rate limiter.
 */
if(process.env.INFINITEPAY_MODE === 'production') {
    configureProductionProxy(app,validateProductionEnvironment(process.env));
} else if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin=>origin.trim()).filter(Boolean)
    : [];

// 2. Atualização Importante no CORS
app.use(cors({
    origin: function (origin, callback) {
        // Permite requests sem origin (Postman, Render healthcheck etc)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            const error = new Error("Origem não autorizada.");
            error.statusCode = 403;
            error.exposeMessage = true;
            callback(error);
        }
    },
    credentials: true,
    // ADICIONE ISSO: Permite que o Front envie o Token no header
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Infinitepay-CSRF'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

// The shared parser must not consume a control request before its tighter bound.
app.use('/pagamentos/controle-producao',express.json({limit:'8kb',strict:true}));
app.use(express.json());
app.use(cookieParser());

// app.use((req, res, next) => {
//     console.log('REQ GLOBAL:', req.method, req.url);
//     next();
// });

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
        withCredentials: true, // 👈 ESSENCIAL: Isso força o Swagger a enviar o cookie
    },
}));

app.use(limitadorGeral);
// Express restores baseUrl before the global error handler. Preserve only this
// server-owned static prefix, never originalUrl, query or path parameter values.
const mountRoutes = (prefix, routes) => app.use(prefix, (req, res, next) => {
    req.auditBase = prefix;
    next();
}, routes);
mountRoutes('/alimentos', AlimentosRoutes)
mountRoutes('/auth', AuthRoutes)
mountRoutes('/categorias-alimentos', CategoriasAlimentosRoutes)
mountRoutes('/metodos-pagamentos', MetodosPagamentosRoutes)
mountRoutes('/niveis-acesso', NiveisAcessoRoutes)
mountRoutes('/pedidos', PedidosRoutes)
mountRoutes('/permissoes', PermissoesRoutes)
mountRoutes('/status-loja', StatusLojaRoutes)
mountRoutes('/tamanhos-marmitas', TamanhosMarmitasRoutes)
mountRoutes('/marmitas-especiais', MarmitasEspeciaisRoutes)
mountRoutes('/usuarios', UsuariosRoutes)
mountRoutes('/relatorios', RelatoriosRoutes)
mountRoutes('/dashboard', DashboardRoutes)

// Novas APIs.
mountRoutes('/categorias-produtos', CategoriasProdutosRoutes);
mountRoutes('/produtos', ProdutosRoutes);
mountRoutes('/keep-alive', KeepAliveRoutes);
mountRoutes('/configuracoes/infinitepay', InfinitepayConfigRoutes);
mountRoutes('/pagamentos/sessao', CheckoutSessionRoutes);
mountRoutes('/pagamentos/admin', FinanceiroPedidosRoutes);
mountRoutes('/pagamentos', PagamentosRoutes);
mountRoutes('/configuracoes', DadosEmpresaRoutes);
mountRoutes('/qz', QzRoutes);

app.use(errorHandler)

export default app;
