import { Router } from "express";

import { login, logout } from "../controllers/Autenticacao.Controller.js";
import { limitadorLogin } from "../middlewares/rateLimiter.js";

const router = Router();

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Autentica um usuário no sistema
 *     description: Realiza o login do usuário e retorna um token JWT em cookie HTTPOnly
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *           example:
 *             email: "joao@email.com"
 *             senha: "Senha@12345"
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *             example:
 *               status: "success"
 *               message: "Login realizado com sucesso"
 *               data:
 *                 usuario:
 *                   id: 1
 *                   nome: "João Silva"
 *                   cargo: "Administrador"
 *       400:
 *         description: Dados inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "fail"
 *               message: "Email e Senha são obrigatórios"
 *       401:
 *         description: Credenciais inválidas
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "fail"
 *               message: "Email ou senha incorretos"
 *       403:
 *         description: Usuário inativo/suspenso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "fail"
 *               message: "Sua conta está suspensa. Contate o Administrador"
 */
router.post('/login', limitadorLogin, login);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Encerra a sessão do usuário
 *     description: Realiza o logout limpando o cookie de token JWT
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Logout realizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               message: "Logout realizado com sucesso. Até logo!"
 *       401:
 *         description: Não autorizado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/logout', (req,res,next) => (req.app.locals.infinitepayLogout || logout)(req,res,next));

export default router;
