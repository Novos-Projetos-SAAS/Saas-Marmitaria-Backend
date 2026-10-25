import { Router } from "express";

import { listarCatalogoRelatorios, gerarRelatorio } from "../controllers/Relatorios.Controller.js";
import { verifyToken } from "../middlewares/verifyToken.js";
import { checkPermission } from "../middlewares/checkPermission.js";
import { requireActiveFinancialUser } from '../middlewares/infinitepayAdminSecurity.js';

const router = Router();

router.use(verifyToken, requireActiveFinancialUser);

router.get('/', checkPermission('relatorios.visualizar'), listarCatalogoRelatorios);
router.post('/:id/gerar', checkPermission('relatorios.gerar'), gerarRelatorio);

export default router;
