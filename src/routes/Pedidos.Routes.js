import { Router } from "express";

import {
    alterarStatusPedido,
    criarPedido,
    deletarPedido,
    editarPedido,
    listarPedidosAdmin,
    listarPedidosPorTelefoneUsuario,
    restaurarPedido
} from "../controllers/Pedidos.Controller.js";
import { verifyToken } from "../middlewares/verifyToken.js";
import { checkPermission } from "../middlewares/checkPermission.js";

const router = Router();
const registrarOrigem = origem => (req, res, next) => {
    res.locals.origemPedido = origem;
    next();
};

/**
 * @swagger
 * /pedidos:
 *   post:
 *     summary: Cria um novo pedido
 *     description: Registra um novo pedido no sistema
 *     tags: [Pedidos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PedidoCreate'
 *           example:
 *             nome_cliente: "Maria Santos"
 *             telefone_cliente: "(11) 99999-9999"
 *             endereco_cliente: "Rua Example, 123"
 *             tipo_pedido: "Remoto"
 *             metodo_pagamento_id: 1
 *             valor_total: 50.00
 *             observacoes: "Sem cebola"
 *     responses:
 *       201:
 *         description: Pedido criado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               data:
 *                 id: 1
 *                 nome_cliente: "Maria Santos"
 *                 telefone_cliente: "(11) 99999-9999"
 *                 endereco_cliente: "Rua Example, 123"
 *                 tipo_pedido: "Remoto"
 *                 metodo_pagamento_id: 1
 *                 status: "Pendente"
 *                 valor_total: 50.00
 *                 observacoes: "Sem cebola"
 *       400:
 *         description: Dados inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Conflito - Dados incorretos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "fail"
 *               message: "Dados do pedido inválidos."
 */
router.post('/', registrarOrigem('PUBLICO'), criarPedido)

/**
 * @swagger
 * /pedidos/cliente/{telefone}:
 *   get:
 *     summary: Lista pedidos por telefone do cliente
 *     description: Retorna uma lista de pedidos associados ao telefone do cliente
 *     tags: [Pedidos]
 *     parameters:
 *       - in: path
 *         name: telefone
 *         required: true
 *         schema:
 *           type: string
 *         description: Número de telefone do cliente
 *     responses:
 *       200:
 *         description: Lista de pedidos retornada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "success"
 *                 results:
 *                   type: integer
 *                   example: 2
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Pedido'
 *       400:
 *         description: Telefone inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "error"
 *               message: "Por favor, informe um número de telefone válido com DDD."
 *       404:
 *         description: Nenhum pedido encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               status: "error"
 *               message: "Nenhum pedido encontrado para este telefone."
 */
router.get('/rastreio/:telefone', listarPedidosPorTelefoneUsuario)

router.use(verifyToken)

router.get(
    '/admin',
    checkPermission('pedidos.listar'),
    listarPedidosAdmin
);

router.patch(
    '/:id',
    checkPermission('pedidos.editar'),
    editarPedido
);

/**
 * Pedido criado pelo PDV administrativo.
 *
 * Utiliza o mesmo Controller, porém agora req.usuario
 * estará disponível para auditoria e permissões.
 */
router.post(
    '/admin',

    checkPermission(
        'pedidos.criar'
    ),
    registrarOrigem('ADMIN'),
    criarPedido
);

/**
 * @swagger
 * /pedidos/admin:
 *   get:
 *     summary: Lista todos os pedidos
 *     description: Retorna uma lista de todos os pedidos (requer autenticação e permissão)
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Lista de pedidos retornada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "success"
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Pedido'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/admin', checkPermission('pedidos.listar'), listarPedidosAdmin)

/**
 * @swagger
 * /pedidos/{id}:
 *   patch:
 *     summary: Atualiza um pedido
 *     description: Atualiza os dados de um pedido existente (requer autenticação e permissão)
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID do pedido
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PedidoUpdate'
 *           example:
 *             nome_cliente: "Maria Santos Atualizada"
 *             endereco_cliente: "Rua Nova, 456"
 *             telefone_cliente: "(11) 99999-9999"
 *             metodo_pagamento_id: 2
 *             observacoes: "Sem cebola, adicionar molho"
 *             marmitas: []
 *     responses:
 *       200:
 *         description: Pedido atualizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               message: "Pedido atualizado com sucesso."
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.patch('/:id', checkPermission('pedidos.editar'), editarPedido)

/**
 * @swagger
 * /pedidos/{id}/status:
 *   patch:
 *     summary: Altera o status de um pedido
 *     description: Atualiza o status de um pedido (requer autenticação e permissão)
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID do pedido
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: ["Pendente", "Em Preparo", "Pronto para Retirada", "Saiu para Entrega", "Entregue", "Cancelado"]
 *                 example: "Em Preparo"
 *             required:
 *               - status
 *     responses:
 *       200:
 *         description: Status atualizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               message: "Status atualizado para Em Preparo"
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.patch('/:id/status', checkPermission('pedidos.editar'), alterarStatusPedido)

/**
 * @swagger
 * /pedidos/{id}/restaurar:
 *   patch:
 *     summary: Restaura um pedido deletado
 *     description: Remove a marcação de exclusão de um pedido (requer autenticação e permissão)
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID do pedido
 *     responses:
 *       200:
 *         description: Pedido restaurado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               message: "Pedido restaurado com sucesso."
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.patch('/:id/restaurar', checkPermission('pedidos.editar'), restaurarPedido)

/**
 * @swagger
 * /pedidos/{id}:
 *   delete:
 *     summary: Deleta um pedido (soft delete)
 *     description: Realiza a exclusão lógica de um pedido (requer autenticação e permissão)
 *     tags: [Pedidos]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID do pedido
 *     responses:
 *       200:
 *         description: Pedido deletado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Success'
 *             example:
 *               status: "success"
 *               message: "Pedido cancelado com sucesso."
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete('/:id', checkPermission('pedidos.cancelar'), deletarPedido)

export default router;
