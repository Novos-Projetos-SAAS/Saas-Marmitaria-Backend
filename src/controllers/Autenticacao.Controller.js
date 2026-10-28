import jwt from "jsonwebtoken";
import connection from "../database/connection.js";
import { comparePassword } from "../utils/passwordUtils.js";


// LOGIN
export const login = async (req, res, next) => {
    try {
        const { email, senha } = req.body;

        if (!email || !senha) {
            return res.status(400).json({
                status: 'fail',
                message: 'Email e Senha são obrigatórios'
            })
        }

        const query = await connection('usuarios')
            .join('niveis_acesso', 'usuarios.nivel_acesso_id', '=', 'niveis_acesso.id')
            .where('usuarios.email', email)
            // .andWhere("usuarios.deletado_em", null)
            .select([
                'usuarios.id AS usuario_id',
                'usuarios.nome',
                'usuarios.senha_hash',
                'usuarios.ativo',
                'niveis_acesso.nome AS cargo'
            ])
            .first()

        if (!query) {
            return res.status(401).json({
                status: 'fail',
                message: 'Email ou senha incorretos'
            })
        }

        if (query.ativo === false) {
            return res.status(403).json({
                status: 'fail',
                message: 'Sua conta está suspensa. Contate o Administrador'
            })
        }

        const senhaValida = await comparePassword(senha, query.senha_hash);

        if (!senhaValida) {
            return res.status(401).json({
                status: 'fail',
                message: 'E-mail ou senha inválidos.'
            });
        }

        const token = jwt.sign(
            {
                id: query.usuario_id,
                nome: query.nome,
                cargo: query.cargo
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        )

        const isProduction = process.env.NODE_ENV === 'production';

        res.cookie('token', token, {
            httpOnly: true,
            secure: isProduction,                 // HTTPS em produção
            sameSite: isProduction ? 'none' : 'lax', // necessário para frontend separado
            maxAge: 1000 * 60 * 60 * 8            // 8 horas
        });


        // Log de Login (Opcional, mas muito bom para o SaaS)
        await connection('logs').insert({
            tipo: 'ACAO',
            usuario_id: query.usuario_id,
            metodo: 'POST',
            endpoint: '/login',
            acao: 'USUARIOS.LOGIN',
            descricao: `O colaborador ${query.nome} realizou login no sistema.`,
            payload: JSON.stringify({ ip: req.ip }) // Guardar o IP é uma boa prática
        });

        return res.status(200).json({
            status: 'success',
            message: 'Login realizado com sucesso',
            data: {
                usuario: {
                    id: query.usuario_id,
                    nome: query.nome,
                    cargo: query.cargo
                }
            }
        })

    } catch (error) {
        next(error)
    }
}


export {logout} from '../utils/logoutResponse.js';
