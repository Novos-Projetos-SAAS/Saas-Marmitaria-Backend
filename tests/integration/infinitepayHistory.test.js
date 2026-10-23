import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrateBaseline } from '../helpers/testDatabase.js';

test('InfinitePay up preserves complete mixed historical orders, item money, snapshots and compositions', async () => {
    const fixture = await createTestDatabase();
    const db = fixture.db;
    try {
        await migrateBaseline(db);
        const created = '2025-04-12T13:20:00Z';
        const deleted = '2026-06-01T10:00:00Z';
        await db('metodos_pagamento').insert([
            { id: 91, nome: 'Dinheiro sintético', ativo: true, criado_em: created, atualizado_em: created },
            { id: 17, nome: 'Nome anterior sintético', ativo: true, criado_em: created, atualizado_em: created },
            { id: 308, nome: 'Método inativo sintético', ativo: false, criado_em: created, atualizado_em: created },
            { id: 54, nome: 'Método removido sintético', ativo: false, criado_em: created, atualizado_em: created, deletado_em: deleted },
        ]);
        // Renaming before migration represents an existing method with identity retained.
        await db('metodos_pagamento').where({ id: 17 }).update({ nome: 'Débito renomeado sintético' });
        const [size] = await db('tamanhos_marmitas').insert({ nome: 'Tamanho histórico sintético', preco_base: '99.99', ativo: false,
            criado_em: created, atualizado_em: created, deletado_em: deleted }).returning('*');
        const [foodCategory] = await db('categorias_alimentos').insert({ nome: 'Composição histórica sintética', limite_escolhas: 3,
            ativo: false, criado_em: created, atualizado_em: created }).returning('*');
        const foods = await db('alimentos').insert([
            { categoria_id: foodCategory.id, nome: 'Arroz sintético', descricao: 'Grãos históricos', disponivel_hoje: false,
                criado_em: created, atualizado_em: created },
            { categoria_id: foodCategory.id, nome: 'Feijão sintético', descricao: null, disponivel_hoje: true,
                criado_em: created, atualizado_em: created },
            { categoria_id: foodCategory.id, nome: 'Proteína removida sintética', descricao: 'Cadastro removido após venda',
                disponivel_hoje: false, criado_em: created, atualizado_em: created, deletado_em: deleted },
        ]).returning('*');
        const [productCategory] = await db('categorias_produtos').insert({ nome: 'Bebidas históricas sintéticas', descricao: 'Categoria antiga',
            ativo: false, ordem_exibicao: 7, criado_em: created, atualizado_em: created, deletado_em: deleted }).returning('*');
        const [product] = await db('produtos').insert({ categoria_produto_id: productCategory.id, nome: 'Bebida renomeada sintética',
            descricao: 'Descrição atual distinta do snapshot', preco: '8.90', ativo: false, disponivel_hoje: false,
            ordem_exibicao: 4, criado_em: created, atualizado_em: created, deletado_em: deleted }).returning('*');
        const [special] = await db('marmitas_especiais').insert({ nome: 'Especial atual sintético', descricao: 'Descrição atual',
            preco: '45.00', ativo: false, criado_em: created, atualizado_em: created, deletado_em: deleted }).returning('*');

        const orderCases = [
            { id: 801, method: 91, status: 'Pendente', type: 'Remoto', delivery: 'Entrega', change: true, removed: null },
            { id: 802, method: 17, status: 'Entregue', type: 'Presencial', delivery: 'Retirada', change: false, removed: null },
            { id: 803, method: 308, status: 'Em Preparo', type: 'Remoto', delivery: 'Retirada', change: false, removed: null },
            { id: 804, method: 54, status: 'Cancelado', type: 'Remoto', delivery: 'Entrega', change: false, removed: deleted },
        ];
        for (const entry of orderCases) {
            await db('pedidos').insert({ id: entry.id, nome_cliente: `Cliente sintético ${entry.id}`,
                telefone_cliente: '11999999999', endereco_cliente: entry.delivery === 'Entrega' ? 'Rua sintética 123' : null,
                tipo_pedido: entry.type, metodo_entrega: entry.delivery, metodo_pagamento_id: entry.method,
                status: entry.status, valor_total: '83.45', observacoes: `Observação histórica ${entry.id}`,
                criado_em: created, atualizado_em: created, deletado_em: entry.removed,
                precisa_troco: entry.change, troco_para: entry.change ? '100.00' : null });
            const items = await db('itens_pedido').insert([
                { pedido_id: entry.id, tamanho_marmita_id: size.id, quantidade: 2, preco_unitario: '22.35', subtotal: '44.70',
                    observacao: 'Sem cebola; duas unidades', nome_item_snapshot: 'Marmita histórica', descricao_item_snapshot: 'Composição escolhida' },
                { pedido_id: entry.id, produto_id: product.id, quantidade: 3, preco_unitario: '4.25', subtotal: '12.75',
                    observacao: 'Gelada', nome_item_snapshot: 'Bebida no momento da venda', descricao_item_snapshot: 'Descrição antiga da bebida' },
                { pedido_id: entry.id, marmita_especial_id: special.id, quantidade: 1, preco_unitario: '26.00', subtotal: '26.00',
                    observacao: null, nome_item_snapshot: 'Especial no momento da venda', descricao_item_snapshot: 'Receita histórica completa' },
            ]).returning('*');
            await db('composicao_item_pedido').insert(foods.map(food => ({ item_pedido_id: items[0].id, alimento_id: food.id })));
        }

        const unchangedTables = ['itens_pedido', 'composicao_item_pedido', 'alimentos', 'categorias_alimentos',
            'tamanhos_marmitas', 'produtos', 'categorias_produtos', 'marmitas_especiais'];
        const ordersBefore = await db('pedidos').select('*').orderBy('id');
        const methodsBefore = await db('metodos_pagamento').select('*').orderBy('id');
        const contentBefore = await Promise.all(unchangedTables.map(name => db(name).select('*').orderBy('id')));
        assert.equal(ordersBefore.length, 4);
        assert.equal(contentBefore[0].length, 12);
        assert.equal(contentBefore[1].length, 12);
        // Hand-checked fixture money is intentionally independent of current catalog prices.
        assert.deepEqual(contentBefore[0].slice(0, 3).map(item => [item.quantidade, item.preco_unitario, item.subtotal]),
            [[2, '22.35', '44.70'], [3, '4.25', '12.75'], [1, '26.00', '26.00']]);

        await db.migrate.latest();

        const ordersAfter = await db('pedidos').select('*').orderBy('id');
        assert.deepEqual(ordersAfter.map(row => Object.fromEntries(Object.keys(ordersBefore[0]).map(key => [key, row[key]]))), ordersBefore);
        for (const row of ordersAfter) {
            assert.equal(row.fluxo_pagamento, 'POSTERIOR');
            assert.equal(row.liberado_cozinha_em, null);
            assert.equal(row.client_request_id, null);
            assert.equal(row.client_payload_hash, null);
            assert.equal(row.valor_total, '83.45');
        }
        const methodsAfter = await db('metodos_pagamento').select('*').orderBy('id');
        assert.deepEqual(methodsAfter.map(row => Object.fromEntries(Object.keys(methodsBefore[0]).map(key => [key, row[key]]))), methodsBefore);
        for (const row of methodsAfter) {
            assert.equal(row.codigo, null, 'no classification inferred from ID or current method name');
            assert.equal(row.tipo_financeiro, 'OUTRO');
        }
        for (let i = 0; i < unchangedTables.length; i++) {
            assert.deepEqual(await db(unchangedTables[i]).select('*').orderBy('id'), contentBefore[i], unchangedTables[i]);
        }
        for (const table of ['pagamentos', 'pagamentos_eventos', 'pedido_acessos', 'outbox_eventos', 'infinitepay_credenciais']) {
            assert.deepEqual(await db(table).select('*'), [], `no synthetic historical backfill into ${table}`);
        }
        assert.equal((await db('config_infinitepay').where({ id: 1 }).first()).ativo, false);
    } finally { await fixture.close(); }
});
