import { Router } from "express";

import {
    listarMarmitasEspeciais,
    listarMarmitasEspeciaisAdmin,
    buscarMarmitaEspecialPorId,
    criarMarmitaEspecial,
    editarMarmitaEspecial,
    alterarStatusMarmitaEspecial
} from "../controllers/MarmitasEspeciais.Controller.js";

import { verifyToken } from "../middlewares/verifyToken.js";
import { checkPermission } from "../middlewares/checkPermission.js";

const router = Router();

/**
 * ============================================================
 * ROTAS PÚBLICAS
 * ============================================================
 *
 * Retorna somente marmitas especiais ativas para exibição
 * na primeira tela do pedido.
 */
router.get('/', listarMarmitasEspeciais);

/**
 * ============================================================
 * ROTAS PRIVADAS
 * ============================================================
 */
router.use(verifyToken);

/**
 * Para a primeira versão reutilizamos a permissão já existente
 * de gerenciamento do cardápio.
 */
router.get('/admin', checkPermission('cardapio.gerenciar'), listarMarmitasEspeciaisAdmin);
router.post('/', checkPermission('cardapio.gerenciar'), criarMarmitaEspecial);
router.patch('/:id/status', checkPermission('cardapio.gerenciar'), alterarStatusMarmitaEspecial);
router.get('/:id', checkPermission('cardapio.gerenciar'), buscarMarmitaEspecialPorId);
router.patch('/:id', checkPermission('cardapio.gerenciar'), editarMarmitaEspecial);

export default router;
