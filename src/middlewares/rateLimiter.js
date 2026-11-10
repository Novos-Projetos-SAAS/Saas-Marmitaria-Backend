// import rateLimit from "express-rate-limit";

// // Limitador Geral para proteger a API por completa

// const isDev = process.env.NODE_ENV === 'development';

// export const limitadorGeral = rateLimit({

//     windowMs: 15 * 60 * 1000,
//     max: 200,

//     skip: (req) => {

//         if (isDev) return true;

//         return false;
//     }
// });
// // export const limitadorGeral = rateLimit({
// //     windowMs: 15 * 60 * 1000, // Janela de 15 minutos
// //     max: 200,
// //     message: {
// //         status: 'fail',
// //         message: 'Muitas requisições vindas deste IP. Tente novamente em 15 minutos.'
// //     },
// //     standardHeaders: true, // Informa no cabeçalho quanto tempo falta para resetar
// //     legacyHeaders: false
// // });


// // Limitador de Login para proteger contra força bruta
// export const limitadorLogin = rateLimit({
//     windowMs: 60 * 60 * 1000, // Janela de 1 hora
//     max: 10, // Apenas 10 tentativas de login por IP por hora
//     message: {
//         status: 'fail',
//         message: 'Muitas tentativas de login. Por segurança, tente novamente em 1 hora.'
//     },
//     standardHeaders: true, // Informa no cabeçalho quanto tempo falta para resetar
//     legacyHeaders: false
// })


// // Limitador de Cadastro: Evita que criem milhares de usuários fakes
// export const limitadorCadastro = rateLimit({
//     windowMs: 24 * 60 * 60 * 1000, // Janela de 24 horas
//     max: 5, // Apenas 5 contas criadas por IP por dia
//     message: {
//         status: 'fail',
//         message: 'Limite de criação de contas atingido para hoje.'
//     }
// });

import rateLimit from 'express-rate-limit';

const isDev = process.env.NODE_ENV === 'development';

/**
 * ============================================================
 * LIMITADOR GERAL
 * ============================================================
 *
 * Proteção geral contra abuso da API.
 *
 * O limite anterior de 200 requisições em 15 minutos era muito
 * baixo para uma SPA administrativa que utiliza várias APIs,
 * Socket.IO e atualizações automáticas.
 *
 * Login e cadastro continuam possuindo limites próprios e
 * muito mais restritivos abaixo.
 */
export const limitadorGeral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1500,
    message: {
        status: 'fail',
        message: 'Muitas requisições foram realizadas em pouco tempo. Aguarde alguns minutos e tente novamente.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        if (isDev) return true;

        // Requisições OPTIONS são apenas preflight do CORS.
        if (req.method === 'OPTIONS') return true;

        // Keep-alive não representa utilização real da aplicação.
        if (req.path === '/keep-alive' || req.path.startsWith('/keep-alive/')) return true;

        return false;
    }
});

/**
 * ============================================================
 * LIMITADOR DE LOGIN
 * ============================================================
 *
 * Mantemos um limite separado e mais agressivo para impedir
 * tentativas excessivas de autenticação.
 */
export const limitadorLogin = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: {
        status: 'fail',
        message: 'Muitas tentativas de login. Por segurança, tente novamente em 1 hora.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * ============================================================
 * LIMITADOR DE CADASTRO
 * ============================================================
 */
export const limitadorCadastro = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 5,
    message: {
        status: 'fail',
        message: 'Limite de criação de contas atingido para hoje.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

export const limitadorPagamentoPublico = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false,
    message: { status: 'fail', message: 'Aguarde um minuto antes de consultar novamente.' } });
