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
dotenv.config();

const app = express();

/**
 * A aplicação em produção fica atrás do proxy reverso da hospedagem.
 * Isso permite que o Express identifique corretamente o IP original
 * utilizado pelo rate limiter.
 */
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [];

// 2. Atualização Importante no CORS
app.use(cors({
    origin: function (origin, callback) {
        // Permite requests sem origin (Postman, Render healthcheck etc)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    // ADICIONE ISSO: Permite que o Front envie o Token no header
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

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
app.use('/alimentos', AlimentosRoutes)
app.use('/auth', AuthRoutes)
app.use('/categorias-alimentos', CategoriasAlimentosRoutes)
app.use('/metodos-pagamentos', MetodosPagamentosRoutes)
app.use('/niveis-acesso', NiveisAcessoRoutes)
app.use('/pedidos', PedidosRoutes)
app.use('/permissoes', PermissoesRoutes)
app.use('/status-loja', StatusLojaRoutes)
app.use('/tamanhos-marmitas', TamanhosMarmitasRoutes)
app.use('/marmitas-especiais', MarmitasEspeciaisRoutes)
app.use('/usuarios', UsuariosRoutes)
app.use('/relatorios', RelatoriosRoutes)
app.use('/dashboard', DashboardRoutes)

// Novas APIs.
app.use('/categorias-produtos', CategoriasProdutosRoutes);
app.use('/produtos', ProdutosRoutes);
app.use('/keep-alive', KeepAliveRoutes);
app.use('/configuracoes', DadosEmpresaRoutes);
app.use('/qz', QzRoutes);

app.use(errorHandler)

export default app;
