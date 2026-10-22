-- PROPOSTA: não executada em produção. Requer autorização antes de consultar dados reais.
-- Não selecionar credenciais nem dados pessoais de pedidos.
SELECT version();
SELECT name, batch, migration_time FROM knex_migrations ORDER BY id;
SELECT id, nome, ativo, deletado_em FROM metodos_pagamento ORDER BY id;
SELECT metodo_pagamento_id, COUNT(*) AS quantidade_pedidos
FROM pedidos GROUP BY metodo_pagamento_id ORDER BY metodo_pagamento_id;
